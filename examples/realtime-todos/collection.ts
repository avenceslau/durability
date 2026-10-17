/**
 * TanStack DB view of the `realtime-todos` list. The collection seeds itself
 * from `list`, stays current from `created`/`updated` events, and forwards
 * optimistic inserts and toggles to the Durable Object.
 */
import { createCollection } from '@tanstack/db';
import { socketCollectionOptions } from '@durability/tanstack-db';
import { DurabilitySocketClient } from 'durability/client';
import type { Todo, TodoList } from './worker';

const client = new DurabilitySocketClient<TodoList['socket']>({
  url: (listId) => `wss://todos.example.com/lists/${listId}/ws`,
});

export const todosFor = (listId: string) =>
  createCollection(
    socketCollectionOptions<TodoList['socket'], Todo, string>({
      id: `todos:${listId}`,
      connection: client.connect(listId),
      getKey: (todo) => todo.id,
      snapshot: (rpc) => rpc.list(),
      on: {
        created: (todo) => ({ type: 'insert', value: todo }),
        updated: (todo) => ({ type: 'update', value: todo }),
      },
      // `createTodo` is a durable operation: the response is only acceptance,
      // so wait for the `created` event before dropping the optimistic row.
      onInsert: async ({ transaction, rpc, awaitSynced }) => {
        for (const { modified } of transaction.mutations) {
          await rpc.createTodo({ id: crypto.randomUUID(), payload: modified });
        }
        await awaitSynced();
      },
      onUpdate: async ({ transaction, rpc }) => {
        for (const { key } of transaction.mutations) {
          await rpc.toggle(key);
        }
      },
    })
  );
