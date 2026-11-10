import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  DurabilitySocketClient,
  SocketRemoteError,
} from '../../src/socket/client';
import { DurabilitySocket } from '../../src/socket';
import type { SocketTestObject, Todo } from './worker';

declare global {
  namespace Cloudflare {
    interface Env {
      SOCKET_TEST: DurableObjectNamespace<SocketTestObject>;
    }
  }
}

type Socket = SocketTestObject['socket'];
type LibrarySocket = SocketTestObject['nulSocket'];

const nulChannel = 'library\0nul';

/** Bridges the browser `WebSocket` constructor onto `SELF.fetch` upgrades. */
class TestWebSocket extends EventTarget {
  static instances: TestWebSocket[] = [];

  readyState = 0;
  #ws: WebSocket | undefined;

  constructor(url: string) {
    super();
    TestWebSocket.instances.push(this);
    void SELF.fetch(url.replace(/^ws/, 'http'), {
      headers: { Upgrade: 'websocket', 'x-user': 'alice' },
    }).then((response) => {
      const ws = response.webSocket;
      if (!ws) {
        this.dispatchEvent(new CloseEvent('close', { code: 1006 }));
        return;
      }
      ws.accept();
      ws.addEventListener('message', (message) => {
        this.dispatchEvent(new MessageEvent('message', { data: message.data }));
      });
      ws.addEventListener('close', (closed) => {
        this.readyState = 3;
        this.dispatchEvent(
          new CloseEvent('close', { code: closed.code, reason: closed.reason })
        );
      });
      this.#ws = ws;
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      return undefined;
    });
  }

  send(text: string): void {
    this.#ws?.send(text);
  }

  close(code?: number, reason?: string): void {
    this.#ws?.close(code, reason);
  }

  /** Simulates a network cut: the client sees an abnormal close. */
  drop(): void {
    this.#ws?.close(4000, 'dropped');
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code: 1006 }));
  }
}

const client = new DurabilitySocketClient<Socket>({
  url: (id) => `ws://example.com/socket/${id}`,
  webSocket: TestWebSocket as unknown as new (url: string) => WebSocket,
});

const libraryClient = new DurabilitySocketClient<LibrarySocket>({
  url: (id) => `ws://example.com/socket/${id}?channel=library`,
  webSocket: TestWebSocket as unknown as new (url: string) => WebSocket,
});

const nulClient = new DurabilitySocketClient<LibrarySocket>({
  url: (id) =>
    `ws://example.com/socket/${id}?channel=${encodeURIComponent(nulChannel)}`,
  webSocket: TestWebSocket as unknown as new (url: string) => WebSocket,
});

const channelEvents = (id: string) =>
  runInDurableObject(env.SOCKET_TEST.getByName(id), (_instance, state) =>
    state.storage.sql
      .exec<{ channel: string; seq: number; payload: string }>(
        `SELECT channel, seq, payload FROM durability_socket_events
         WHERE channel != 'default' ORDER BY channel, seq`
      )
      .toArray()
  );

/** A connection without the browser client, for exact frames and close codes across eviction. */
const openRaw = async (id: string, query = '') => {
  const response = await SELF.fetch(`http://example.com/socket/${id}${query}`, {
    headers: { Upgrade: 'websocket', 'x-user': 'alice' },
  });
  const ws = response.webSocket;
  if (!ws) {
    throw new Error(`Upgrade failed with status ${response.status}`);
  }
  ws.accept();
  const frames: unknown[] = [];
  let closed: { code: number; reason: string } | undefined;
  ws.addEventListener('message', (message) => {
    frames.push(JSON.parse(String(message.data)));
  });
  ws.addEventListener('close', (event) => {
    closed = { code: event.code, reason: event.reason };
  });
  return {
    frames,
    closed: () => closed,
    send: (value: object) => ws.send(JSON.stringify({ v: 1, ...value })),
    close: () => ws.close(1000, 'done'),
  };
};

