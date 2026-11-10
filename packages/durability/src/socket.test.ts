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
import { serialize } from './serialization';
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
      channel: 'default',
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

type SocketContext = ReturnType<typeof socketContextFor>;

/**
 * The same object after hibernation or eviction: a new storage identity over
 * the same data, and the connections the runtime kept open.
 */
const restart = (context: SocketContext): SocketContext => ({
  ...context,
  storage: new Proxy(context.storage, {}),
});

/** Each channel's socket uses the same method and event names but its own handlers, metadata, and retention. */
const createChannelSocket = (
  context: SocketContext,
  channel: string | undefined,
  calls: string[] = [],
  retention = 3
) => {
  const label = channel ?? 'default';
  const socket = new DurabilitySocket({
    context,
    ...(channel === undefined ? {} : { channel }),
    inbound: {
      whoami: (_input: unknown, call: SocketCall<{ user: string }>) => {
        calls.push(label);
        return `${label}:${call.metadata.user}`;
      },
      publish: {
        input: z.string(),
        handle: (payload: string) => {
          calls.push(label);
          socket.changed(payload);
          return payload;
        },
      },
    },
    outbound: { changed: event<string>() },
    metadata: (request) => ({
      user: `${label}/${request.headers.get('x-user')}`,
    }),
    retention,
  });
  return socket;
};

const send = (
  socket: { webSocketMessage(ws: WebSocket, message: string): Promise<void> },
  ws: FakeWebSocket,
  value: object
) => socket.webSocketMessage(ws as unknown as WebSocket, frame(value));

const connectServer = async (
  socket: { fetch(request: Request): Promise<Response> },
  context: SocketContext,
  user?: string
) => {
  await connect(socket, user);
  return serverSide(context);
};

const storedEvents = (context: SocketContext) =>
  context.storage.sql
    .exec<{ channel: string; seq: number }>(
      'SELECT channel, seq FROM durability_socket_events ORDER BY channel, seq'
    )
    .toArray();

