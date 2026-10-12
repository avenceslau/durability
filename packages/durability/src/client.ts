import { reportFailure, type SerializedError } from './errors.js';
import {
  parseServerFrame,
  socketProtocolErrorCode,
  socketProtocolVersion,
  type AnySocketShape,
  type InboundOf,
  type OutboundOf,
  type SocketClientFrame,
  type SocketInboundInput,
  type SocketInboundOutput,
  type SocketOutboundPayload,
  type SocketServerFrame,
} from './socket-protocol.js';
import { exponential, jitter } from './utils.js';

/** Rejection for calls still waiting when `close()` was called. */
export class SocketClosedError extends Error {
  constructor() {
    super('Socket connection was closed');
    this.name = 'SocketClosedError';
  }
}

/**
 * Rejection for calls that were sent but unanswered when the connection
 * dropped. They are never replayed: the server may or may not have run them.
 */
export class SocketConnectionLostError extends Error {
  constructor(method: string) {
    super(`Connection lost while "${method}" was in flight`);
    this.name = 'SocketConnectionLostError';
  }
}

/** Rejection for calls unanswered within the configured timeout. */
export class SocketTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`"${method}" timed out after ${timeoutMs}ms`);
    this.name = 'SocketTimeoutError';
  }
}

/** The server sent a frame this client cannot interpret; the connection is abandoned. */
export class SocketProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketProtocolError';
  }
}

/** A handler on the server threw; `name` and `message` are the server's. */
export class SocketRemoteError extends Error {
  constructor(error: SerializedError) {
    super(error.message);
    this.name = error.name;
  }
}

export type SocketStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'closed';

/** Wraps every `rpc` call; `next` forwards with the same or a replaced input. */
export type SocketTransform = (call: {
  method: string;
  input: unknown;
  next: (input?: unknown) => Promise<unknown>;
}) => Promise<unknown>;

export type DurabilitySocketClientConfig = {
  /** Builds the WebSocket URL for one Durable Object. */
  url: (id: string) => string;
  /** Rejects unanswered calls after this long. Defaults to 2 minutes. */
  timeoutMs?: number;
  /** Interval between keep-alive pings; a silent connection is dropped after two. Defaults to 30 seconds. */
  pingIntervalMs?: number;
  /** WebSocket implementation. Defaults to the global `WebSocket`. */
  webSocket?: new (url: string) => WebSocket;
};

type RpcMethod<Input, Output> = [Input] extends [void]
  ? () => Promise<Output>
  : unknown extends Input
    ? (input?: unknown) => Promise<Output>
    : (input: Input) => Promise<Output>;

type RpcMethods<Inbound> = {
  [Method in keyof Inbound]: RpcMethod<
    SocketInboundInput<Inbound[Method]>,
    SocketInboundOutput<Inbound[Method]>
  >;
};

type EventHandlers<Outbound> = {
  [Name in keyof Outbound]: (
    handler: (payload: SocketOutboundPayload<Outbound[Name]>) => void
  ) => () => void;
} & {
  /** Observes connection status; the handler runs immediately with the current value. */
  status: (handler: (status: SocketStatus) => void) => () => void;
  /** Fires when missed events could not be replayed and state must be rebuilt from a snapshot. */
  resync: (handler: () => void) => () => void;
};

/** One connection to one Durable Object. */
export type SocketConnection<Socket extends AnySocketShape> = {
  rpc: RpcMethods<InboundOf<Socket>>;
  on: EventHandlers<OutboundOf<Socket>>;
  readonly status: SocketStatus;
  /** Permanently closes the connection and rejects outstanding calls. */
  close(): void;
};

