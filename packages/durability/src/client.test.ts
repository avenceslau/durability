import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import {
  DurabilitySocketClient,
  logging,
  SocketClosedError,
  SocketConnectionLostError,
  SocketProtocolError,
  SocketRemoteError,
  SocketTimeoutError,
  type SocketStatus,
} from './client';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { SocketShape, socketShape } from './socket-protocol';

type Todo = { id: string; title: string };

type TestSocket = {
  readonly [socketShape]: SocketShape<
    {
      list: () => Todo[];
      create: { input: StandardSchemaV1<Todo>; handle: (todo: Todo) => string };
      echo: (input: unknown) => unknown;
    },
    {
      created: { readonly payload?: Todo };
      removed: { readonly payload?: string };
    }
  >;
};

class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  static latest(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1]!;
  }

  readonly sent: string[] = [];
  readyState = 0;
  closed: { code: number; reason: string } | undefined;

  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(code = 1005, reason = ''): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.closed = { code, reason };
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  receive(frame: object): void {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ v: 1, ...frame }) })
    );
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((text) => JSON.parse(text));
  }
}

const createClient = (overrides: { timeoutMs?: number } = {}) =>
  new DurabilitySocketClient<TestSocket>({
    url: (id) => `wss://example.test/${id}`,
    webSocket: FakeSocket as unknown as new (url: string) => WebSocket,
    ...overrides,
  });

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DurabilitySocketClient', () => {
  it('types rpc and on from the socket shape', () => {
    const conn = createClient().connect('a');
    expectTypeOf(conn.rpc.list).toEqualTypeOf<() => Promise<Todo[]>>();
    expectTypeOf(conn.rpc.create).toEqualTypeOf<
      (input: Todo) => Promise<string>
    >();
    expectTypeOf(conn.rpc.echo).toEqualTypeOf<
      (input?: unknown) => Promise<unknown>
    >();
    expectTypeOf(conn.on.created)
      .parameter(0)
      .toEqualTypeOf<(payload: Todo) => void>();
    expectTypeOf(conn.on.status)
      .parameter(0)
      .toEqualTypeOf<(status: SocketStatus) => void>();
    // @ts-expect-error unknown methods are not callable
    expectTypeOf(conn.rpc.missing).toBeNever();
    conn.close();
  });

  it('connects lazily, queues calls until open, and sends each once', async () => {
    const conn = createClient().connect('a');
    expect(FakeSocket.instances).toHaveLength(0);
    expect(conn.status).toBe('disconnected');

    const listed = conn.rpc.list();
    const created = conn.rpc.create({ id: '1', title: 'x' });
    const ws = FakeSocket.latest();
    expect(ws.url).toBe('wss://example.test/a');
    expect(conn.status).toBe('connecting');
    expect(ws.sent).toEqual([]);

    ws.open();
    expect(conn.status).toBe('connected');
    expect(ws.frames()).toEqual([
      { v: 1, type: 'call', id: '1', method: 'list' },
      {
        v: 1,
        type: 'call',
        id: '2',
        method: 'create',
        input: { id: '1', title: 'x' },
      },
    ]);

    ws.receive({ type: 'result', id: '1', output: [] });
    ws.receive({
      type: 'error',
      id: '2',
      error: { name: 'RangeError', message: 'nope' },
    });
    await expect(listed).resolves.toEqual([]);
    const error = await created.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SocketRemoteError);
    expect(error).toMatchObject({ name: 'RangeError', message: 'nope' });
    expect(ws.sent).toHaveLength(2);
  });

  it('rejects in-flight calls on disconnect but resends queued ones after reconnect', async () => {
    const conn = createClient().connect('a');
    const inFlight = conn.rpc.list();
    const first = FakeSocket.latest();
    first.open();
    first.close(1006);

    await expect(inFlight).rejects.toBeInstanceOf(SocketConnectionLostError);
    expect(conn.status).toBe('disconnected');

    const queued = conn.rpc.echo('later');
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    const second = FakeSocket.latest();
    expect(second).not.toBe(first);
    second.open();
    expect(second.frames()).toEqual([
      { v: 1, type: 'call', id: '2', method: 'echo', input: 'later' },
    ]);
    second.receive({ type: 'result', id: '2', output: 'later' });
    await expect(queued).resolves.toBe('later');
  });

  it('backs off exponentially between reconnect attempts', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const conn = createClient().connect('a');
    conn.on.created(() => undefined);
    FakeSocket.latest().close(1006);

    await vi.advanceTimersByTimeAsync(249);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.latest().close(1006);
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('times out unanswered calls', async () => {
    const conn = createClient({ timeoutMs: 1_000 }).connect('a');
    const call = conn.rpc.list().catch((error: unknown) => error);
    FakeSocket.latest().open();

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(call).resolves.toBeInstanceOf(SocketTimeoutError);
  });

  it('subscribes when the first handler is added and tracks the last seq', () => {
    const conn = createClient().connect('a');
    const seen: Todo[] = [];
    const resyncs = vi.fn();
    conn.on.resync(resyncs);
    const stop = conn.on.created((todo) => seen.push(todo));
    const ws = FakeSocket.latest();
    ws.open();
    expect(ws.frames()).toEqual([
      { v: 1, type: 'subscribe', id: 'subscribe:1', names: ['created'] },
    ]);

    ws.receive({
      type: 'subscribed',
      id: 'subscribe:1',
      seq: 4,
      replayed: false,
    });
    expect(resyncs).toHaveBeenCalledWith({ names: ['created'] });
    ws.receive({
      type: 'event',
      seq: 5,
      name: 'created',
      payload: { id: '1', title: 'x' },
    });
    expect(seen).toEqual([{ id: '1', title: 'x' }]);

    // Adding a name on a live socket resyncs only that name.
    conn.on.removed(() => undefined);
    expect(ws.frames()[1]).toEqual({
      v: 1,
      type: 'subscribe',
      id: 'subscribe:2',
      names: ['created', 'removed'],
      since: 5,
    });
    ws.receive({
      type: 'subscribed',
      id: 'subscribe:2',
      seq: 5,
      replayed: true,
    });
    expect(resyncs).toHaveBeenLastCalledWith({ names: ['removed'] });
    expect(resyncs).toHaveBeenCalledTimes(2);

    stop();
    expect(ws.frames()[2]).toMatchObject({ names: ['removed'], since: 5 });
    ws.receive({
      type: 'subscribed',
      id: 'subscribe:3',
      seq: 5,
      replayed: true,
    });
    expect(resyncs).toHaveBeenCalledTimes(2);
    ws.receive({
      type: 'event',
      seq: 6,
      name: 'created',
      payload: { id: '2', title: 'y' },
    });
    expect(seen).toHaveLength(1);
  });

  it('resubscribes from the last seq after reconnecting and reports resync only on gaps', async () => {
    const conn = createClient().connect('a');
    const resyncs = vi.fn();
    conn.on.resync(resyncs);
    conn.on.created(() => undefined);
    const first = FakeSocket.latest();
    first.open();
    first.receive({
      type: 'subscribed',
      id: 'subscribe:1',
      seq: 2,
      replayed: false,
    });
    first.receive({
      type: 'event',
      seq: 3,
      name: 'created',
      payload: { id: '1', title: 'x' },
    });
    first.close(1006);

    await vi.advanceTimersByTimeAsync(400);
    const second = FakeSocket.latest();
    second.open();
    expect(second.frames()).toEqual([
      {
        v: 1,
        type: 'subscribe',
        id: 'subscribe:2',
        names: ['created'],
        since: 3,
      },
    ]);
    second.receive({
      type: 'subscribed',
      id: 'subscribe:2',
      seq: 7,
      replayed: true,
    });
    expect(resyncs).toHaveBeenCalledTimes(1);
  });

  it('reports status changes immediately and on every transition', async () => {
    const conn = createClient().connect('a');
    const statuses: SocketStatus[] = [];
    conn.on.status((status) => statuses.push(status));
    expect(statuses).toEqual(['disconnected']);

    void conn.rpc.list().catch(() => undefined);
    const ws = FakeSocket.latest();
    ws.open();
    ws.close(1006);
    await vi.advanceTimersByTimeAsync(0);
    conn.close();

    expect(statuses).toEqual([
      'disconnected',
      'connecting',
      'connected',
      'disconnected',
      'closed',
    ]);
  });

  it('close() rejects outstanding calls and stops reconnecting', async () => {
    const conn = createClient().connect('a');
    const call = conn.rpc.list();
    const ws = FakeSocket.latest();
    conn.close();

    await expect(call).rejects.toBeInstanceOf(SocketClosedError);
    expect(ws.closed).toEqual({ code: 1000, reason: 'Client closed' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
    await expect(conn.rpc.list()).rejects.toBeInstanceOf(SocketClosedError);
  });

  it('abandons the connection on protocol errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const conn = createClient().connect('a');
    const call = conn.rpc.list();
    const ws = FakeSocket.latest();
    ws.open();
    ws.dispatchEvent(new MessageEvent('message', { data: 'garbage' }));

    await expect(call).rejects.toBeInstanceOf(SocketProtocolError);
    expect(conn.status).toBe('closed');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('does not retry after the server closes with the protocol error code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const conn = createClient().connect('a');
    conn.on.created(() => undefined);
    FakeSocket.latest().close(4002, 'Invalid frame');

    expect(conn.status).toBe('closed');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('pings on an interval and drops silent connections', async () => {
    const conn = createClient().connect('a');
    conn.on.created(() => undefined);
    const ws = FakeSocket.latest();
    ws.open();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.sent[1]).toBe(JSON.stringify({ v: 1, type: 'ping' }));
    ws.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ v: 1, type: 'pong' }),
      })
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.closed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.closed).toEqual({ code: 4000, reason: 'Keep-alive timeout' });
    expect(conn.status).toBe('disconnected');
  });

  it('applies transforms in order and lets them replace the input', async () => {
    const order: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const conn = createClient()
      .with(async ({ input, next }) => {
        order.push('outer');
        return next(`${String(input)}!`);
      })
      .with(logging((entry) => logs.push(entry)))
      .with(async ({ next }) => {
        order.push('inner');
        const output = await next();
        return `${String(output)}?`;
      })
      .connect('a');

    const call = conn.rpc.echo('hi');
    const ws = FakeSocket.latest();
    ws.open();
    expect(ws.frames()).toEqual([
      { v: 1, type: 'call', id: '1', method: 'echo', input: 'hi!' },
    ]);
    ws.receive({ type: 'result', id: '1', output: 'hi!' });

    await expect(call).resolves.toBe('hi!?');
    expect(order).toEqual(['outer', 'inner']);
    expect(logs).toEqual([
      { method: 'echo', input: 'hi!', output: 'hi!?', durationMs: 0 },
    ]);
  });

  it('isolates handler failures', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const conn = createClient().connect('a');
    const seen = vi.fn();
    conn.on.created(() => {
      throw new Error('boom');
    });
    conn.on.created(seen);
    const ws = FakeSocket.latest();
    ws.open();
    ws.receive({
      type: 'event',
      seq: 1,
      name: 'created',
      payload: { id: '1', title: 'x' },
    });

    expect(seen).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'durability.socket.handler_failed',
        name: 'created',
      })
    );
  });
});
