import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import { DurabilitySocket, event, SocketInputError } from './socket';
import type {
  InboundOf,
  OutboundOf,
  SocketCall,
  SocketInboundInput,
  SocketInboundOutput,
} from './socket-protocol';
import { FakeStorage, FakeWebSocket, socketContextFor } from './test-fakes';

type Todo = { id: string; title: string };

const todoSchema = z.object({ id: z.string(), title: z.string() });

beforeEach(() => {
  vi.stubGlobal(
    'WebSocketRequestResponsePair',
    class {
      constructor(
        readonly request: string,
        readonly response: string
      ) {}
    }
  );
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0 = new FakeWebSocket();
      1 = new FakeWebSocket();
    }
  );
  // Node's Response rejects status 101; the Workers runtime accepts it with `webSocket`.
  vi.stubGlobal(
    'Response',
    class {
      readonly status: number;
      readonly webSocket: unknown;
      constructor(
        _body: unknown,
        init: { status: number; webSocket?: unknown }
      ) {
        this.status = init.status;
        this.webSocket = init.webSocket;
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const createSocket = (storage = new FakeStorage()) => {
  const context = socketContextFor(storage);
  const todos: Todo[] = [];
  const socket = new DurabilitySocket({
    context,
    inbound: {
      list: () => todos,
      echo: (input) => input,
      create: {
        input: todoSchema,
        handle: (todo: Todo, call: SocketCall<{ userId: string }>) => {
          todos.push(todo);
          socket.created({ ...todo, by: call.metadata.userId });
          return todo.id;
        },
      },
    },
    outbound: {
      created: event<Todo & { by: string }>(),
      removed: event<string>(),
    },
    metadata: (request) => ({ userId: request.headers.get('x-user')! }),
    retention: 3,
  });
  return { context, socket, todos };
};

const upgrade = (user = 'alice') =>
  new Request('https://do/ws', {
    headers: { Upgrade: 'websocket', 'x-user': user },
  });

const connect = async (
  socket: { fetch(request: Request): Promise<Response> },
  user?: string
) => {
  const response = await socket.fetch(upgrade(user));
  expect(response.status).toBe(101);
  return (response as Response & { webSocket: FakeWebSocket }).webSocket;
};

const serverSide = (context: ReturnType<typeof socketContextFor>) =>
  context.sockets[context.sockets.length - 1]!;

const frame = (value: object) => JSON.stringify({ v: 1, ...value });

describe('DurabilitySocket', () => {
  it('rejects reserved outbound names', () => {
    const context = socketContextFor(new FakeStorage());
    expect(
      () =>
        new DurabilitySocket({
          context,
          inbound: {},
          outbound: { status: event<string>() },
        })
    ).toThrow('"status" is reserved by DurabilitySocket');
    expect(
      () =>
        new DurabilitySocket({
          context,
          inbound: {},
          outbound: { fetch: event<string>() },
        })
    ).toThrow('"fetch" is reserved by DurabilitySocket');
  });

  it('exposes inbound and outbound types through the socket shape', () => {
    const { socket } = createSocket();
    type Socket = typeof socket;
    expectTypeOf<
      SocketInboundOutput<InboundOf<Socket>['list']>
    >().toEqualTypeOf<Todo[]>();
    expectTypeOf<
      SocketInboundInput<InboundOf<Socket>['list']>
    >().toEqualTypeOf<void>();
    expectTypeOf<
      SocketInboundInput<InboundOf<Socket>['create']>
    >().toEqualTypeOf<Todo>();
    expectTypeOf<
      SocketInboundInput<InboundOf<Socket>['echo']>
    >().toEqualTypeOf<unknown>();
    expectTypeOf<OutboundOf<Socket>['removed']>().toEqualTypeOf<{
      readonly payload?: string;
    }>();
    expectTypeOf(socket.created).toEqualTypeOf<
      (payload: Todo & { by: string }) => void
    >();
  });

  it('answers non-upgrade requests with 426', async () => {
    const { socket } = createSocket();
    const response = await socket.fetch(new Request('https://do/ws'));
    expect(response.status).toBe(426);
  });

  it('stores metadata in the attachment and passes it to handlers', async () => {
    const { context, socket } = createSocket();
    await connect(socket, 'bob');
    const ws = serverSide(context);
    expect(ws.deserializeAttachment()).toEqual({
      metadata: { userId: 'bob' },
      names: [],
    });

    await socket.webSocketMessage(
      ws as unknown as WebSocket,
      frame({ type: 'subscribe', id: 's1', names: ['created'] })
    );
    await socket.webSocketMessage(
      ws as unknown as WebSocket,
      frame({
        type: 'call',
        id: 'c1',
        method: 'create',
        input: { id: '1', title: 'x' },
      })
    );

    expect(ws.frames()).toEqual([
      { v: 1, type: 'subscribed', id: 's1', seq: 0, replayed: false },
      {
        v: 1,
        type: 'event',
        seq: 1,
        name: 'created',
        payload: { id: '1', title: 'x', by: 'bob' },
      },
      { v: 1, type: 'result', id: 'c1', output: '1' },
    ]);
  });

  it('only dispatches own inbound keys', async () => {
    const { context, socket } = createSocket();
    await connect(socket);
    const ws = serverSide(context);

    for (const method of ['constructor', 'toString', '__proto__', 'missing']) {
      await socket.webSocketMessage(
        ws as unknown as WebSocket,
        frame({ type: 'call', id: method, method })
      );
    }

    expect(ws.frames()).toEqual(
      ['constructor', 'toString', '__proto__', 'missing'].map((method) => ({
        v: 1,
        type: 'error',
        id: method,
        error: {
          name: 'SocketUnknownMethodError',
          message: `Unknown method "${method}"`,
        },
      }))
    );
  });

  it('validates input with the standard schema and reports issues', async () => {
    const { context, socket } = createSocket();
    await connect(socket);
    const ws = serverSide(context);

    await socket.webSocketMessage(
      ws as unknown as WebSocket,
      frame({ type: 'call', id: 'bad', method: 'create', input: { id: 1 } })
    );

    const [reply] = ws.frames() as [
      { error: { name: string; message: string } },
    ];
    expect(reply.error.name).toBe('SocketInputError');
    expect(reply.error.message).toMatch(/^Invalid input for "create": /);
    expect(new SocketInputError('x', [{ message: 'boom' }]).issues).toEqual([
      { message: 'boom' },
    ]);
  });

  it('passes raw input to bare handlers and omits undefined output', async () => {
    const { context, socket } = createSocket();
    await connect(socket);
    const ws = serverSide(context);

    await socket.webSocketMessage(
      ws as unknown as WebSocket,
      frame({ type: 'call', id: 'e1', method: 'echo', input: [1, 'two'] })
    );
    await socket.webSocketMessage(
      ws as unknown as WebSocket,
      frame({ type: 'call', id: 'e2', method: 'echo' })
    );

    expect(ws.frames()).toEqual([
      { v: 1, type: 'result', id: 'e1', output: [1, 'two'] },
      { v: 1, type: 'result', id: 'e2' },
    ]);
  });

  it('serializes handler errors by name and message', async () => {
    const context = socketContextFor(new FakeStorage());
    const socket = new DurabilitySocket({
      context,
      inbound: {
        fail: () => {
          throw new RangeError('out of range');
        },
      },
      outbound: {},
    });
    await connect(socket);
    const ws = serverSide(context);

    await socket.webSocketMessage(
      ws as unknown as WebSocket,
      frame({ type: 'call', id: 'f', method: 'fail' })
    );

    expect(ws.frames()).toEqual([
      {
        v: 1,
        type: 'error',
        id: 'f',
        error: { name: 'RangeError', message: 'out of range' },
      },
    ]);
  });

  it('closes the socket on malformed frames', async () => {
    const { context, socket } = createSocket();
    await connect(socket);
    const ws = serverSide(context);

    await socket.webSocketMessage(ws as unknown as WebSocket, 'not json');

    expect(ws.closed).toEqual({ code: 4002, reason: 'Invalid frame' });
    expect(ws.sent).toEqual([]);
  });

  it('broadcasts outbound events only to subscribers of that name', async () => {
    const { context, socket } = createSocket();
    await connect(socket, 'a');
    await connect(socket, 'b');
    await connect(socket, 'c');
    const [a, b, c] = context.sockets as [
      FakeWebSocket,
      FakeWebSocket,
      FakeWebSocket,
    ];
    await socket.webSocketMessage(
      a as unknown as WebSocket,
      frame({ type: 'subscribe', id: 's', names: ['removed'] })
    );
    await socket.webSocketMessage(
      b as unknown as WebSocket,
      frame({ type: 'subscribe', id: 's', names: ['created', 'removed'] })
    );
    c.readyState = 3;

    socket.removed('1');

    const removedEvent = {
      v: 1,
      type: 'event',
      seq: 1,
      name: 'removed',
      payload: '1',
    };
    expect(a.frames()[a.frames().length - 1]).toEqual(removedEvent);
    expect(b.frames()[b.frames().length - 1]).toEqual(removedEvent);
    expect(c.frames()).toEqual([]);
  });

  it('publishes payloads that carry undefined properties, as lifecycle events do', async () => {
    const { context, socket } = createSocket();
    await connect(socket);
    const ws = serverSide(context);
    await socket.webSocketMessage(
      ws as unknown as WebSocket,
      frame({ type: 'subscribe', id: 's', names: ['created'] })
    );

    // A completed operation whose handler returned nothing looks like this.
    socket.created({
      id: '1',
      title: 't',
      done: false,
      by: 'a',
      result: undefined,
    } as Todo & { by: string });

    expect(ws.frames()[ws.frames().length - 1]).toEqual({
      v: 1,
      type: 'event',
      seq: 1,
      name: 'created',
      payload: { id: '1', title: 't', done: false, by: 'a' },
    });
  });

  it('rejects subscriptions to unknown events', async () => {
    const { context, socket } = createSocket();
    await connect(socket);
    const ws = serverSide(context);

    await socket.webSocketMessage(
      ws as unknown as WebSocket,
      frame({ type: 'subscribe', id: 's', names: ['created', 'nope'] })
    );

    expect(ws.frames()).toEqual([
      {
        v: 1,
        type: 'error',
        id: 's',
        error: {
          name: 'SocketUnknownEventError',
          message: 'Unknown event "nope"',
        },
      },
    ]);
    expect((ws.deserializeAttachment() as { names: string[] }).names).toEqual(
      []
    );
  });

  it('replays retained events after `since` and prunes beyond retention', async () => {
    const storage = new FakeStorage();
    const { context, socket } = createSocket(storage);
    for (const id of ['1', '2', '3', '4', '5']) {
      socket.removed(id);
    }
    expect(
      storage.sql
        .exec<{ seq: number }>(
          'SELECT seq FROM durability_socket_events ORDER BY seq'
        )
        .toArray()
    ).toEqual([{ seq: 3 }, { seq: 4 }, { seq: 5 }]);

    await connect(socket);
    const ws = serverSide(context);
    await socket.webSocketMessage(
      ws as unknown as WebSocket,
      frame({ type: 'subscribe', id: 's', names: ['removed'], since: 2 })
    );

    expect(ws.frames()).toEqual([
      { v: 1, type: 'event', seq: 3, name: 'removed', payload: '3' },
      { v: 1, type: 'event', seq: 4, name: 'removed', payload: '4' },
      { v: 1, type: 'event', seq: 5, name: 'removed', payload: '5' },
      { v: 1, type: 'subscribed', id: 's', seq: 5, replayed: true },
    ]);
  });

  it('reports a snapshot is needed when `since` is missing, stale, or ahead', async () => {
    const { context, socket } = createSocket();
    for (const id of ['1', '2', '3', '4', '5']) {
      socket.removed(id);
    }
    await connect(socket);
    const ws = serverSide(context);

    for (const [id, since] of [
      ['none', undefined],
      ['stale', 1],
      ['ahead', 9],
      ['current', 5],
    ] as const) {
      await socket.webSocketMessage(
        ws as unknown as WebSocket,
        frame({ type: 'subscribe', id, names: ['removed'], since })
      );
    }

    expect(ws.frames()).toEqual([
      { v: 1, type: 'subscribed', id: 'none', seq: 5, replayed: false },
      { v: 1, type: 'subscribed', id: 'stale', seq: 5, replayed: false },
      { v: 1, type: 'subscribed', id: 'ahead', seq: 5, replayed: false },
      { v: 1, type: 'subscribed', id: 'current', seq: 5, replayed: true },
    ]);
  });

  it('rejects non-JSON outbound payloads before persisting them', () => {
    const context = socketContextFor(new FakeStorage());
    const socket = new DurabilitySocket({
      context,
      inbound: {},
      outbound: { tick: event<Date>() },
    });
    expect(() => socket.tick(new Date())).toThrow(/invalid_union/);
  });
});
