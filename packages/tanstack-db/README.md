# @durability/tanstack-db

TanStack DB collections synced over a `DurabilitySocket` connection.

## Install

```sh
npm install @durability/tanstack-db @tanstack/db durability
```

`@tanstack/db` is a peer dependency; this package follows its `0.13` minor until the adapter API stabilises.

## Create a synced collection

`socketCollectionOptions` turns a `durability/client` connection into collection options: one inbound method provides the snapshot, outbound events keep rows current, and optimistic mutations are forwarded to the connection's `rpc`.

```ts
import { createCollection } from '@tanstack/db';
import { DurabilitySocketClient } from 'durability/client';
import { socketCollectionOptions } from '@durability/tanstack-db';
import type { Todo, TodoList } from '../worker';

const client = new DurabilitySocketClient<TodoList['socket']>({
  url: (listId) => `wss://example.com/lists/${listId}/ws`,
});

export const todos = createCollection(
  socketCollectionOptions<TodoList['socket'], Todo, string>({
    id: 'todos',
    connection: client.connect('personal'),
    getKey: (todo) => todo.id,
    snapshot: (rpc) => rpc.list(),
    on: {
      created: (todo) => ({ type: 'insert', value: todo }),
      updated: (todo) => ({ type: 'update', value: todo }),
      removed: (id) => ({ type: 'delete', key: id }),
    },
    onInsert: async ({ transaction, rpc }) => {
      for (const { modified } of transaction.mutations) {
        await rpc.createTodo({ id: modified.id, payload: modified });
      }
    },
    onUpdate: async ({ transaction, rpc }) => {
      for (const { key } of transaction.mutations) {
        await rpc.toggle(key);
      }
    },
  })
);

todos.insert({ id: crypto.randomUUID(), title: 'Ship it', done: false });
```

`on` maps each outbound event to a row change (`insert`, `update`, or `delete`), an array of changes, or nothing. Inserts from events are applied as full-row upserts, so an event that repeats a row already present is harmless. Keys are never remapped: generate row ids on the client so the optimistic row and the server's row share one key.

## Snapshots and resync

The snapshot runs when the connection reports `resync` for one of the mapped events: on the collection's first subscription, and whenever the socket could not replay events missed while disconnected. It replaces every synced row; optimistic rows are reapplied on top. Events received while a snapshot is in flight are dropped, because the socket delivers frames in order and the Durable Object handles one message at a time, so anything received before the snapshot response is already reflected in it. Keep snapshot handlers free of awaits on anything but storage for that to hold.

A snapshot that throws before the collection is ready rejects `preload()`; a later `resync` retries it.

## Mutations

`onInsert`, `onUpdate`, and `onDelete` receive TanStack's mutation params plus:

- `rpc`: the connection's typed methods.
- `awaitSynced({ timeoutMs })`: resolves once every key in the transaction has been written by a sync commit since the mutation began (default timeout 30 seconds, after which it resolves anyway).

TanStack drops the optimistic overlay when the handler resolves. For handlers whose confirming event precedes the RPC response (the server pushes before it replies), awaiting the call is enough. For durable operations the response is only acceptance, so await the completion event before returning:

```ts
onInsert: async ({ transaction, rpc, awaitSynced }) => {
  for (const { modified } of transaction.mutations) {
    await rpc.createTodo({ id: modified.id, payload: modified });
  }
  await awaitSynced();
},
```

A rejected handler rolls the optimistic mutation back. Calls lost mid-flight reject with `SocketConnectionLostError` and are not retried; route retried mutations through `Durability` with a stable idempotency key.

`collection.utils.write(changes)` applies authoritative changes from outside the event stream, for example a row returned by an RPC call. It is safe to call from mutation handlers.

## Lifecycle

The adapter only subscribes to the connection; it never closes it. Cleanup (explicit or garbage collection) unsubscribes, and the next sync run resubscribes and snapshots again.
