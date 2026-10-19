import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DurabilitySocketClient, SocketRemoteError } from '../src/client';
import type { SocketTestObject, Todo } from './socket-worker';

type Socket = SocketTestObject['socket'];

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
          state: { status: 'completed' },
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