const waitFor = async (
  assertion: () => void,
  remaining = 100
): Promise<void> => {
  try {
    assertion();
  } catch (error) {
    if (remaining === 0) {
      throw error;
    }
    await scheduler.wait(10);
    await waitFor(assertion, remaining - 1);
  }
};

describe('DurabilitySocket in workerd', () => {
  it('calls inbound handlers, pushes outbound events, and bridges durability lifecycle', async () => {
    const conn = client.connect('list-a');
    const created: Todo[] = [];
    const updated: Todo[] = [];
    const lifecycle: string[] = [];
    conn.on.created((todo) => created.push(todo));
    conn.on.updated((todo) => updated.push(todo));
    conn.on.lifecycle((lifecycleEvent) => lifecycle.push(lifecycleEvent.type));

    await expect(conn.rpc.whoami()).resolves.toBe('alice');
    await expect(conn.rpc.list()).resolves.toEqual([]);

    const todo = { id: 't1', title: 'write tests', done: false };
    await conn.rpc.create({ id: 'op-1', payload: todo });
    await waitFor(() => expect(created).toEqual([todo]));
    expect(lifecycle).toEqual([
      'registered',
      'attempt_started',
      'attempt_settled',
    ]);

    await expect(conn.rpc.toggle('t1')).resolves.toEqual({
      ...todo,
      done: true,
    });
    expect(updated).toEqual([{ ...todo, done: true }]);
    await expect(conn.rpc.toggle('missing')).rejects.toBeInstanceOf(
      SocketRemoteError
    );
    await expect(conn.rpc.toggle('missing')).rejects.toMatchObject({
      name: 'RangeError',
      message: 'No todo "missing"',
    });
    conn.close();
  });

  it('serves tracked work as plain records', async () => {
    const conn = client.connect('list-tracker');
    const created: Todo[] = [];
    conn.on.created((todo) => created.push(todo));
    const todo = { id: 't1', title: 'track it', done: false };
    await conn.rpc.create({ id: 'op-1', payload: todo });
    await waitFor(() => expect(created).toHaveLength(1));

    await expect(conn.rpc.work()).resolves.toEqual({
      records: [
        {
          source: 'todos',
          id: 'op-1',
          name: 'create',
          generation: expect.any(String),
          createdAt: expect.any(Number),
          state: { status: 'completed', result: todo },
        },
      ],
    });
    conn.close();
  });

  it('replays missed events to a reconnecting subscriber and resyncs on gaps', async () => {
    TestWebSocket.instances = [];
    const subscriber = client.connect('list-b');
    const seen: Todo[] = [];
    let resyncs = 0;
    subscriber.on.resync(() => {
      resyncs += 1;
    });
    subscriber.on.updated((todo) => seen.push(todo));
    await subscriber.rpc.create({
      id: 'op-1',
      payload: { id: 't1', title: 'a', done: false },
    });
    await waitFor(() => expect(resyncs).toBe(1));

    const writer = client.connect('list-b');
    await writer.rpc.toggle('t1');
    await waitFor(() => expect(seen).toHaveLength(1));

    // Two events while disconnected fit the retention of 2: replayed, no resync.
    TestWebSocket.instances[0]!.drop();
    await waitFor(() => expect(subscriber.status).toBe('disconnected'));
    await writer.rpc.toggle('t1');
    await writer.rpc.toggle('t1');
    await waitFor(() => expect(seen).toHaveLength(3), 200);
    expect(seen.map((todo) => todo.done)).toEqual([true, false, true]);
    expect(resyncs).toBe(1);

    // Three events overflow retention: nothing replayed, resync requested.
    TestWebSocket.instances[2]!.drop();
    await waitFor(() => expect(subscriber.status).toBe('disconnected'));
    await writer.rpc.toggle('t1');
    await writer.rpc.toggle('t1');
    await writer.rpc.toggle('t1');
    await waitFor(() => expect(resyncs).toBe(2), 200);
    expect(seen).toHaveLength(3);
    await expect(subscriber.rpc.list()).resolves.toEqual([
      { id: 't1', title: 'a', done: false },
    ]);

    subscriber.close();
    writer.close();
  });
});

