import example from '../../../examples/realtime-todos/worker.ts?raw';
import migrations from '../../../packages/durability/src/socket/migrations.ts?raw';
import socket from '../../../packages/durability/src/socket/index.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/realtime-todos/worker.ts';
const migrationsFile = 'packages/durability/src/socket/migrations.ts';
const socketFile = 'packages/durability/src/socket/index.ts';

const todoList = sourceExcerpt(
  example,
  exampleFile,
  'todo-list',
  'TodoList Durable Object',
  'export class TodoList extends DurableObject<Env> {',
  '    return this.durability.alarm(info);\n  }'
);
const upgrade = sourceExcerpt(
  example,
  exampleFile,
  'upgrade',
  'Authenticate and forward the upgrade',
  'export default {',
  '};'
);
const schema = sourceExcerpt(
  migrations,
  migrationsFile,
  'schema',
  'The event table',
  "    name: 'durability_0006_create_socket_events',",
  "    down: 'DROP TABLE IF EXISTS durability_socket_events;',"
);
const construct = sourceExcerpt(
  socket,
  socketFile,
  'construct',
  'Attach to the object',
  '  constructor(config: DurabilitySocketConfig<Inbound, Outbound, Metadata>) {',
  '      )\n    );\n  }'
);
const accept = sourceExcerpt(
  socket,
  socketFile,
  'accept',
  'Accept a hibernatable WebSocket',
  '  async fetch(request: Request): Promise<Response> {',
  '    return new Response(null, { status: 101, webSocket: client });\n  }'
);
const message = sourceExcerpt(
  socket,
  socketFile,
  'message',
  'Handle frames the object receives',
  '  async webSocketMessage(',
  '  webSocketClose(_ws: WebSocket): void {}'
);
const call = sourceExcerpt(
  socket,
  socketFile,
  'call',
  'Run an allowlisted handler',
  '  async #call(',
  '        error: serializeError(error),\n      });\n    }\n  }'
);
const subscribe = sourceExcerpt(
  socket,
  socketFile,
  'subscribe',
  'Subscribe and replay',
  '  #subscribe(',
  '    return true;\n  }'
);
const publish = sourceExcerpt(
  socket,
  socketFile,
  'publish',
  'Store, trim, and push an event',
  '  #publish(name: string, payload: unknown): void {',
  '      sendFrame(ws, frame);\n    }\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'socket',
  title: 'How DurabilitySocket uses your Durable Object',
  summary:
    'DurabilitySocket accepts browser WebSockets on the object, keeps per-connection state in the socket attachments, and stores outbound events in the object’s SQLite storage for replay. Step through a call that becomes an event, a hibernation, and a dropped connection.',
  diagram: {
    canvas: { width: 1000, height: 900 },
    direction: 'down',
    routing: 'auto',
    flows: {
      connect: { label: 'connect and subscribe', color: 'blue' },
      call: { label: 'call a handler', color: 'orange' },
      push: { label: 'store and push an event', color: 'purple' },
    },
    nodes: {
      browser: {
        rank: 0,
        row: 1,
        label: 'Browser',
        sublabel: 'socket client',
        icon: 'browser',
        tone: 'external',
      },
      worker: {
        rank: 1,
        row: 1,
        label: 'Worker',
        sublabel: 'authenticates',
        icon: 'workers',
        tone: 'external',
      },
      object: {
        rank: 2,
        row: 1,
        label: 'TodoList',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      websockets: {
        rank: 3,
        row: 0,
        label: 'WebSockets',
        sublabel: 'attachments',
        icon: 'user',
        size: [224, 72],
      },
      socket: {
        rank: 3,
        row: 1,
        label: 'DurabilitySocket',
        sublabel: 'in memory',
        icon: 'shield',
      },
      durability: {
        rank: 3,
        row: 2,
        label: 'Durability',
        sublabel: 'createTodo',
        icon: 'shield',
      },
      events: {
        rank: 4,
        row: 1,
        label: 'socket events',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      todos: {
        rank: 4,
        row: 2,
        label: 'todos',
        sublabel: 'your table',
        icon: 'database',
      },
    },
    edges: [
      { from: 'browser', to: 'worker', label: 'upgrade', flow: 'connect' },
      {
        from: 'worker',
        to: 'object',
        label: 'stub.fetch()',
        flow: 'connect',
      },
      { from: 'object', to: 'socket', label: 'delegates', flow: 'connect' },
      {
        from: 'socket',
        to: 'websockets',
        label: 'send',
        flow: 'push',
      },
      {
        from: 'socket',
        to: 'durability',
        label: 'call',
        flow: 'call',
      },
      { from: 'durability', to: 'todos', label: 'INSERT', flow: 'call' },
      { from: 'socket', to: 'events', label: 'seq rows', flow: 'push' },
      {
        from: 'durability',
        to: 'events',
        label: 'created()',
        flow: 'push',
      },
      {
        from: 'websockets',
        to: 'browser',
        label: 'frames',
        flow: 'push',
        back: true,
      },
    ],
    groups: [
      {
        id: 'durable-object',
        label: 'One Durable Object',
        contains: [
          'object',
          'websockets',
          'socket',
          'durability',
          'events',
          'todos',
        ],
      },
    ],
  },
  details: {
    browser: {
      description:
        'A DurabilitySocketClient connection. It calls inbound handlers by name, subscribes to outbound events, and remembers the last event sequence it saw, in browser memory only.',
      href: '/primitives/client/',
      source: 'upgrade',
    },
    worker: {
      description:
        'Authenticates the user, puts the user ID on the upgrade request, and forwards it to the list’s object with getByName(). The socket does no authorization of its own.',
      href: '/primitives/socket/',
      source: 'upgrade',
    },
    object: {
      description:
        'Your class. DurabilitySocket is one of its fields, so it is rebuilt with every new instance. fetch(), webSocketMessage(), and webSocketClose() must delegate to it.',
      href: '/primitives/socket/',
      source: 'todo-list',
    },
    websockets: {
      description:
        'Hibernatable WebSockets accepted with ctx.acceptWebSocket. Each attachment holds the upgrade metadata and the subscribed event names; the runtime keeps it with the connection while the object is evicted.',
      href: '/primitives/socket/',
      source: 'accept',
    },
    socket: {
      description:
        'Holds only configuration in memory: the inbound allowlist, the outbound methods it installed, and the retention limit. Subscriptions and metadata live on the sockets, events in SQLite.',
      href: '/primitives/socket/',
      source: 'construct',
    },
    durability: {
      description:
        'The createTodo durable operation. Its row lives in durability_calls and it runs again from the object alarm after an eviction. Its lifecycle hook publishes the created event.',
      href: '/primitives/operations/',
      source: 'todo-list',
    },
    events: {
      description:
        'durability_socket_events in the object’s own SQLite storage: an autoincrementing sequence, the event name, the JSON payload, and the creation time. Only the newest retention rows (1,000 by default) are kept.',
      href: '/reference/storage/',
      source: 'schema',
    },
    todos: {
      description:
        'The application’s own table. The list() handler reads it as the snapshot a client rebuilds from when replay is not possible.',
      href: '/primitives/socket/',
      source: 'todo-list',
    },
  },
  excerpts: [
    todoList,
    upgrade,
    schema,
    construct,
    accept,
    message,
    call,
    subscribe,
    publish,
  ],
  scenarios: [
    {
      id: 'call',
      title: 'Call a handler and push the result',
      description:
        'Follow one browser from the upgrade to a created event that every subscriber receives.',
      steps: [
        {
          id: 'field',
          title: 'The socket belongs to the object instance',
          description:
            'DurabilitySocket is constructed with this.ctx. Every outbound event becomes a method on the instance, so this.socket.created(todo) stores and pushes an event.',
          stage: ['object', 'socket', 'durable-object', 'focus:socket'],
          source: sourceFocus(
            todoList,
            'readonly socket = new DurabilitySocket({',
            'context: this.ctx,'
          ),
          durable: 'Nothing is written yet.',
          volatile:
            'The handler map and the outbound methods, rebuilt with each instance.',
          status: 'normal',
        },
        {
          id: 'migrate',
          title: 'Create the event table in the object\u2019s SQLite',
          description:
            'The constructor applies this migration synchronously through ctx.storage.sql. The AUTOINCREMENT sequence never reuses a number, even after old rows are trimmed.',
          stage: ['events', 'focus:events'],
          source: sourceFocus(
            schema,
            'CREATE TABLE IF NOT EXISTS durability_socket_events (',
            'created_at INTEGER NOT NULL'
          ),
          durable: 'durability_socket_events exists in this object’s storage.',
          volatile:
            'Nothing; the auto-response is registered with the runtime.',
          status: 'commit',
        },
        {
          id: 'upgrade',
          title: 'The Worker authenticates the upgrade',
          description:
            'The Worker resolves the user, copies the request with an x-user-id header, and forwards it to the list’s object. The socket trusts whatever the request carries, so the Worker must set the header itself.',
          stage: ['browser', 'worker', 'flow:connect'],
          source: sourceFocus(
            upgrade,
            'const userId = await authenticate(request);',
            'return env.TODO_LISTS.getByName(match[1]).fetch(upgrade);'
          ),
          durable: 'Nothing.',
          volatile: 'The upgrade request.',
          status: 'normal',
        },
        {
          id: 'accept',
          title: 'Accept a hibernatable WebSocket',
          description:
            'socket.fetch() captures metadata from the request and accepts the server end with ctx.acceptWebSocket, the hibernation API. The metadata and an empty subscription go into the socket’s attachment.',
          stage: ['websockets', 'focus:websockets'],
          source: sourceFocus(
            accept,
            'const metadata = await this.#metadata?.(request);',
            'return new Response(null, { status: 101, webSocket: client });'
          ),
          durable: 'Nothing in SQLite.',
          volatile:
            'The attachment, kept by the runtime with the connection, even while the object is evicted.',
          status: 'normal',
        },
        {
          id: 'subscribe',
          title: 'Subscribe from a sequence',
          description:
            'The client sends the event names it wants and, after a reconnect, the last sequence it saw. The names are written into the attachment and the reply carries the current head sequence.',
          stage: ['focus:websockets'],
          source: sourceFocus(
            subscribe,
            'const attachment = readAttachment<Metadata>(ws);',
            'replayed,'
          ),
          durable: 'Retained event rows are read, not changed.',
          volatile: 'The subscribed names, in the attachment.',
          status: 'normal',
        },
        {
          id: 'call',
          title: 'Call an allowlisted handler',
          description:
            'webSocketMessage() looks the method up among the inbound keys, validates createTodo’s input with its schema, and passes the attachment’s metadata. Here the handler is a durable operation, so the result frame only means the operation was registered.',
          stage: ['durability', 'flow:call'],
          source: sourceFocus(
            call,
            'const handler = this.#inbound.get(frame.method);',
            "type: 'result',"
          ),
          durable:
            'A pending durability_calls row and the object alarm, committed before the result frame.',
          volatile: 'The inbound call itself is never stored.',
          status: 'commit',
        },
        {
          id: 'insert',
          title: 'The operation inserts the todo',
          description:
            'The durable handler writes the todo with INSERT OR IGNORE, so a repeated attempt after an eviction does not insert it twice.',
          stage: ['todos', 'focus:todos'],
          source: sourceFocus(
            todoList,
            "'INSERT OR IGNORE INTO todos (id, title, done) VALUES (?, ?, ?)',",
            'return payload;'
          ),
          durable: 'The todo row, then the completed operation row.',
          volatile: 'The running attempt.',
          status: 'commit',
        },
        {
          id: 'event',
          title: 'Store the created event',
          description:
            'The lifecycle hook calls this.socket.created(todo). The event is inserted with the next sequence before anything is sent, and rows older than the retention window are deleted.',
          stage: ['focus:events'],
          source: sourceFocus(
            publish,
            "'INSERT INTO durability_socket_events (name, payload, created_at) VALUES (?, ?, ?) RETURNING seq',",
            'seq - this.#retention'
          ),
          durable: 'The event row with its sequence.',
          volatile: 'The frame about to be sent.',
          status: 'commit',
        },
        {
          id: 'push',
          title: 'Push to every subscribed socket',
          description:
            'ctx.getWebSockets() returns every socket accepted by this object, including ones accepted by an earlier instance. Only open sockets whose attachment lists the event receive the frame.',
          stage: ['flow:push'],
          source: sourceFocus(
            publish,
            'for (const ws of this.#context.getWebSockets()) {',
            'sendFrame(ws, frame);'
          ),
          durable: 'Nothing new; delivery is not recorded per client.',
          volatile: 'The frames in flight.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'hibernation',
      title: 'Hibernate between messages',
      description:
        'What lets the runtime evict an idle object while browsers stay connected, and what a new instance needs to serve them.',
      steps: [
        {
          id: 'idle',
          title: 'Idle pings do not wake the object',
          description:
            'The client pings every 30 seconds by default. The runtime matches the ping text and sends the pong itself, so an idle list costs no object time.',
          stage: ['*', 'focus:websockets'],
          source: sourceFocus(
            construct,
            'this.#context.setWebSocketAutoResponse(',
            "JSON.stringify({ v: socketProtocolVersion, type: 'pong' })"
          ),
          durable: 'Event rows and the todos table.',
          volatile: 'Nothing in the object is needed to answer a ping.',
          status: 'normal',
        },
        {
          id: 'evicted',
          title: 'The runtime evicts the idle object',
          description:
            'Because the sockets were accepted with ctx.acceptWebSocket, the runtime can discard the instance while keeping the connections open. The socket helper and every other field go with it.',
          stage: ['focus:socket'],
          source: sourceFocus(
            accept,
            'this.#context.acceptWebSocket(server);',
            '} satisfies Attachment<Metadata | undefined>);'
          ),
          durable: 'SQLite tables and the object alarm.',
          volatile:
            'The instance is gone; the connections and their attachments remain with the runtime.',
          status: 'normal',
        },
        {
          id: 'wake',
          title: 'A frame starts a new instance',
          description:
            'When a browser sends a call, the runtime constructs a new TodoList, which constructs a new DurabilitySocket, and calls webSocketMessage(). Without this delegation, frames would reach no handler.',
          stage: ['focus:object'],
          source: sourceFocus(
            todoList,
            'override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {',
            'return this.socket.webSocketMessage(ws, message);'
          ),
          durable: 'The migration has already run; it is a no-op now.',
          volatile: 'A fresh helper with the same configuration.',
          status: 'recovery',
        },
        {
          id: 'metadata',
          title: 'Metadata comes back from the attachment',
          description:
            'The handler’s call.metadata is read from the socket’s attachment, so the user ID set at upgrade time is still there without authenticating again.',
          stage: ['focus:websockets'],
          source: sourceFocus(
            call,
            'metadata: readAttachment<never>(ws).metadata,'
          ),
          durable: 'Nothing is read from SQLite.',
          volatile: 'The attachment, which outlived the instance.',
          status: 'recovery',
        },
        {
          id: 'publish',
          title: 'Events reach sockets from the earlier instance',
          description:
            'A toggle publishes an updated event. getWebSockets() still lists the hibernated sockets and their attachments still hold the subscriptions, so no client has to resubscribe.',
          stage: ['flow:push'],
          source: sourceFocus(
            publish,
            'for (const ws of this.#context.getWebSockets()) {',
            'if (!readAttachment(ws).names.includes(name)) {'
          ),
          durable: 'The new event row.',
          volatile: 'Nothing was rebuilt to find the subscribers.',
          status: 'recovery',
        },
        {
          id: 'close',
          title: 'Closing needs no cleanup',
          description:
            'The runtime requires webSocketClose() for hibernatable sockets. Subscriptions live in the attachment, so the socket’s version does nothing, and nothing is left behind in SQLite.',
          stage: ['focus:object'],
          source: sourceFocus(
            message,
            'webSocketClose(_ws: WebSocket): void {}'
          ),
          durable: 'Event rows stay until retention trims them.',
          volatile: 'The connection and its attachment end together.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'reconnect',
      title: 'Lose the connection mid-call',
      description:
        'What the object keeps when a browser disconnects during a call, and what replay can and cannot restore.',
      steps: [
        {
          id: 'dropped',
          title: 'The connection drops before the result',
          description:
            'Assume createTodo registered its operation, but the connection closed before the result frame arrived. The socket keeps no record of inbound calls, so nothing will resend the result.',
          stage: ['*', 'flow:call'],
          source: sourceFocus(
            todoList,
            'input: z.object({ id: z.string(), payload: todoSchema }),',
            'handle: this.durability.createTodo,'
          ),
          durable:
            'The pending operation row and the object alarm are committed.',
          volatile: 'The result frame and the browser’s pending call.',
          status: 'failure',
        },
        {
          id: 'continues',
          title: 'The operation finishes without the socket',
          description:
            'The operation runs from Durability’s timer or, after an eviction, from the object alarm through the alarm() delegation. It does not depend on any connection.',
          stage: ['focus:durability'],
          source: sourceFocus(
            todoList,
            'override alarm(info?: AlarmInvocationInfo) {',
            'return this.durability.alarm(info);'
          ),
          durable: 'The todo row and the completed operation.',
          volatile: 'No socket is open for this browser.',
          status: 'recovery',
        },
        {
          id: 'stored',
          title: 'The event is stored while nobody listens',
          description:
            'Publication inserts the created event and trims old rows before checking whether any socket can receive it. Closed sockets are skipped; the row waits for a subscriber that asks for it.',
          stage: ['focus:events'],
          source: sourceFocus(
            publish,
            "'INSERT INTO durability_socket_events (name, payload, created_at) VALUES (?, ?, ?) RETURNING seq',",
            'if (ws.readyState !== WebSocket.OPEN) {'
          ),
          durable: 'The event row.',
          volatile: 'Nothing is sent.',
          status: 'commit',
        },
        {
          id: 'replay',
          title: 'Replay from the last sequence',
          description:
            'The client reconnects and subscribes with the last sequence it saw. Retained rows after it are sent in order, filtered to the subscribed names, and the reply says replayed: true.',
          stage: ['flow:push'],
          source: sourceFocus(
            subscribe,
            "'SELECT seq, name, payload FROM durability_socket_events WHERE seq > ? ORDER BY seq',",
            'payload: deserialize(row.payload),'
          ),
          durable: 'Rows are read, not changed.',
          volatile: 'The replayed frames.',
          status: 'recovery',
        },
        {
          id: 'resync',
          title: 'Too far behind: rebuild from a snapshot',
          description:
            'If the client sends no sequence, a sequence ahead of the head, or one whose next event (since + 1) is older than the oldest retained row, the reply says replayed: false. The client must call list(), which reads the todos table.',
          stage: ['focus:todos'],
          source: sourceFocus(
            subscribe,
            'if (since === undefined || since > head) {',
            'if (since + 1 < oldest) {'
          ),
          durable: 'The todos table is the source of truth.',
          volatile: 'Events older than retention are gone.',
          status: 'recovery',
        },
        {
          id: 'hook',
          title: 'The lifecycle hook is best effort',
          description:
            'The created event exists only because the hook ran after the operation committed. If publishing throws, the error is logged and nothing retries it: the todo exists, no event row does, and a caught-up client gets replayed: true without ever seeing it.',
          stage: ['focus:durability'],
          source: sourceFocus(
            todoList,
            'this.durability.lifecycle((lifecycleEvent) => {',
            'this.socket.created(lifecycleEvent.result);'
          ),
          durable: 'The todo row and the completed operation.',
          volatile:
            'The hook’s failure is only logged; a later snapshot shows the todo.',
          status: 'gap',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