describe('DurabilitySocket channels', () => {
  it('routes each connection to its own channel, whichever socket receives the frame', async () => {
    const context = socketContextFor(new FakeStorage());
    const calls: string[] = [];
    const app = createChannelSocket(context, undefined, calls, 3);
    const library = createChannelSocket(context, 'library', calls, 2);
    const appWs = await connectServer(app, context, 'alice');
    const libraryWs = await connectServer(library, context, 'alice');

    expect(appWs.deserializeAttachment()).toEqual({
      metadata: { user: 'default/alice' },
      names: [],
      channel: 'default',
    });
    expect(libraryWs.deserializeAttachment()).toEqual({
      metadata: { user: 'library/alice' },
      names: [],
      channel: 'library',
    });

    for (const receiver of [app, library]) {
      await send(receiver, appWs, { type: 'call', id: 'w', method: 'whoami' });
      await send(receiver, libraryWs, {
        type: 'call',
        id: 'w',
        method: 'whoami',
      });
    }
    await send(library, appWs, {
      type: 'subscribe',
      id: 's',
      names: ['changed'],
    });
    await send(app, libraryWs, {
      type: 'subscribe',
      id: 's',
      names: ['changed'],
    });
    await send(app, libraryWs, {
      type: 'call',
      id: 'p',
      method: 'publish',
      input: 'from library',
    });

    expect(calls).toEqual([
      'default',
      'library',
      'default',
      'library',
      'library',
    ]);
    expect(appWs.frames()).toEqual([
      { v: 1, type: 'result', id: 'w', output: 'default:default/alice' },
      { v: 1, type: 'result', id: 'w', output: 'default:default/alice' },
      { v: 1, type: 'subscribed', id: 's', seq: 0, replayed: false },
    ]);
    expect(libraryWs.frames()).toEqual([
      { v: 1, type: 'result', id: 'w', output: 'library:library/alice' },
      { v: 1, type: 'result', id: 'w', output: 'library:library/alice' },
      { v: 1, type: 'subscribed', id: 's', seq: 0, replayed: false },
      {
        v: 1,
        type: 'event',
        seq: 1,
        name: 'changed',
        payload: 'from library',
      },
      { v: 1, type: 'result', id: 'p', output: 'from library' },
    ]);
    expect(libraryWs.deserializeAttachment()).toEqual({
      metadata: { user: 'library/alice' },
      names: ['changed'],
      channel: 'library',
    });

    app.changed('from app');
    expect(appWs.frames()[appWs.frames().length - 1]).toEqual({
      v: 1,
      type: 'event',
      seq: 1,
      name: 'changed',
      payload: 'from app',
    });
    expect(libraryWs.frames()).toHaveLength(5);
  });

  it('numbers, retains, and replays events per channel', async () => {
    const context = socketContextFor(new FakeStorage());
    const app = createChannelSocket(context, undefined, [], 3);
    const library = createChannelSocket(context, 'library', [], 2);

    for (const index of [1, 2, 3]) {
      app.changed(`a${index}`);
      library.changed(`l${index}`);
    }
    for (const index of [4, 5, 6, 7, 8]) {
      app.changed(`a${index}`);
    }

    expect(storedEvents(context)).toEqual([
      { channel: 'default', seq: 6 },
      { channel: 'default', seq: 7 },
      { channel: 'default', seq: 8 },
      { channel: 'library', seq: 2 },
      { channel: 'library', seq: 3 },
    ]);

    const libraryWs = await connectServer(library, context);
    await send(app, libraryWs, {
      type: 'subscribe',
      id: 's',
      names: ['changed'],
      since: 1,
    });
    expect(libraryWs.frames()).toEqual([
      { v: 1, type: 'event', seq: 2, name: 'changed', payload: 'l2' },
      { v: 1, type: 'event', seq: 3, name: 'changed', payload: 'l3' },
      { v: 1, type: 'subscribed', id: 's', seq: 3, replayed: true },
    ]);

    const appWs = await connectServer(app, context);
    await send(library, appWs, {
      type: 'subscribe',
      id: 's',
      names: ['changed'],
      since: 3,
    });
    expect(appWs.frames()).toEqual([
      { v: 1, type: 'subscribed', id: 's', seq: 8, replayed: false },
    ]);

    library.changed('l4');
    expect(libraryWs.frames()[libraryWs.frames().length - 1]).toEqual({
      v: 1,
      type: 'event',
      seq: 4,
      name: 'changed',
      payload: 'l4',
    });
    expect(
      storedEvents(context).filter((row) => row.channel === 'library')
    ).toEqual([
      { channel: 'library', seq: 3 },
      { channel: 'library', seq: 4 },
    ]);
  });

  it('treats connections accepted before channels as default and keeps their attachment', async () => {
    const context = socketContextFor(new FakeStorage());
    const calls: string[] = [];
    const app = createChannelSocket(context, undefined, calls);
    const library = createChannelSocket(context, 'library', calls);
    const legacy = new FakeWebSocket();
    legacy.serializeAttachment({ metadata: { user: 'old' }, names: [] });
    context.acceptWebSocket(legacy as unknown as WebSocket);

    await send(library, legacy, { type: 'call', id: 'w', method: 'whoami' });
    await send(library, legacy, {
      type: 'subscribe',
      id: 's',
      names: ['changed'],
    });
    library.changed('library event');
    app.changed('app event');

    expect(calls).toEqual(['default']);
    expect(legacy.frames()).toEqual([
      { v: 1, type: 'result', id: 'w', output: 'default:old' },
      { v: 1, type: 'subscribed', id: 's', seq: 0, replayed: false },
      { v: 1, type: 'event', seq: 1, name: 'changed', payload: 'app event' },
    ]);
    expect(legacy.deserializeAttachment()).toEqual({
      metadata: { user: 'old' },
      names: ['changed'],
      channel: 'default',
    });
  });

  it('restores routing when the object is constructed again', async () => {
    const first = socketContextFor(new FakeStorage());
    const firstCalls: string[] = [];
    const app = createChannelSocket(first, undefined, firstCalls);
    const library = createChannelSocket(first, 'library', firstCalls);
    const appWs = await connectServer(app, first);
    const libraryWs = await connectServer(library, first);
    for (const ws of [appWs, libraryWs]) {
      await send(app, ws, { type: 'subscribe', id: 's', names: ['changed'] });
    }
    library.changed('before');

    const second = restart(first);
    const secondCalls: string[] = [];
    const restartedLibrary = createChannelSocket(
      second,
      'library',
      secondCalls
    );
    const restartedApp = createChannelSocket(second, undefined, secondCalls);
    await send(restartedApp, libraryWs, {
      type: 'call',
      id: 'w',
      method: 'whoami',
    });
    await send(restartedLibrary, appWs, {
      type: 'call',
      id: 'w',
      method: 'whoami',
    });
    restartedLibrary.changed('after');

    expect(firstCalls).toEqual([]);
    expect(secondCalls).toEqual(['library', 'default']);
    expect(libraryWs.frames().slice(1)).toEqual([
      { v: 1, type: 'event', seq: 1, name: 'changed', payload: 'before' },
      { v: 1, type: 'result', id: 'w', output: 'library:library/alice' },
      { v: 1, type: 'event', seq: 2, name: 'changed', payload: 'after' },
    ]);
    expect(appWs.frames().slice(1)).toEqual([
      { v: 1, type: 'result', id: 'w', output: 'default:default/alice' },
    ]);
  });

  it('throws when a channel is attached twice or is empty', () => {
    const context = socketContextFor(new FakeStorage());
    createChannelSocket(context, undefined);
    createChannelSocket(context, 'library');

    expect(() => createChannelSocket(context, 'default')).toThrow(
      'DurabilitySocket for channel "default" is already attached to this scheduler'
    );
    expect(() => createChannelSocket(context, 'library')).toThrow(
      'DurabilitySocket for channel "library" is already attached to this scheduler'
    );
    expect(() => createChannelSocket(context, '')).toThrow(
      'DurabilitySocket channel must be a non-empty string'
    );
    expect(() =>
      createChannelSocket(restart(context), 'library')
    ).not.toThrow();
  });

  it('closes a connection whose channel is no longer attached without running another channel', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const first = socketContextFor(new FakeStorage());
    const library = createChannelSocket(first, 'library');
    createChannelSocket(first, undefined);
    const libraryWs = await connectServer(library, first);
    library.changed('kept');

    const second = restart(first);
    const calls: string[] = [];
    const app = createChannelSocket(second, undefined, calls);
    await send(app, libraryWs, { type: 'call', id: 'w', method: 'whoami' });

    expect(calls).toEqual([]);
    expect(libraryWs.sent).toEqual([]);
    expect(libraryWs.closed).toEqual({
      code: 1011,
      reason: 'Socket channel is not attached',
    });
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'durability.socket.channel_missing',
        channel: 'library',
      })
    );
    expect(storedEvents(second)).toEqual([{ channel: 'library', seq: 1 }]);

    const third = restart(second);
    const restoredLibrary = createChannelSocket(third, 'library');
    const reconnected = await connectServer(restoredLibrary, third);
    await send(restoredLibrary, reconnected, {
      type: 'subscribe',
      id: 's',
      names: ['changed'],
      since: 0,
    });
    expect(reconnected.frames()).toEqual([
      { v: 1, type: 'event', seq: 1, name: 'changed', payload: 'kept' },
      { v: 1, type: 'subscribed', id: 's', seq: 1, replayed: true },
    ]);
  });

  it('answers keep-alive pings the same way for every channel', () => {
    const context = socketContextFor(new FakeStorage());
    const autoResponse = vi.spyOn(context, 'setWebSocketAutoResponse');
    createChannelSocket(context, undefined);
    createChannelSocket(context, 'library');

    expect(autoResponse.mock.calls).toEqual([
      [{ request: '{"v":1,"type":"ping"}', response: '{"v":1,"type":"pong"}' }],
      [{ request: '{"v":1,"type":"ping"}', response: '{"v":1,"type":"pong"}' }],
    ]);
  });

  it('moves existing events to the default channel with their sequence numbers', async () => {
    const context = socketContextFor(new FakeStorage());
    expect(
      DurabilitySocket.migrate(context, 'durability_0006_create_socket_events')
    ).toEqual({
      applied: ['durability_0006_create_socket_events'],
      rolledBack: [],
    });
    for (const payload of ['one', 'two', 'three']) {
      context.storage.sql.exec(
        'INSERT INTO durability_socket_events (name, payload, created_at) VALUES (?, ?, ?)',
        'changed',
        serialize(payload),
        1
      );
    }
    context.storage.sql.exec(
      'DELETE FROM durability_socket_events WHERE seq = 1'
    );

    const app = createChannelSocket(context, undefined);
    app.changed('four');
    expect(storedEvents(context)).toEqual([
      { channel: 'default', seq: 2 },
      { channel: 'default', seq: 3 },
      { channel: 'default', seq: 4 },
    ]);
    const ws = await connectServer(app, context);
    await send(app, ws, {
      type: 'subscribe',
      id: 's',
      names: ['changed'],
      since: 1,
    });
    expect(ws.frames()).toEqual([
      { v: 1, type: 'event', seq: 2, name: 'changed', payload: 'two' },
      { v: 1, type: 'event', seq: 3, name: 'changed', payload: 'three' },
      { v: 1, type: 'event', seq: 4, name: 'changed', payload: 'four' },
      { v: 1, type: 'subscribed', id: 's', seq: 4, replayed: true },
    ]);

    expect(
      DurabilitySocket.migrate(context, 'durability_0006_create_socket_events')
    ).toEqual({
      applied: [],
      rolledBack: ['durability_0023_socket_channels'],
    });
    context.storage.sql.exec(
      'INSERT INTO durability_socket_events (name, payload, created_at) VALUES (?, ?, ?)',
      'changed',
      serialize('five'),
      1
    );
    expect(
      context.storage.sql
        .exec<{ seq: number; payload: string }>(
          'SELECT seq, payload FROM durability_socket_events ORDER BY seq'
        )
        .toArray()
    ).toEqual([
      { seq: 2, payload: serialize('two') },
      { seq: 3, payload: serialize('three') },
      { seq: 4, payload: serialize('four') },
      { seq: 5, payload: serialize('five') },
    ]);
  });

  it('refuses to downgrade while another channel holds events', () => {
    const context = socketContextFor(new FakeStorage());
    createChannelSocket(context, undefined).changed('app');
    createChannelSocket(context, 'library').changed('library');

    expect(() =>
      DurabilitySocket.migrate(context, 'durability_0006_create_socket_events')
    ).toThrow(/cannot_downgrade_nondefault_channels/);
    expect(storedEvents(context)).toEqual([
      { channel: 'default', seq: 1 },
      { channel: 'library', seq: 1 },
    ]);
  });
});