describe('DurabilitySocket channels in workerd', () => {
  it('keeps channels with the same method and event names apart', async () => {
    const id = 'channels-apart';
    const app = client.connect(id);
    const library = libraryClient.connect(id);
    const nul = nulClient.connect(id);
    const appUpdated: Todo[] = [];
    const libraryUpdated: string[] = [];
    const nulUpdated: string[] = [];
    app.on.updated((todo) => appUpdated.push(todo));
    library.on.updated((todoId) => libraryUpdated.push(todoId));
    nul.on.updated((todoId) => nulUpdated.push(todoId));

    await expect(app.rpc.whoami()).resolves.toBe('alice');
    await expect(library.rpc.whoami()).resolves.toBe('"library":library-alice');
    await expect(nul.rpc.whoami()).resolves.toBe(
      `${JSON.stringify(nulChannel)}:library-alice`
    );

    await expect(library.rpc.toggle('a')).resolves.toBe('a');
    await expect(nul.rpc.toggle('b')).resolves.toBe('b');
    await expect(library.rpc.toggle('c')).resolves.toBe('c');
    await waitFor(() => expect(libraryUpdated).toEqual(['a', 'c']));
    await waitFor(() => expect(nulUpdated).toEqual(['b']));
    await expect(app.rpc.toggle('a')).rejects.toMatchObject({
      message: 'No todo "a"',
    });
    expect(appUpdated).toEqual([]);

    const events = await channelEvents(id);
    expect(events.map(({ channel, seq }) => ({ channel, seq }))).toEqual([
      { channel: 'library', seq: 1 },
      { channel: 'library', seq: 2 },
      { channel: nulChannel, seq: 1 },
    ]);
    await runInDurableObject(
      env.SOCKET_TEST.getByName(id),
      (_instance, state) => {
        expect(() =>
          DurabilitySocket.migrate(
            state,
            'durability_0006_create_socket_events'
          )
        ).toThrow(/cannot_downgrade_nondefault_channels/);
      }
    );
    expect(await channelEvents(id)).toEqual(events);

    app.close();
    library.close();
    nul.close();
  });

  it('routes hibernated connections to their channel after eviction', async () => {
    const id = 'channels-hibernate';
    const app = await openRaw(id);
    const library = await openRaw(id, '?channel=library');
    app.send({
      type: 'subscribe',
      id: 's',
      names: ['updated'],
    });
    library.send({
      type: 'subscribe',
      id: 's',
      names: ['updated'],
    });
    library.send({
      type: 'call',
      id: 't1',
      method: 'toggle',
      input: 'before',
    });
    await waitFor(() => expect(app.frames).toHaveLength(1));
    await waitFor(() => expect(library.frames).toHaveLength(3));

    await evictDurableObject(env.SOCKET_TEST.getByName(id));

    library.send({
      type: 'call',
      id: 'w',
      method: 'whoami',
    });
    library.send({
      type: 'call',
      id: 't2',
      method: 'toggle',
      input: 'after',
    });
    app.send({
      type: 'call',
      id: 'w',
      method: 'whoami',
    });
    await waitFor(() => expect(library.frames).toHaveLength(6));
    await waitFor(() => expect(app.frames).toHaveLength(2));
    expect(library.frames).toEqual([
      {
        v: 1,
        type: 'subscribed',
        id: 's',
        seq: 0,
        replayed: false,
      },
      {
        v: 1,
        type: 'event',
        seq: 1,
        name: 'updated',
        payload: 'before',
      },
      {
        v: 1,
        type: 'result',
        id: 't1',
        output: 'before',
      },
      {
        v: 1,
        type: 'result',
        id: 'w',
        output: '"library":library-alice',
      },
      {
        v: 1,
        type: 'event',
        seq: 2,
        name: 'updated',
        payload: 'after',
      },
      {
        v: 1,
        type: 'result',
        id: 't2',
        output: 'after',
      },
    ]);
    expect(app.frames).toEqual([
      {
        v: 1,
        type: 'subscribed',
        id: 's',
        seq: 0,
        replayed: false,
      },
      {
        v: 1,
        type: 'result',
        id: 'w',
        output: 'alice',
      },
    ]);

    app.close();
    library.close();
  });

  it('closes connections of a removed channel and keeps its events', async () => {
    const id = 'channels-removed';
    const stub = env.SOCKET_TEST.getByName(id);
    const app = await openRaw(id);
    const library = await openRaw(id, '?channel=library');
    library.send({
      type: 'call',
      id: 't',
      method: 'toggle',
      input: 'kept',
    });
    await waitFor(() => expect(library.frames).toHaveLength(1));

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put('detach-library', true);
    });
    await evictDurableObject(stub);

    library.send({
      type: 'call',
      id: 'w',
      method: 'whoami',
    });
    await waitFor(() =>
      expect(library.closed()).toEqual({
        code: 1011,
        reason: 'Socket channel is not attached',
      })
    );
    expect(library.frames).toHaveLength(1);
    app.send({
      type: 'call',
      id: 'w',
      method: 'whoami',
    });
    await waitFor(() =>
      expect(app.frames).toEqual([
        {
          v: 1,
          type: 'result',
          id: 'w',
          output: 'alice',
        },
      ])
    );
    expect(
      (await channelEvents(id)).map(({ channel, seq }) => ({ channel, seq }))
    ).toEqual([{ channel: 'library', seq: 1 }]);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.delete('detach-library');
    });
    await evictDurableObject(stub);
    const restored = await openRaw(id, '?channel=library');
    restored.send({
      type: 'subscribe',
      id: 's',
      names: ['updated'],
      since: 0,
    });
    restored.send({
      type: 'call',
      id: 't',
      method: 'toggle',
      input: 'again',
    });
    await waitFor(() => expect(restored.frames).toHaveLength(4));
    expect(restored.frames).toEqual([
      {
        v: 1,
        type: 'event',
        seq: 1,
        name: 'updated',
        payload: 'kept',
      },
      {
        v: 1,
        type: 'subscribed',
        id: 's',
        seq: 1,
        replayed: true,
      },
      {
        v: 1,
        type: 'event',
        seq: 2,
        name: 'updated',
        payload: 'again',
      },
      {
        v: 1,
        type: 'result',
        id: 't',
        output: 'again',
      },
    ]);

    app.close();
    restored.close();
  });

  it('downgrades and upgrades again keeping default sequence numbers', async () => {
    const id = 'channels-migrate';
    const stub = env.SOCKET_TEST.getByName(id);
    const app = await openRaw(id);
    app.send({
      type: 'subscribe',
      id: 's',
      names: ['updated'],
    });
    await waitFor(() => expect(app.frames).toHaveLength(1));
    app.close();

    const sequences = await runInDurableObject(stub, (instance, state) => {
      instance.socket.updated({
        id: 't1',
        title: 'one',
        done: false,
      });
      instance.socket.updated({
        id: 't1',
        title: 'two',
        done: false,
      });
      expect(
        DurabilitySocket.migrate(state, 'durability_0006_create_socket_events')
      ).toEqual({
        applied: [],
        rolledBack: ['durability_0023_socket_channels'],
      });
      return state.storage.sql
        .exec<{ seq: number }>(
          `INSERT INTO durability_socket_events (name, payload, created_at)
           VALUES ('updated', '{"kind":"value","value":null}', 0) RETURNING seq`
        )
        .one().seq;
    });
    expect(sequences).toBe(3);

    await evictDurableObject(stub);
    const rows = await runInDurableObject(stub, (instance, state) => {
      instance.socket.updated({
        id: 't1',
        title: 'four',
        done: false,
      });
      return state.storage.sql
        .exec<{ channel: string; seq: number }>(
          'SELECT channel, seq FROM durability_socket_events ORDER BY seq'
        )
        .toArray();
    });
    expect(rows).toEqual([
      { channel: 'default', seq: 3 },
      { channel: 'default', seq: 4 },
    ]);
  });
});
