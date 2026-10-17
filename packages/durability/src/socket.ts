import type { StandardSchemaV1 } from '@standard-schema/spec';
import { reportFailure, serializeError } from './errors.js';
import {
  durabilitySocketMigrations,
  migrate,
  type DurabilityMigrationResult,
} from './migrations.js';
import { deserialize, serialize } from './serialization.js';
import {
  parseClientFrame,
  socketMaxFrameLength,
  socketProtocolErrorCode,
  socketProtocolVersion,
  type SocketCall,
  type SocketClientFrame,
  type SocketInboundHandler,
  type SocketInboundMap,
  type SocketOutboundMap,
  type SocketOutboundPayload,
  type SocketServerFrame,
  type SocketInboundMetadata,
  type SocketShape,
  socketShape,
} from './socket-protocol.js';

/** The Durable Object state a socket needs: SQLite storage and hibernatable WebSockets. */
export type DurabilitySocketContext = Pick<
  DurableObjectState,
  'storage' | 'acceptWebSocket' | 'getWebSockets' | 'setWebSocketAutoResponse'
>;

export type DurabilitySocketConfig<
  Inbound extends SocketInboundMap,
  Outbound extends SocketOutboundMap,
  Metadata extends SocketInboundMetadata<Inbound>,
> = {
  context: DurabilitySocketContext;
  /** Methods clients may call, keyed by the names they become on the client. */
  inbound: Inbound;
  /** Events the object may push, keyed by the methods they become on this instance. */
  outbound: Outbound;
  /**
   * Captures trusted per-connection data from the upgrade request. Stored in
   * the WebSocket attachment, so it survives hibernation without re-auth.
   */
  metadata?: (request: Request) => Metadata | Promise<Metadata>;
  /** Outbound events kept for replay to reconnecting clients. Defaults to 1000. */
  retention?: number;
};

/** Thrown to the caller when an inbound payload fails its schema. */
export class SocketInputError extends Error {
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(method: string, issues: readonly StandardSchemaV1.Issue[]) {
    super(
      `Invalid input for "${method}": ${issues.map((issue) => issue.message).join('; ')}`
    );
    this.name = 'SocketInputError';
    this.issues = issues;
  }
}

type Attachment<Metadata> = {
  metadata: Metadata;
  names: string[];
};

type EventRow = {
  seq: number;
  name: string;
  payload: string;
};

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket };
};

declare const WebSocketRequestResponsePair: {
  new (request: string, response: string): WebSocketRequestResponsePair;
};

const reservedOutboundNames = new Set(['status', 'resync']);

const sendFrame = (ws: WebSocket, frame: SocketServerFrame): void => {
  let text = JSON.stringify(frame);
  if (text.length > socketMaxFrameLength) {
    if (frame.type === 'event') {
      reportFailure(
        'durability.socket.event_too_large',
        { name: frame.name, seq: frame.seq },
        new Error('Outbound event exceeds the frame limit')
      );
      return;
    }
    text = JSON.stringify({
      v: socketProtocolVersion,
      type: 'error',
      id: frame.id,
      error: {
        name: 'SocketFrameTooLargeError',
        message: `Response to "${frame.type}" exceeds ${socketMaxFrameLength} characters`,
      },
    } satisfies SocketServerFrame);
  }
  try {
    ws.send(text);
  } catch (error) {
    reportFailure('durability.socket.send_failed', { type: frame.type }, error);
  }
};

const readAttachment = <Metadata>(ws: WebSocket): Attachment<Metadata> => {
  const stored: unknown = ws.deserializeAttachment();
  if (typeof stored !== 'object' || stored === null) {
    return { metadata: undefined as Metadata, names: [] };
  }
  const names = Reflect.get(stored, 'names');
  return {
    metadata: Reflect.get(stored, 'metadata') as Metadata,
    names: Array.isArray(names)
      ? names.filter((name): name is string => typeof name === 'string')
      : [],
  };
};

class DurabilitySocketCore<
  Inbound extends SocketInboundMap,
  Outbound extends SocketOutboundMap,
  Metadata extends SocketInboundMetadata<Inbound>,
