import { createCollection } from '@tanstack/db';
import type {
  SocketConnection,
  SocketShape,
  SocketStatus,
  socketShape,
} from 'durability/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { socketCollectionOptions } from './index';

type Todo = { id: string; title: string; done: boolean };

type TestSocket = {
  readonly [socketShape]: SocketShape<
    {
      list: () => Todo[];
      create: (input: unknown) => Todo;
      remove: (input: unknown) => void;
    },
    {
      created: { readonly payload?: Todo };
      updated: { readonly payload?: Todo };
      removed: { readonly payload?: string };
    }
  >;
};

type Handler = (payload: unknown) => void;

/** A scripted stand-in for a `DurabilitySocketClient` connection. */
const fakeConnection = () => {
  const handlers = new Map<string, Set<Handler>>();
  const statusHandlers = new Set<(status: SocketStatus) => void>();
  const resyncHandlers = new Set<(info: { names: string[] }) => void>();
  let status: SocketStatus = 'disconnected';
  let rows: Todo[] = [];
  let listGate: Promise<void> = Promise.resolve();

  const rpc = {
    list: vi.fn(async () => {
      await listGate;
      return [...rows];
    }),
    create: vi.fn(async (todo: Todo) => todo),
    remove: vi.fn(async () => undefined),
  };

  const on = new Proxy({} as SocketConnection<TestSocket>['on'], {
    get: (_target, name: string) => {
      if (name === 'status') {
        return (handler: (status: SocketStatus) => void) => {
          statusHandlers.add(handler);
          handler(status);
          return () => statusHandlers.delete(handler);
        };
      }
      if (name === 'resync') {
        return (handler: (info: { names: string[] }) => void) => {
          resyncHandlers.add(handler);
          return () => resyncHandlers.delete(handler);
        };
      }
      return (handler: Handler) => {
        const set = handlers.get(name) ?? new Set();
        handlers.set(name, set);
        set.add(handler);
        return () => set.delete(handler);
      };
    },
  });

  const connection = {
    rpc,
    on,
    get status() {
      return status;
    },
    close: () => undefined,
  } as unknown as SocketConnection<TestSocket>;

  return {
    connection,
    rpc,
    subscribedTo: () =>
      [...handlers.keys()].filter((name) => handlers.get(name)!.size > 0),
    setRows: (next: Todo[]) => {
      rows = next;
    },
    holdList: () => {
      let release!: () => void;
      listGate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        listGate = Promise.resolve();
      };
    },
    setStatus: (next: SocketStatus) => {
      status = next;
      for (const handler of statusHandlers) {
        handler(next);
      }
    },
    resync: (names = [...handlers.keys()]) => {
      for (const handler of resyncHandlers) {
        handler({ names });
      }
    },
    emit: (name: string, payload: unknown) => {
      for (const handler of handlers.get(name) ?? []) {
        handler(payload);
      }
    },
  };
};

const todo = (id: string, done = false): Todo => ({
  id,
  title: `todo ${id}`,
  done,
});

const createTodos = (
  fake: ReturnType<typeof fakeConnection>,
  overrides: Partial<
    Parameters<typeof socketCollectionOptions<TestSocket, Todo, string>>[0]
  > = {}
) =>
  createCollection(
    socketCollectionOptions<TestSocket, Todo, string>({
      id: `todos-${Math.random()}`,
      connection: fake.connection,
      getKey: (row) => row.id,
      snapshot: (rpc) => rpc.list(),
      on: {
        created: (row) => ({ type: 'insert', value: row }),
        updated: (row) => ({ type: 'update', value: row }),
        removed: (id) => ({ type: 'delete', key: id }),
      },
      onInsert: async ({ transaction, rpc }) => {
        for (const mutation of transaction.mutations) {
          await rpc.create(mutation.modified);
        }
      },
      onDelete: async ({ transaction, rpc }) => {
        for (const mutation of transaction.mutations) {
          await rpc.remove(mutation.key);
        }
      },
      startSync: true,
      ...overrides,
    })
  );

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Rows without TanStack's virtual `$`-prefixed props. */
const rowsOf = (collection: { toArray: Todo[] }): Todo[] =>
  collection.toArray.map(({ id, title, done }) => ({ id, title, done }));

afterEach(() => {
  vi.useRealTimers();
});

