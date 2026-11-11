import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import {
  Durability,
  type DurableCall,
  type DurabilityLifecycleEvent,
} from '../../src';
import { DurabilityTracker } from '../../src/experimental';
import { DurabilitySocket, event, type SocketCall } from '../../src/socket';

export type Todo = { id: string; title: string; done: boolean };

const todoSchema = v.object({
  id: v.string(),
  title: v.string(),
  done: v.boolean(),
});

type Env = { SOCKET_TEST: DurableObjectNamespace<SocketTestObject> };

const libraryChannel = 'library';
// Real SQLite keeps NUL bytes, so this channel must stay apart from `library`.
const nulChannel = 'library\0nul';
const detachLibraryKey = 'detach-library';

/** Uses the same method and event names as the default socket, with its own handlers and metadata. */
const createLibrarySocket = (context: DurableObjectState, channel: string) => {
  const socket = new DurabilitySocket({
    context,
    channel,
    inbound: {
      whoami: (_input: unknown, call: SocketCall<{ user: string }>) =>
        `${JSON.stringify(channel)}:${call.metadata.user}`,
      toggle: {
        input: v.string(),
        handle: (id: string) => {
          socket.updated(id);
          return id;
        },
      },
    },
    outbound: { updated: event<string>() },
    metadata: (request) => ({
      user: `library-${request.headers.get('x-user') ?? 'anonymous'}`,
    }),
    retention: 5,
  });
  return socket;
};

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
    includeResults: true,
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
        input: v.object({ id: v.string(), payload: todoSchema }),
        handle: this.durability.create,
      },
      toggle: {
        input: v.string(),
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

  // A deploy that removed the library channel is simulated by not constructing it.
  readonly librarySocket =
    this.ctx.storage.kv.get(detachLibraryKey) === true
      ? undefined
      : createLibrarySocket(this.ctx, libraryChannel);

  readonly nulSocket = createLibrarySocket(this.ctx, nulChannel);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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

  override fetch(request: Request) {
    const channel = new URL(request.url).searchParams.get('channel');
    if (channel === libraryChannel) {
      return (
        this.librarySocket?.fetch(request) ??
        new Response('Channel removed', { status: 404 })
      );
    }
    if (channel === nulChannel) {
      return this.nulSocket.fetch(request);
    }
    return this.socket.fetch(request);
  }

  // Every connection's frames go through the default socket, which routes them by channel.
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
