import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { SerializedError } from './errors.js';

export const socketProtocolVersion = 1;

/** Largest text frame either side accepts, in UTF-16 code units. */
export const socketMaxFrameLength = 1024 * 1024;

/** Close code sent when the peer violates the wire protocol; clients must not retry. */
export const socketProtocolErrorCode = 4002;

/** Frames a client sends. `input` is omitted when the method takes none. */
export type SocketClientFrame =
  | { v: 1; type: 'call'; id: string; method: string; input?: unknown }
  | { v: 1; type: 'subscribe'; id: string; names: string[]; since?: number };

/** Frames a server sends. `output` and `payload` are omitted when undefined. */
export type SocketServerFrame =
  | { v: 1; type: 'result'; id: string; output?: unknown }
  | { v: 1; type: 'error'; id: string; error: SerializedError }
  | { v: 1; type: 'subscribed'; id: string; seq: number; replayed: boolean }
  | { v: 1; type: 'event'; seq: number; name: string; payload?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isSerializedError = (value: unknown): value is SerializedError =>
  isRecord(value) &&
  typeof value['name'] === 'string' &&
  typeof value['message'] === 'string';

const parseFrame = (text: string): Record<string, unknown> | undefined => {
  if (text.length > socketMaxFrameLength) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed['v'] !== socketProtocolVersion) {
    return undefined;
  }
  return parsed;
};

export const parseClientFrame = (
  text: string
): SocketClientFrame | undefined => {
  const frame = parseFrame(text);
  if (!frame || typeof frame['id'] !== 'string') {
    return undefined;
  }
  if (frame['type'] === 'call' && typeof frame['method'] === 'string') {
    return frame as SocketClientFrame;
  }
  if (
    frame['type'] === 'subscribe' &&
    isStringArray(frame['names']) &&
    (frame['since'] === undefined || Number.isSafeInteger(frame['since']))
  ) {
    return frame as SocketClientFrame;
  }
  return undefined;
};

export const parseServerFrame = (
  text: string
): SocketServerFrame | undefined => {
  const frame = parseFrame(text);
  if (!frame) {
    return undefined;
  }
  if (frame['type'] === 'event') {
    return Number.isSafeInteger(frame['seq']) &&
      typeof frame['name'] === 'string'
      ? (frame as SocketServerFrame)
      : undefined;
  }
  if (typeof frame['id'] !== 'string') {
    return undefined;
  }
  if (frame['type'] === 'result') {
    return frame as SocketServerFrame;
  }
  if (frame['type'] === 'error' && isSerializedError(frame['error'])) {
    return frame as SocketServerFrame;
  }
  if (
    frame['type'] === 'subscribed' &&
    Number.isSafeInteger(frame['seq']) &&
    typeof frame['replayed'] === 'boolean'
  ) {
    return frame as SocketServerFrame;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Shape types shared by the server class and the browser client.
// ---------------------------------------------------------------------------

/** Per-call context passed to inbound handlers. */
export type SocketCall<Metadata> = {
  /** Trusted data captured from the upgrade request by `metadata`. */
  metadata: Metadata;
};

/**
 * An inbound handler: a bare function that takes no input (or `unknown`
 * input it validates itself), or a validated `{ input, handle }` pair.
 */
export type SocketInboundHandler<Metadata> =
  | ((input: unknown, call: SocketCall<Metadata>) => unknown)
  | {
      input: StandardSchemaV1;
      handle: (input: never, call: SocketCall<Metadata>) => unknown;
    };

export type SocketInboundMap<Metadata = never> = Record<
  string,
  SocketInboundHandler<Metadata>
>;

type HandlerMetadata<Handler> = Handler extends {
  handle: (input: never, call: SocketCall<infer Metadata>) => unknown;
}
  ? Metadata
  : Handler extends (input: never, call: SocketCall<infer Metadata>) => unknown
    ? Metadata
    : unknown;

type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

/** The metadata every inbound handler in the map can accept. */
export type SocketInboundMetadata<Inbound> = UnionToIntersection<
  { [Name in keyof Inbound]: HandlerMetadata<Inbound[Name]> }[keyof Inbound]
>;

/** Marks an outbound event and carries its payload type. */
export type SocketOutboundEvent<Payload> = {
  readonly payload?: Payload;
};

export type SocketOutboundMap = Record<string, SocketOutboundEvent<unknown>>;

/** Declares an outbound event with the given payload type. */
export const event = <Payload>(): SocketOutboundEvent<Payload> => ({});

export type SocketInboundInput<Handler> = Handler extends {
  input: infer Schema extends StandardSchemaV1;
}
  ? StandardSchemaV1.InferInput<Schema>
  : Handler extends (...args: infer Args) => unknown
    ? Args extends []
      ? void
      : Args[0]
    : never;

export type SocketInboundOutput<Handler> = Handler extends {
  handle: (...args: never[]) => infer Result;
}
  ? Awaited<Result>
  : Handler extends (...args: never[]) => infer Result
    ? Awaited<Result>
    : never;

export type SocketOutboundPayload<Event> =
  Event extends SocketOutboundEvent<infer Payload> ? Payload : never;

export const socketShape: unique symbol = Symbol('durability.socket');

/** Phantom type a server socket carries so clients can derive its surface. */
export type SocketShape<
  Inbound extends SocketInboundMap,
  Outbound extends SocketOutboundMap,
> = {
  inbound: Inbound;
  outbound: Outbound;
};

export type AnySocketShape = {
  readonly [socketShape]: SocketShape<SocketInboundMap, SocketOutboundMap>;
};

export type InboundOf<Socket extends AnySocketShape> =
  Socket[typeof socketShape]['inbound'];

export type OutboundOf<Socket extends AnySocketShape> =
  Socket[typeof socketShape]['outbound'];
