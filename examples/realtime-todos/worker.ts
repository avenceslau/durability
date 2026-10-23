/**
 * `DurabilitySocket` example: a Durable Object that browsers talk to directly.
 *
 * Clients call `inbound` handlers over one hibernatable WebSocket and receive
 * `outbound` events as they happen. Creating a todo is a durable operation;
 * its completion is bridged to every connected client through the lifecycle
 * hook, so a crash between "accepted" and "visible" cannot lose the update.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  Durability,
  type DurableCall,
  type DurabilityLifecycleEvent,
} from 'durability';
import { DurabilitySocket, event, type SocketCall } from 'durability/socket';
import { z } from 'zod';

type Env = { TODO_LISTS: DurableObjectNamespace<TodoList> };

const todoSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  done: z.boolean(),
});
export type Todo = z.infer<typeof todoSchema>;

type Metadata = { userId: string };

export class TodoList extends DurableObject<Env> {
  readonly durability = new Durability({
    context: this.ctx,
    handlers: {
      createTodo: async ({ payload }: DurableCall<Todo>) => {
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO todos (id, title, done) VALUES (?, ?, ?)',
          payload.id,
          payload.title,
          payload.done ? 1 : 0
        );
        return payload;
      },
    },
    // Needed so completed lifecycle events carry the todo to broadcast.
    includeResults: true,
  });

  readonly socket = new DurabilitySocket({
    context: this.ctx,
    inbound: {
      list: () => this.list(),
      createTodo: {
        input: z.object({ id: z.string(), payload: todoSchema }),
        handle: this.durability.createTodo,
      },
      toggle: {
        input: z.string(),
        handle: (id: string, call: SocketCall<Metadata>) => {
          const todo = this.list().find((candidate) => candidate.id === id);
          if (!todo) {
            throw new RangeError(`No todo "${id}" for ${call.metadata.userId}`);
          }
          const toggled = { ...todo, done: !todo.done };
          this.ctx.storage.sql.exec(
            'UPDATE todos SET done = ? WHERE id = ?',
            toggled.done ? 1 : 0,
            id
          );
          this.socket.updated(toggled);
          return toggled;
        },
      },
    },
    outbound: {
      created: event<Todo>(),
      updated: event<Todo>(),
      lifecycle: event<DurabilityLifecycleEvent>(),
    },
    // The fronting Worker authenticated the user and set this header.
    metadata: (request): Metadata => ({
      userId: request.headers.get('x-user-id') ?? 'anonymous',
    }),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL)'
    );
    this.durability.lifecycle((lifecycleEvent) => {
      if (
        lifecycleEvent.type === 'attempt_settled' &&
        lifecycleEvent.outcome === 'completed' &&
        lifecycleEvent.result !== undefined
      ) {
        this.socket.created(lifecycleEvent.result);
      }
    });
    this.durability.lifecycle(this.socket.lifecycle);
  }

  private list(): Todo[] {
    return this.ctx.storage.sql
      .exec<{ id: string; title: string; done: number }>(
        'SELECT id, title, done FROM todos ORDER BY rowid'
      )
      .toArray()
      .map((row) => ({ ...row, done: row.done === 1 }));
  }

  override fetch(request: Request) {
    return this.socket.fetch(request);
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    return this.socket.webSocketMessage(ws, message);
  }

  override webSocketClose(ws: WebSocket) {
    this.socket.webSocketClose(ws);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const match = /^\/lists\/([^/]+)\/ws$/.exec(new URL(request.url).pathname);
    if (!match?.[1]) {
      return new Response('Not found', { status: 404 });
    }
    const userId = await authenticate(request);
    if (!userId) {
      return new Response('Unauthorized', { status: 401 });
    }
    const upgrade = new Request(request, {
      headers: { ...Object.fromEntries(request.headers), 'x-user-id': userId },
    });
    return env.TODO_LISTS.getByName(match[1]).fetch(upgrade);
  },
};

declare function authenticate(request: Request): Promise<string | undefined>;