> {
  declare readonly [socketShape]: SocketShape<Inbound, Outbound>;

  readonly #context: DurabilitySocketContext;
  readonly #inbound: Map<string, SocketInboundHandler<never>>;
  readonly #outboundNames: Set<string>;
  readonly #metadata: DurabilitySocketConfig<
    Inbound,
    Outbound,
    Metadata
  >['metadata'];
  readonly #retention: number;

  constructor(config: DurabilitySocketConfig<Inbound, Outbound, Metadata>) {
    const retention = config.retention ?? 1_000;
    if (!Number.isSafeInteger(retention) || retention <= 0) {
      throw new RangeError('retention must be a positive safe integer');
    }

    this.#context = config.context;
    // Only own keys are callable; nothing on the prototype chain is reachable.
    this.#inbound = new Map(Object.entries(config.inbound));
    this.#metadata = config.metadata;
    this.#retention = retention;
    this.#outboundNames = new Set(Object.keys(config.outbound));

    const reserved = new Set([
      ...Object.getOwnPropertyNames(DurabilitySocketCore.prototype),
      ...reservedOutboundNames,
    ]);
    for (const name of this.#outboundNames) {
      if (reserved.has(name)) {
        throw new Error(`"${name}" is reserved by DurabilitySocket`);
      }
      Object.defineProperty(this, name, {
        value: (payload: unknown) => this.#publish(name, payload),
        enumerable: true,
      });
    }

    migrate(
      this.#context.storage,
      'socket',
      durabilitySocketMigrations,
      undefined
    );
    // Keep-alive pings are answered by the runtime without waking a hibernated object.
    this.#context.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ v: socketProtocolVersion, type: 'ping' }),
        JSON.stringify({ v: socketProtocolVersion, type: 'pong' })
      )
    );
  }

  /** Applies or reverts the `durability_socket_events` schema. */
  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ): DurabilityMigrationResult {
    return migrate(
      context.storage,
      'socket',
      durabilitySocketMigrations,
      target
    );
  }

  /** Accepts a WebSocket upgrade; call from the Durable Object's `fetch`. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const metadata = await this.#metadata?.(request);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.#context.acceptWebSocket(server);
    server.serializeAttachment({
      metadata,
      names: [],
    } satisfies Attachment<Metadata | undefined>);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Handles one inbound frame; call from the Durable Object's `webSocketMessage`. */
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    const text =
      typeof message === 'string' ? message : new TextDecoder().decode(message);
    const frame = parseClientFrame(text);
    if (!frame) {
      ws.close(socketProtocolErrorCode, 'Invalid frame');
      return;
    }
    if (frame.type === 'subscribe') {
      this.#subscribe(ws, frame);
      return;
    }
    await this.#call(ws, frame);
  }

  /**
   * Call from the Durable Object's `webSocketClose`. Subscriptions live in the
   * socket's attachment, so nothing needs cleaning up; the runtime requires
   * the method to exist for hibernatable WebSockets.
   */
  webSocketClose(_ws: WebSocket): void {}

  async #call(
    ws: WebSocket,
    frame: Extract<SocketClientFrame, { type: 'call' }>
  ): Promise<void> {
    const handler = this.#inbound.get(frame.method);
    if (!handler) {
      sendFrame(ws, {
        v: socketProtocolVersion,
        type: 'error',
        id: frame.id,
        error: {
          name: 'SocketUnknownMethodError',
          message: `Unknown method "${frame.method}"`,
        },
      });
      return;
    }

    const call: SocketCall<never> = {
      metadata: readAttachment<never>(ws).metadata,
    };
    try {
      const output =
        typeof handler === 'function'
          ? await handler(frame.input, call)
          : await handler.handle(
              (await this.#validate(
                frame.method,
                handler.input,
                frame.input
              )) as never,
              call
            );
      sendFrame(ws, {
        v: socketProtocolVersion,
        type: 'result',
        id: frame.id,
        output,
      });
    } catch (error) {
      sendFrame(ws, {
        v: socketProtocolVersion,
        type: 'error',
        id: frame.id,
        error: serializeError(error),
      });
    }
  }

  async #validate(
    method: string,
    schema: StandardSchemaV1,
    input: unknown
  ): Promise<unknown> {
    const result = await schema['~standard'].validate(input);
    if (result.issues) {
      throw new SocketInputError(method, result.issues);
    }
    return result.value;
  }

  #subscribe(
    ws: WebSocket,
    frame: Extract<SocketClientFrame, { type: 'subscribe' }>
  ): void {
    const unknown = frame.names.find((name) => !this.#outboundNames.has(name));
    if (unknown !== undefined) {
      sendFrame(ws, {
        v: socketProtocolVersion,
        type: 'error',
        id: frame.id,
        error: {
          name: 'SocketUnknownEventError',
          message: `Unknown event "${unknown}"`,
        },
      });
      return;
    }

    const attachment = readAttachment<Metadata>(ws);
    ws.serializeAttachment({
      ...attachment,
      names: frame.names,
    } satisfies Attachment<Metadata>);

    const head = this.#headSeq();
    const replayed = this.#replay(ws, frame.names, frame.since, head);
    sendFrame(ws, {
      v: socketProtocolVersion,
      type: 'subscribed',
      id: frame.id,
      seq: head,
      replayed,
    });
  }

  /**
   * Replays retained events after `since` and reports whether the client is
   * now caught up. A client ahead of the log or behind its oldest row must
   * rebuild its state from a fresh snapshot instead.
   */
  #replay(
    ws: WebSocket,
    names: string[],
    since: number | undefined,
    head: number
  ): boolean {
    if (since === undefined || since > head) {
      return false;
    }
    if (since === head) {
      return true;
    }
    const oldest = this.#context.storage.sql
      .exec<{ seq: number }>(
        'SELECT MIN(seq) AS seq FROM durability_socket_events'
      )
      .one().seq;
    if (since + 1 < oldest) {
      return false;
    }

    const rows = this.#context.storage.sql
      .exec<EventRow>(
        'SELECT seq, name, payload FROM durability_socket_events WHERE seq > ? ORDER BY seq',
        since
      )
      .toArray();
    const wanted = new Set(names);
    for (const row of rows) {
      if (!wanted.has(row.name)) {
        continue;
      }
      sendFrame(ws, {
        v: socketProtocolVersion,
        type: 'event',
        seq: row.seq,
        name: row.name,
        payload: deserialize(row.payload),
      });
    }
    return true;
  }

  #headSeq(): number {
    const row = this.#context.storage.sql
      .exec<{ seq: number | null }>(
        'SELECT MAX(seq) AS seq FROM durability_socket_events'
      )
      .one();
    return row.seq ?? 0;
  }

  #publish(name: string, payload: unknown): void {
    const serialized = serialize(payload);
    const sql = this.#context.storage.sql;
    const { seq } = sql
      .exec<{ seq: number }>(
        'INSERT INTO durability_socket_events (name, payload, created_at) VALUES (?, ?, ?) RETURNING seq',
        name,
        serialized,
        Date.now()
      )
      .one();
    sql.exec(
      'DELETE FROM durability_socket_events WHERE seq <= ?',
      seq - this.#retention
    );

    const frame: SocketServerFrame = {
      v: socketProtocolVersion,
      type: 'event',
      seq,
      name,
      payload,
    };
    for (const ws of this.#context.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (!readAttachment(ws).names.includes(name)) {
        continue;
      }
      sendFrame(ws, frame);
    }
  }
}

