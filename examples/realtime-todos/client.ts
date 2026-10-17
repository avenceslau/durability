/**
 * Browser side of the `realtime-todos` example. Imports only `durability/client`,
 * which has no Workers dependencies, and derives every method and event type
 * from the Durable Object's socket.
 */
import { DurabilitySocketClient, logging } from 'durability/client';
import type { Todo, TodoList } from './worker';

const client = new DurabilitySocketClient<TodoList['socket']>({
  url: (listId) => `wss://todos.example.com/lists/${listId}/ws`,
}).with(logging());

export const openList = (listId: string, render: (todos: Todo[]) => void) => {
  const conn = client.connect(listId);
  const todos = new Map<string, Todo>();

  const reload = async () => {
    todos.clear();
    for (const todo of await conn.rpc.list()) {
      todos.set(todo.id, todo);
    }
    render([...todos.values()]);
  };

  // Fires on first connect and whenever missed events could not be replayed.
  conn.on.resync(() => void reload());
  conn.on.created((todo) => {
    todos.set(todo.id, todo);
    render([...todos.values()]);
  });
  conn.on.updated((todo) => {
    todos.set(todo.id, todo);
    render([...todos.values()]);
  });
  conn.on.status((status) => console.info('todo list', listId, status));

  return {
    create: (title: string) =>
      conn.rpc.createTodo({
        id: crypto.randomUUID(),
        payload: { id: crypto.randomUUID(), title, done: false },
      }),
    toggle: (id: string) => conn.rpc.toggle(id),
    close: () => conn.close(),
  };
};
