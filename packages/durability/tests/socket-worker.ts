import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import {
  Durability,
  type DurableCall,
  type DurabilityLifecycleEvent,
} from '../src';
import { DurabilityTracker } from '../src/experimental';
import { DurabilitySocket, event, type SocketCall } from '../src/socket';

export type Todo = { id: string; title: string; done: boolean };

const todoSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
});

type Env = { SOCKET_TEST: DurableObjectNamespace<SocketTestObject> };

export class SocketTestObject extends DurableObject<Env> {
  private readonly todos = new Map<string, Todo>();

  readonly durability = new Durability({
    context: this.ctx,
    handlers: {
      create: async ({ payload }: DurableCall<Todo>) => {
        this.todos.set(payload.id, payload);
        return payload;
      },
    },
  });

  private readonly tracker = new DurabilityTracker({
    sources: { todos: this.durability },
  });

  readonly socket = new DurabilitySocket({
    context: this.ctx,
    inbound: {
      list: () => [...this.todos.values()],
      work: () => this.tracker.records(),
      whoami: (_input: unknown, call: SocketCall<{ user: string }>) =>
        call.metadata.user,
      create: {
        input: z.object({ id: z.string(), payload: todoSchema }),
        handle: this.durability.create,
      },
      toggle: {
        input: z.string(),
        handle: (id: string) => {
          const todo = this.todos.get(id);
          if (!todo) {
            throw new RangeError(`No todo "${id}"`);
          }
          todo.done = !todo.done;
          this.socket.updated(todo);
          return todo;
        },
      },
    },
    outbound: {
      created: event<Todo>(),
      updated: event<Todo>(),
      lifecycle: event<DurabilityLifecycleEvent>(),
    },
    metadata: (request) => ({
      user: request.headers.get('x-user') ?? 'anonymous',
    }),
    retention: 2,
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.durability.lifecycle((lifecycleEvent) => {
      if (
        lifecycleEvent.type === 'attempt_settled' &&
        lifecycleEvent.outcome === 'completed'
      ) {
        this.socket.created(lifecycleEvent.result);
      }
    });
    this.durability.lifecycle(this.socket.lifecycle);
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
  fetch(request: Request, env: Env) {
    const id = new URL(request.url).pathname.split('/').pop() ?? '';
    return env.SOCKET_TEST.getByName(id).fetch(request);
  },
};