type OutboundMethods<Outbound extends SocketOutboundMap> = {
  [Name in keyof Outbound]: (
    payload: SocketOutboundPayload<Outbound[Name]>
  ) => void;
};

/**
 * Typed WebSocket RPC and event push for one Durable Object, over hibernatable
 * WebSockets.
 *
 * Every `outbound` event becomes a method on the instance that persists the
 * event for replay and pushes it to subscribed clients. Clients call `inbound`
 * handlers through `durability/client`.
 *
 * @example
 * ```ts
 * class TodoList extends DurableObject<Env> {
 *   readonly socket = new DurabilitySocket({
 *     context: this.ctx,
 *     inbound: {
 *       list: () => this.repo.list(),
 *       create: {
 *         input: TodoSchema,
 *         handle: async (todo: Todo) => {
 *           await this.repo.insert(todo);
 *           this.socket.created(todo);
 *         },
 *       },
 *     },
 *     outbound: { created: event<Todo>() },
 *   });
 *
 *   fetch(request: Request) {
 *     return this.socket.fetch(request);
 *   }
 *
 *   webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
 *     return this.socket.webSocketMessage(ws, message);
 *   }
 *
 *   webSocketClose(ws: WebSocket) {
 *     this.socket.webSocketClose(ws);
 *   }
 * }
 * ```
 */
export type DurabilitySocket<
  Inbound extends SocketInboundMap,
  Outbound extends SocketOutboundMap,
  Metadata extends SocketInboundMetadata<Inbound> =
    SocketInboundMetadata<Inbound>,
> = DurabilitySocketCore<Inbound, Outbound, Metadata> &
  OutboundMethods<Outbound>;

export interface DurabilitySocketConstructor {
  new <
    Inbound extends SocketInboundMap,
    Outbound extends SocketOutboundMap,
    Metadata extends SocketInboundMetadata<Inbound> =
      SocketInboundMetadata<Inbound>,
  >(
    config: DurabilitySocketConfig<Inbound, Outbound, Metadata>
  ): DurabilitySocket<Inbound, Outbound, Metadata>;
  migrate: typeof DurabilitySocketCore.migrate;
}

// TypeScript cannot declare class members derived from a generic event map,
// so the constructor is typed separately; the constructor installs and
// reserves every outbound method at runtime.
export const DurabilitySocket =
  DurabilitySocketCore as unknown as DurabilitySocketConstructor;

export { durabilitySocketMigrations } from './migrations.js';
export {
  event,
  type SocketCall,
  type SocketInboundHandler,
  type SocketInboundMap,
  type SocketOutboundEvent,
  type SocketOutboundMap,
} from './socket-protocol.js';