type PendingCall = {
  method: string;
  text: string;
  sent: boolean;
  resolve: (output: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pingText = JSON.stringify({ v: socketProtocolVersion, type: 'ping' });
const pongText = JSON.stringify({ v: socketProtocolVersion, type: 'pong' });

class Connection {
  readonly #config: Required<DurabilitySocketClientConfig>;
  readonly #url: string;
  readonly #transforms: readonly SocketTransform[];
  readonly #pending = new Map<string, PendingCall>();
  readonly #handlers = new Map<string, Set<(payload: unknown) => void>>();
  readonly #statusHandlers = new Set<(status: SocketStatus) => void>();
  readonly #resyncHandlers = new Set<() => void>();

  #status: SocketStatus = 'disconnected';
  #ws: WebSocket | undefined;
  #generation = 0;
  #nextId = 0;
  #lastSeq: number | undefined;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #lastReceivedAt = 0;

  constructor(
    config: Required<DurabilitySocketClientConfig>,
    id: string,
    transforms: readonly SocketTransform[]
  ) {
    this.#config = config;
    this.#url = config.url(id);
    this.#transforms = transforms;
  }

  get status(): SocketStatus {
    return this.#status;
  }

  call(method: string, input: unknown): Promise<unknown> {
    const run = (index: number, currentInput: unknown): Promise<unknown> => {
      const transform = this.#transforms[index];
      if (!transform) {
        return this.#send(method, currentInput);
      }
      return transform({
        method,
        input: currentInput,
        next: (nextInput = currentInput) => run(index + 1, nextInput),
      });
    };
    return run(0, input);
  }

  on(name: string, handler: (payload: unknown) => void): () => void {
    let handlers = this.#handlers.get(name);
    if (!handlers) {
      handlers = new Set();
      this.#handlers.set(name, handlers);
      this.#subscribe();
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0 && this.#handlers.get(name) === handlers) {
        this.#handlers.delete(name);
        this.#subscribe();
      }
    };
  }

  onStatus(handler: (status: SocketStatus) => void): () => void {
    this.#statusHandlers.add(handler);
    handler(this.#status);
    return () => {
      this.#statusHandlers.delete(handler);
    };
  }

  onResync(handler: () => void): () => void {
    this.#resyncHandlers.add(handler);
    return () => {
      this.#resyncHandlers.delete(handler);
    };
  }

  close(): void {
    if (this.#status === 'closed') {
      return;
    }
    this.#setStatus('closed');
    this.#stopTimers();
    this.#generation += 1;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SocketClosedError());
    }
    this.#pending.clear();
    this.#handlers.clear();
    this.#statusHandlers.clear();
    this.#resyncHandlers.clear();
    this.#ws?.close(1000, 'Client closed');
    this.#ws = undefined;
  }

  #send(method: string, input: unknown): Promise<unknown> {
    if (this.#status === 'closed') {
      return Promise.reject(new SocketClosedError());
    }
    const id = String(++this.#nextId);
    const frame: SocketClientFrame = {
      v: socketProtocolVersion,
      type: 'call',
      id,
      method,
      input,
    };
    return new Promise((resolve, reject) => {
      const pending: PendingCall = {
        method,
        text: JSON.stringify(frame),
        sent: false,
        resolve,
        reject,
        timer: setTimeout(
          () => {
            this.#pending.delete(id);
            reject(new SocketTimeoutError(method, this.#config.timeoutMs));
          },
          this.#config.timeoutMs
        ),
      };
      this.#pending.set(id, pending);
      this.#flush();
    });
  }

  #subscribe(): void {
    if (this.#status !== 'connected') {
      this.#connect();
      return;
    }
    const frame: SocketClientFrame = {
      v: socketProtocolVersion,
      type: 'subscribe',
      id: `subscribe:${++this.#nextId}`,
      names: [...this.#handlers.keys()],
      ...(this.#lastSeq === undefined ? {} : { since: this.#lastSeq }),
    };
    this.#ws?.send(JSON.stringify(frame));
  }

  /** Sends unsent calls; opens the connection first when needed. */
  #flush(): void {
    if (this.#status !== 'connected' || !this.#ws) {
      this.#connect();
      return;
    }
    for (const pending of this.#pending.values()) {
      if (pending.sent) {
        continue;
      }
      pending.sent = true;
      this.#ws.send(pending.text);
    }
  }

  /** Opens a socket unless one is open, opening, or already scheduled by backoff. */
  #connect(): void {
    if (this.#status !== 'disconnected' || this.#retryTimer !== undefined) {
      return;
    }

    this.#setStatus('connecting');
    const generation = ++this.#generation;
    const ws = new this.#config.webSocket(this.#url);
    this.#ws = ws;
    const current = () => generation === this.#generation;

    ws.addEventListener('open', () => {
      if (!current()) {
        return;
      }
      this.#attempt = 0;
      this.#lastReceivedAt = Date.now();
      this.#setStatus('connected');
      if (this.#handlers.size > 0) {
        this.#subscribe();
      }
      this.#flush();
      this.#startPing();
    });
    ws.addEventListener('message', (message) => {
      if (!current()) {
        return;
      }
      this.#receive(typeof message.data === 'string' ? message.data : '');
    });
    ws.addEventListener('close', (closed) => {
      if (!current()) {
        return;
      }
      this.#disconnected(closed.code);
    });
    ws.addEventListener('error', () => {
      if (current()) {
        ws.close();
      }
    });
  }

  #receive(text: string): void {
    this.#lastReceivedAt = Date.now();
    if (text === pongText) {
      return;
    }
    const frame = parseServerFrame(text);
    if (!frame) {
      this.#abandon(new SocketProtocolError('Received an invalid frame'));
      return;
    }
    switch (frame.type) {
      case 'event':
        this.#lastSeq = frame.seq;
        this.#dispatch(frame.name, frame.payload);
        return;
      case 'subscribed':
        this.#lastSeq = frame.seq;
        if (!frame.replayed) {
          for (const handler of this.#resyncHandlers) {
            this.#invoke(handler, undefined, 'resync');
          }
        }
        return;
      case 'result':
        this.#settle(frame, (pending) => pending.resolve(frame.output));
        return;
      case 'error':
        if (frame.id.startsWith('subscribe:')) {
          reportFailure('durability.socket.subscribe_failed', {}, frame.error);
          return;
        }
        this.#settle(frame, (pending) =>
          pending.reject(new SocketRemoteError(frame.error))
        );
        return;
    }
  }

  #settle(
    frame: Extract<SocketServerFrame, { id: string }>,
    settle: (pending: PendingCall) => void
  ): void {
    const pending = this.#pending.get(frame.id);
    if (!pending) {
      return;
    }
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    settle(pending);
  }

  #dispatch(name: string, payload: unknown): void {
    for (const handler of this.#handlers.get(name) ?? []) {
      this.#invoke(handler, payload, name);
    }
  }

  #invoke<Payload>(
    handler: (payload: Payload) => void,
    payload: Payload,
    name: string
  ): void {
    try {
      handler(payload);
    } catch (error) {
      reportFailure('durability.socket.handler_failed', { name }, error);
    }
  }

  #disconnected(code: number): void {
    this.#stopTimers();
    this.#ws = undefined;
    for (const [id, pending] of this.#pending) {
      if (!pending.sent) {
        continue;
      }
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new SocketConnectionLostError(pending.method));
    }
    if (code === socketProtocolErrorCode) {
      this.#abandon(new SocketProtocolError('Server rejected the protocol'));
      return;
    }
    this.#setStatus('disconnected');
    this.#attempt += 1;
    this.#retryTimer = setTimeout(
      () => {
        this.#retryTimer = undefined;
        this.#connect();
      },
      jitter(exponential(this.#attempt, 250, 60_000))
    );
  }

  /** Stops reconnecting after a protocol failure, which a retry cannot fix. */
  #abandon(error: SocketProtocolError): void {
    reportFailure('durability.socket.protocol_error', {}, error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.close();
  }

  #startPing(): void {
    const interval = this.#config.pingIntervalMs;
    this.#pingTimer = setInterval(() => {
      if (Date.now() - this.#lastReceivedAt > interval * 2) {
        this.#ws?.close(4000, 'Keep-alive timeout');
        return;
      }
      this.#ws?.send(pingText);
    }, interval);
  }

  #stopTimers(): void {
    if (this.#pingTimer !== undefined) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = undefined;
    }
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }

  #setStatus(status: SocketStatus): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    for (const handler of this.#statusHandlers) {
      this.#invoke(handler, status, 'status');
    }
  }
}