describe('socketCollectionOptions', () => {
  it('seeds from a snapshot on resync and applies events afterwards', async () => {
    const fake = fakeConnection();
    fake.setRows([todo('1')]);
    const todos = createTodos(fake);
    expect(todos.status).toBe('loading');
    expect(fake.subscribedTo().sort()).toEqual([
      'created',
      'removed',
      'updated',
    ]);

    fake.resync();
    await todos.preload();

    expect(fake.rpc.list).toHaveBeenCalledTimes(1);
    expect(rowsOf(todos)).toEqual([todo('1')]);

    fake.emit('created', todo('2'));
    fake.emit('updated', todo('1', true));
    fake.emit('removed', '2');
    await flush();
    expect(rowsOf(todos)).toEqual([todo('1', true)]);
  });

  it('ignores resyncs for events it does not map', async () => {
    const fake = fakeConnection();
    fake.setRows([todo('1')]);
    const todos = createTodos(fake);
    fake.resync(['somethingElse']);
    await flush();
    expect(fake.rpc.list).not.toHaveBeenCalled();
    expect(todos.status).toBe('loading');

    fake.resync(['updated']);
    await todos.preload();
    expect(rowsOf(todos)).toEqual([todo('1')]);
  });

  it('drops events that arrive while a snapshot is in flight', async () => {
    const fake = fakeConnection();
    const release = fake.holdList();
    const todos = createTodos(fake);
    fake.resync();
    await flush();
    // Already reflected in the snapshot the server is about to answer with.
    fake.setRows([todo('1'), todo('2')]);
    fake.emit('created', todo('2'));
    release();
    await todos.preload();
    expect(rowsOf(todos)).toEqual([todo('1'), todo('2')]);

    fake.emit('created', todo('3'));
    await flush();
    expect(rowsOf(todos)).toHaveLength(3);
  });

  it('replaces all rows on a later resync', async () => {
    const fake = fakeConnection();
    fake.setRows([todo('1'), todo('2')]);
    const todos = createTodos(fake);
    fake.resync();
    await todos.preload();

    fake.setRows([todo('2', true), todo('9')]);
    fake.resync();
    await vi.waitFor(() =>
      expect(rowsOf(todos)).toEqual([todo('2', true), todo('9')])
    );
    expect(fake.rpc.list).toHaveBeenCalledTimes(2);
  });

  it('treats repeated event inserts as upserts', async () => {
    const fake = fakeConnection();
    fake.setRows([todo('1')]);
    const todos = createTodos(fake);
    fake.resync();
    await todos.preload();

    fake.emit('created', todo('1', true));
    await flush();
    expect(rowsOf(todos)).toEqual([todo('1', true)]);
  });

  it('forwards optimistic mutations to rpc and keeps the confirmed row', async () => {
    const fake = fakeConnection();
    const todos = createTodos(fake);
    fake.resync();
    await todos.preload();

    fake.rpc.create.mockImplementationOnce(async (row: Todo) => {
      // The server pushes the event before answering the call.
      fake.emit('created', row);
      return row;
    });
    const transaction = todos.insert(todo('a'));
    expect(rowsOf(todos)).toEqual([todo('a')]);
    await transaction.isPersisted.promise;
    expect(fake.rpc.create).toHaveBeenCalledWith(todo('a'));
    expect(rowsOf(todos)).toEqual([todo('a')]);

    await todos.delete('a').isPersisted.promise;
    expect(fake.rpc.remove).toHaveBeenCalledWith('a');
  });

  it('rolls back when the rpc call fails', async () => {
    const fake = fakeConnection();
    fake.setRows([todo('1')]);
    const todos = createTodos(fake);
    fake.resync();
    await todos.preload();

    fake.rpc.create.mockRejectedValueOnce(new Error('nope'));
    const transaction = todos.insert(todo('b'));
    expect(rowsOf(todos)).toHaveLength(2);
    await expect(transaction.isPersisted.promise).rejects.toThrow('nope');
    expect(rowsOf(todos)).toEqual([todo('1')]);
  });

  it('awaitSynced waits for the confirming write and times out gracefully', async () => {
    vi.useFakeTimers();
    const fake = fakeConnection();
    const order: string[] = [];
    const todos = createTodos(fake, {
      onInsert: async ({ transaction, rpc, awaitSynced }) => {
        await rpc.create(transaction.mutations[0].modified);
        order.push('accepted');
        await awaitSynced({ timeoutMs: 1_000 });
        order.push('synced');
      },
    });
    fake.resync();
    await todos.preload();

    const first = todos.insert(todo('a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['accepted']);
    fake.emit('created', todo('a'));
    await first.isPersisted.promise;
    expect(order).toEqual(['accepted', 'synced']);

    const second = todos.insert(todo('b'));
    await vi.advanceTimersByTimeAsync(1_000);
    await second.isPersisted.promise;
    expect(order).toEqual(['accepted', 'synced', 'accepted', 'synced']);
  });

  it('exposes utils.write for authoritative changes outside the event stream', async () => {
    const fake = fakeConnection();
    const todos = createTodos(fake);
    fake.resync();
    await todos.preload();

    todos.utils.write({ type: 'insert', value: todo('x') });
    await flush();
    expect(rowsOf(todos)).toEqual([todo('x')]);
  });

  it('marks the collection errored when the snapshot fails', async () => {
    const fake = fakeConnection();
    fake.rpc.list.mockRejectedValueOnce(new Error('offline'));
    const todos = createTodos(fake);
    fake.resync();
    await expect(todos.preload()).rejects.toThrow('offline');
  });

  it('unsubscribes from the connection on cleanup and reseeds on restart', async () => {
    const fake = fakeConnection();
    fake.setRows([todo('1')]);
    const todos = createTodos(fake, { startSync: false, gcTime: 0 });
    expect(fake.subscribedTo()).toEqual([]);

    const first = todos.preload();
    expect(fake.subscribedTo()).toHaveLength(3);
    fake.resync();
    await first;
    await todos.cleanup();
    expect(fake.subscribedTo()).toEqual([]);

    fake.setRows([todo('1'), todo('2')]);
    const second = todos.preload();
    fake.resync();
    await second;
    expect(fake.rpc.list).toHaveBeenCalledTimes(2);
    expect(rowsOf(todos)).toEqual([todo('1'), todo('2')]);
  });
});
