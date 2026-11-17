import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { SerializedError } from '../errors.js';
import { isJsonObject, isString } from '../predicates.js';
import type { Json, JsonObject } from '../serialization.js';

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

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isSerializedError = (value: Json | undefined): value is SerializedError =>
  isJsonObject(value) &&
  typeof value['name'] === 'string' &&
  typeof value['message'] === 'string';

const parseFrame = (text: string): JsonObject | undefined => {
  if (text.length > socketMaxFrameLength) {
    return undefined;
  }

  let parsed: Json;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!isJsonObject(parsed) || parsed['v'] !== socketProtocolVersion) {
    return undefined;
  }

  return parsed;
};

// `parseFrame` has already checked the protocol version.
const isClientFrame = (
  frame: JsonObject
): frame is JsonObject & SocketClientFrame => {
  if (typeof frame['id'] !== 'string') {
    return false;
  }

  if (frame['type'] === 'call') {
    return typeof frame['method'] === 'string';
  }

  return (
    frame['type'] === 'subscribe' &&
    isStringArray(frame['names']) &&
    (frame['since'] === undefined || Number.isSafeInteger(frame['since']))
  );
};

const isServerFrame = (
  frame: JsonObject
): frame is JsonObject & SocketServerFrame => {
  if (frame['type'] === 'event') {
    return (
      Number.isSafeInteger(frame['seq']) && typeof frame['name'] === 'string'
    );
  }

  if (typeof frame['id'] !== 'string') {
    return false;
  }

  if (frame['type'] === 'error') {
    return isSerializedError(frame['error']);
  }

  if (frame['type'] === 'subscribed') {
    return (
      Number.isSafeInteger(frame['seq']) &&
      typeof frame['replayed'] === 'boolean'
    );
  }

  return frame['type'] === 'result';
};

export const parseClientFrame = (
  text: string
): SocketClientFrame | undefined => {
  const frame = parseFrame(text);

  return frame && isClientFrame(frame) ? frame : undefined;
};

export const parseServerFrame = (
  text: string
): SocketServerFrame | undefined => {
  const frame = parseFrame(text);

  return frame && isServerFrame(frame) ? frame : undefined;
};

// ---------------------------------------------------------------------------
// Types shared by the server class and the browser client.
// ---------------------------------------------------------------------------

/** Per-call context passed to inbound handlers. */
export type SocketCall<Metadata> = {
  /** Trusted data captured from the upgrade request by `metadata`. */
  metadata: Metadata;
};

/**
 * An inbound handler: a Standard Schema that validates the call's input, and
 * `handle`, which receives the validated value.
 */
export type SocketInboundHandler<Metadata> = {
  input: StandardSchemaV1;
  handle: (input: never, call: SocketCall<Metadata>) => unknown;
};

export type SocketInboundMap<Metadata = never> = Record<
  string,
  SocketInboundHandler<Metadata>
>;

/** An unannotated `call` is `SocketCall<never>`, which constrains nothing. */
type HandlerMetadata<Handler> = Handler extends {
  handle: (input: never, call: SocketCall<infer Metadata>) => unknown;
}
  ? [Metadata] extends [never]
    ? unknown
    : Metadata
  : unknown;

type MetadataSinks<Inbound> = {
  [Name in keyof Inbound]: (metadata: HandlerMetadata<Inbound[Name]>) => void;
}[keyof Inbound];

/**
 * The metadata every inbound handler in the map can accept: the intersection
 * of each handler's metadata, keeping a union such as `User | undefined` whole.
 */
export type SocketInboundMetadata<Inbound> = [MetadataSinks<Inbound>] extends [
  (metadata: infer Metadata) => void,
]
  ? Metadata
  : unknown;

/** Marks an outbound event and carries its payload type. */
export type SocketOutboundEvent<Payload> = {
  readonly payload?: Payload;
};

export type SocketOutboundMap = Record<string, SocketOutboundEvent<unknown>>;

/** Declares an outbound event with the given payload type. */
export const event = <Payload>(): SocketOutboundEvent<Payload> => ({});

/** The schema of each inbound handler, by method. */
export type SocketInboundSchemas<Inbound extends SocketInboundMap> = {
  [Name in keyof Inbound]: Inbound[Name]['input'];
};

/**
 * Requires each handler to accept its schema's output. `Schemas` is inferred
 * from the schemas alone, so `handle` parameters need no annotation.
 */
export type SocketValidatedInbound<
  Inbound extends SocketInboundMap,
  Schemas extends Record<keyof Inbound, StandardSchemaV1>,
> = {
  [Name in keyof Schemas]: {
    input: Schemas[Name];
    handle: (
      input: StandardSchemaV1.InferOutput<Schemas[Name]>,
      call: SocketCall<never>
    ) => ReturnType<Inbound[Name & keyof Inbound]['handle']>;
  };
};

export type SocketInboundInput<Handler> = Handler extends {
  input: infer Schema extends StandardSchemaV1;
}
  ? StandardSchemaV1.InferInput<Schema>
  : never;

export type SocketInboundOutput<Handler> = Handler extends {
  handle: (...args: never[]) => infer Result;
}
  ? Awaited<Result>
  : never;

export type SocketOutboundPayload<Event> =
  Event extends SocketOutboundEvent<infer Payload> ? Payload : never;

export const socketMessageMaps: unique symbol = Symbol('durability.socket');

/** Phantom type a server socket carries so clients can derive its surface. */
export type SocketMessageMaps<
  Inbound extends SocketInboundMap,
  Outbound extends SocketOutboundMap,
> = {
  inbound: Inbound;
  outbound: Outbound;
};

export type AnyDurabilitySocket = {
  readonly [socketMessageMaps]: SocketMessageMaps<
    SocketInboundMap,
    SocketOutboundMap
  >;
};

export type InboundOf<Socket extends AnyDurabilitySocket> =
  Socket[typeof socketMessageMaps]['inbound'];

export type OutboundOf<Socket extends AnyDurabilitySocket> =
  Socket[typeof socketMessageMaps]['outbound'];