const defaultWebSocket = (): (new (url: string) => WebSocket) => {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      'No WebSocket implementation; pass `webSocket` in the client config'
    );
  }
  return WebSocket;
};

/**
 * Browser client for a {@link DurabilitySocket}. Connections open lazily,
 * reconnect with jittered backoff, and resubscribe from the last seen event.
 *
 * @example
 * ```ts
 * const client = new DurabilitySocketClient<TodoList['socket']>({
 *   url: (id) => `wss://example.com/todos/${id}`,
 * });
 * const conn = client.connect('personal');
 * const todos = await conn.rpc.list();
 * conn.on.created((todo) => render(todo));
 * conn.on.resync(() => reload());
 * ```
 */
export class DurabilitySocketClient<Socket extends AnySocketShape> {
  readonly #config: Required<DurabilitySocketClientConfig>;
  readonly #transforms: readonly SocketTransform[];

  constructor(
    config: DurabilitySocketClientConfig,
    transforms: readonly SocketTransform[] = []
  ) {
    this.#config = {
      url: config.url,
      timeoutMs: config.timeoutMs ?? 120_000,
      pingIntervalMs: config.pingIntervalMs ?? 30_000,
      webSocket: config.webSocket ?? defaultWebSocket(),
    };
    this.#transforms = transforms;
  }

  /** Returns a client that also applies `transform` around every call. */
  with(transform: SocketTransform): DurabilitySocketClient<Socket> {
    return new DurabilitySocketClient(this.#config, [
      ...this.#transforms,
      transform,
    ]);
  }

  connect(id: string): SocketConnection<Socket> {
    const connection = new Connection(this.#config, id, this.#transforms);
    const rpc = new Proxy({} as RpcMethods<InboundOf<Socket>>, {
      get: (_target, method) =>
        typeof method === 'string'
          ? (input?: unknown) => connection.call(method, input)
          : undefined,
    });
    const on = new Proxy({} as EventHandlers<OutboundOf<Socket>>, {
      get: (_target, name) => {
        if (name === 'status') {
          return (handler: (status: SocketStatus) => void) =>
            connection.onStatus(handler);
        }
        if (name === 'resync') {
          return (handler: () => void) => connection.onResync(handler);
        }
        return typeof name === 'string'
          ? (handler: (payload: unknown) => void) =>
              connection.on(name, handler)
          : undefined;
      },
    });
    return {
      rpc,
      on,
      get status() {
        return connection.status;
      },
      close: () => connection.close(),
    };
  }
}

/** Logs every call's input, output or error, and duration. */
export const logging =
  (
    log: (entry: Record<string, unknown>) => void = console.log
  ): SocketTransform =>
  async ({ method, input, next }) => {
    const startedAt = Date.now();
    try {
      const output = await next();
      log({ method, input, output, durationMs: Date.now() - startedAt });
      return output;
    } catch (error) {
      log({ method, input, error, durationMs: Date.now() - startedAt });
      throw error;
    }
  };

export {
  type AnySocketShape,
  type InboundOf,
  type OutboundOf,
  type SocketInboundInput,
  type SocketInboundOutput,
  type SocketOutboundPayload,
} from './socket-protocol.js';
