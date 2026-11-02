import browserExample from '../../../examples/realtime-todos/client.ts?raw';
import workerExample from '../../../examples/realtime-todos/worker.ts?raw';
import client from '../../../packages/durability/src/client.ts?raw';
import durability from '../../../packages/durability/src/durability.ts?raw';
import socket from '../../../packages/durability/src/socket.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const browserFile = 'examples/realtime-todos/client.ts';
const workerFile = 'examples/realtime-todos/worker.ts';
const clientFile = 'packages/durability/src/client.ts';
const durabilityFile = 'packages/durability/src/durability.ts';
const socketFile = 'packages/durability/src/socket.ts';

const openList = sourceExcerpt(
  browserExample,
  browserFile,
  'open-list',
  'Open a todo list in the browser',
  "const client = new DurabilitySocketClient<TodoList['socket']>({",
  '  };\n};'
);
const todoList = sourceExcerpt(
  workerExample,
  workerFile,
  'todo-list',
  'TodoList Durable Object',
  'export class TodoList extends DurableObject<Env> {',
  '    return this.durability.alarm(info);\n  }'
);
const upgrade = sourceExcerpt(
  workerExample,
  workerFile,
  'upgrade',
  'Authenticate and forward the upgrade',
  'export default {',
  '};'
);
const clientClass = sourceExcerpt(
  client,
  clientFile,
  'client',
  'One connection per object name',
  'export class DurabilitySocketClient<Socket extends AnySocketShape> {',
  '      close: () => connection.close(),\n    };\n  }'
);
const state = sourceExcerpt(
  client,
  clientFile,
  'state',
  'Connection state in browser memory',
  'class Connection {',
  '    this.#transforms = transforms;\n  }'
);
const close = sourceExcerpt(
  client,
  clientFile,
  'close',
  'Close the connection for good',
  '  close(): void {',
  '    this.#ws = undefined;\n  }'
);
const send = sourceExcerpt(
  client,
  clientFile,
  'send',
  'Queue a call with a local timeout',
  '  #send(method: string, input: unknown): Promise<unknown> {',
  '      this.#flush();\n    });\n  }'
);
const subscribe = sourceExcerpt(
  client,
  clientFile,
  'subscribe',
  'Subscribe and decide what to resync',
  '  #subscribe(): void {',
  "      this.#invoke(handler, { names: fresh }, 'resync');\n    }\n  }"
);
const flush = sourceExcerpt(
  client,
  clientFile,
  'flush',
  'Send each call once',
  '  #flush(): void {',
  '      this.#ws.send(pending.text);\n    }\n  }'
);
const open = sourceExcerpt(
  client,
  clientFile,
  'open',
  'Open the WebSocket',
  '  #connect(): void {',
  '      }\n    });\n  }'
);
const receive = sourceExcerpt(
  client,
  clientFile,
  'receive',
  'Handle frames from the object',
  '  #receive(text: string): void {',
  '    settle(pending);\n  }'
);
const disconnected = sourceExcerpt(
  client,
  clientFile,
  'disconnected',
  'Reject sent calls and back off',
  '  #disconnected(code: number): void {',
  '    this.close();\n  }'
);
const ping = sourceExcerpt(
  client,
  clientFile,
  'ping',
  'Keep-alive pings',
  '  #startPing(): void {',
  '    }, interval);\n  }'
);
const autoResponse = sourceExcerpt(
  socket,
  socketFile,
  'auto-response',
  'The runtime answers pings',
  '    // Keep-alive pings are answered by the runtime without waking a hibernated object.',
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
const replay = sourceExcerpt(
  socket,
  socketFile,
  'replay',
  'Subscribe and replay on the object',
  '  #subscribe(\n    ws: WebSocket,',
  '    return true;\n  }'
);
const register = sourceExcerpt(
  durability,
  durabilityFile,
  'register',
  'Register the durable operation',
  '  async #run(input: {',
  '    this.#engine.waitUntil(background, onError);\n  }'
);
const publish = sourceExcerpt(
  socket,
  socketFile,
  'publish',
  'Store and push an event',
  '  #publish(name: string, payload: unknown): void {',
  '      sendFrame(ws, frame);\n    }\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'client',
  title: 'How DurabilitySocketClient uses your Durable Object',
  summary:
    'The client keeps everything in browser memory and talks to one Durable Object over one WebSocket. The object stores the events it can replay; the client only remembers the last sequence it saw. Step through a call, a dropped connection, and the limits of a local timeout.',
  diagram: {
    canvas: { width: 1000, height: 900 },
    direction: 'down',
    routing: 'auto',
    flows: {
      connect: { label: 'open the connection', color: 'blue' },
      call: { label: 'calls and events', color: 'orange' },
      recover: { label: 'replay or resync', color: 'green' },
    },
    nodes: {
      app: {
        rank: 0,
        row: 0,
        label: 'Your page',
        sublabel: 'openList()',
        icon: 'browser',
        tone: 'external',
      },
      connection: {
        rank: 0,
        row: 1,
        label: 'Connection',
        sublabel: 'browser memory',
        icon: 'shield',
        size: [250, 72],
      },
      worker: {
        rank: 1,
        row: 2,
        label: 'Worker',
        sublabel: 'authenticates',
        icon: 'workers',
        tone: 'external',
      },
      object: {
        rank: 2,
        row: 2,
        label: 'TodoList',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      websockets: {
        rank: 2,
        row: 0,
        label: 'WebSocket',
        sublabel: 'attachment',
        icon: 'user',
        size: [230, 72],
      },
      socket: {
        rank: 3,
        row: 1,
        label: 'DurabilitySocket',
        sublabel: 'in memory',
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
      { from: 'app', to: 'connection', label: 'rpc', flow: 'call' },
      { from: 'connection', to: 'worker', label: 'upgrade', flow: 'connect' },
      {
        from: 'worker',
        to: 'object',
        label: 'stub.fetch()',
        flow: 'connect',
      },
      { from: 'object', to: 'socket', label: 'fetch()', flow: 'connect' },
      {
        from: 'connection',
        to: 'websockets',
        label: 'frames',
        flow: 'call',
      },
      {
        from: 'websockets',
        to: 'socket',
        label: 'message',
        flow: 'call',
      },
      {
        from: 'socket',
        to: 'connection',
        label: 'results, events',
        flow: 'call',
        back: true,
      },
      { from: 'socket', to: 'events', label: 'seq rows', flow: 'recover' },
      { from: 'socket', to: 'todos', label: 'list()', flow: 'recover' },
    ],
    groups: [
      {
        id: 'durable-object',
        label: 'One Durable Object',
        contains: ['object', 'websockets', 'socket', 'events', 'todos'],
      },
    ],
  },
  details: {
    app: {
      description:
        'Your browser code. It connects to one list by ID, subscribes to created and updated events, rebuilds from list() on resync, and calls createTodo and toggle.',
      href: '/primitives/client/',
      source: 'open-list',
    },
    connection: {
      description:
        'One connection to one Durable Object. Pending calls, event handlers, the last event sequence, the reconnect attempt, and its timers live only in this object in browser memory; a page reload loses all of it.',
      href: '/primitives/client/',
      source: 'state',
    },
    worker: {
      description:
        'Serves the URL the client builds. It authenticates the user, adds the user ID to the upgrade request, and forwards it to the list’s object with getByName(). After the upgrade, frames go to the object.',
      href: '/primitives/socket/',
      source: 'upgrade',
    },
    object: {
      description:
        'Your class. It must delegate fetch(), webSocketMessage(), and webSocketClose() to its DurabilitySocket field, and alarm() to durability.alarm() so its durable operations run after eviction. The client only ever talks to the socket methods.',
      href: '/primitives/socket/',
      source: 'todo-list',
    },
    websockets: {
      description:
        'The server end of the connection, accepted with ctx.acceptWebSocket. Its attachment holds the upgrade metadata and the subscribed event names, and the runtime keeps it while the object is evicted.',
      href: '/primitives/socket/',
      source: 'accept',
    },
    socket: {
      description:
        'The object-side helper. It runs inbound handlers by name, answers subscribe frames from the event table, and pushes each new event to subscribed sockets. It keeps no record of inbound calls.',
      href: '/primitives/socket/',
      source: 'replay',
    },
    events: {
      description:
        'durability_socket_events in the object’s SQLite storage. Every outbound event gets the next sequence number; the newest 1,000 by default are kept for replay.',
      href: '/reference/storage/',
      source: 'publish',
    },
    todos: {
      description:
        'The application’s own table. list() reads it, so it is the snapshot the page’s resync handler reloads when replay is not possible. The client never fetches a snapshot itself.',
      href: '/primitives/socket/',
      source: 'todo-list',
    },
  },
  excerpts: [
    openList,
    todoList,
    upgrade,
    clientClass,
    state,
    close,
    send,
    subscribe,
    flush,
    open,
    receive,
    disconnected,
    ping,
    autoResponse,
    accept,
    replay,
    register,
    publish,
  ],
  scenarios: [
    {
      id: 'call',
      title: 'Connect, subscribe, and call',
      description:
        'Follow one browser tab from connect() to a result and a pushed event.',
      steps: [
        {
          id: 'connect',
          title: 'One connection per object name',
          description:
            'connect(listId) builds the URL for that list’s object and returns typed rpc and on proxies. Nothing opens yet: the connection is lazy.',
          stage: ['app', 'connection', 'focus:connection'],
          source: sourceFocus(
            clientClass,
            'connect(id: string): SocketConnection<Socket> {',
            'const connection = new Connection(this.#config, id, this.#transforms);'
          ),
          durable: 'Nothing. The client has no storage.',
          volatile:
            'The connection, its handlers, and its pending calls, in browser memory.',
          status: 'normal',
        },
        {
          id: 'open',
          title: 'The first subscription opens the WebSocket',
          description:
            'Registering a resync handler only adds a local callback. Subscribing to created adds a handler for a new name, which tries to send a subscribe frame. Not yet connected, the connection sets its status to connecting and opens a WebSocket to the Worker.',
          stage: ['worker', 'flow:connect'],
          source: sourceFocus(
            open,
            "this.#setStatus('connecting');",
            'this.#ws = ws;'
          ),
          durable: 'Nothing.',
          volatile:
            'The WebSocket and a generation number that makes stale socket events ignored.',
          status: 'normal',
        },
        {
          id: 'forward',
          title: 'The Worker forwards the upgrade',
          description:
            'The URL points at your Worker, not at the object. It authenticates the user, adds the user ID to the request, and forwards the upgrade to the list’s object with getByName().',
          stage: ['object', 'flow:connect'],
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
          title: 'The object accepts a hibernatable socket',
          description:
            'The object’s fetch() delegates to DurabilitySocket, which accepts the server end with ctx.acceptWebSocket and stores the metadata and an empty subscription in the socket’s attachment.',
          stage: ['socket', 'websockets', 'durable-object', 'focus:websockets'],
          source: sourceFocus(
            accept,
            'this.#context.acceptWebSocket(server);',
            'names: [],'
          ),
          durable: 'Nothing in SQLite.',
          volatile:
            'The attachment, which the runtime keeps with the connection, even while the object is evicted.',
          status: 'normal',
        },
        {
          id: 'subscribe',
          title: 'Subscribe once the socket opens',
          description:
            'On open the connection sends every subscribed name, with since set to the last sequence it saw. On the first connection there is none, so since is left out.',
          stage: ['flow:call'],
          source: sourceFocus(
            subscribe,
            'const names = [...this.#handlers.keys()];',
            'this.#ws?.send(JSON.stringify(frame));'
          ),
          durable:
            'The object writes the names into the socket’s attachment, not SQLite.',
          volatile: 'The subscribe frame waiting for its reply.',
          status: 'normal',
        },
        {
          id: 'resync',
          title: 'No history yet: resync from a snapshot',
          description:
            'Without since, the object replies replayed: false with its head sequence. The client stores that sequence and fires resync for every name, and the page calls list(), which reads the todos table.',
          stage: ['events', 'todos', 'flow:recover'],
          source: sourceFocus(
            subscribe,
            'this.#lastSeq = frame.seq;',
            "this.#invoke(handler, { names: fresh }, 'resync');"
          ),
          durable: 'The head is MAX(seq) of the event table; nothing changes.',
          volatile: 'The last sequence and the names with history.',
          status: 'recovery',
        },
        {
          id: 'call',
          title: 'Send each call once',
          description:
            'rpc.createTodo() runs through the transforms and becomes a pending entry, marked unsent, with a two-minute timer. flush() sends every unsent entry and marks it sent, so no call is sent twice.',
          stage: ['focus:connection'],
          source: sourceFocus(
            flush,
            'for (const pending of this.#pending.values()) {',
            'this.#ws.send(pending.text);'
          ),
          durable: 'Nothing; the call frame is never stored on either side.',
          volatile: 'The pending call, its timer, and its promise.',
          status: 'normal',
        },
        {
          id: 'register',
          title: 'The object registers the operation',
          description:
            'webSocketMessage() runs the createTodo handler, durability.createTodo. One storage transaction inserts the operation row and reconciles the object alarm; the call returns once it commits, before the todo is written.',
          stage: ['focus:object'],
          source: sourceFocus(
            register,
            'const { inserted, winner } = await this.#engine.transaction((sql) => {',
            'return { inserted: created, winner: current };'
          ),
          durable: 'The operation row and the alarm, committed together.',
          volatile:
            'An attempt started in the background if a scheduler permit is free.',
          status: 'commit',
        },
        {
          id: 'result',
          title: 'The result frame settles the call',
          description:
            'The object replies with the call’s ID. The client removes the pending entry, clears its timer, and resolves the promise. For createTodo this only means the operation was registered, not that the todo exists.',
          stage: ['focus:connection'],
          source: sourceFocus(
            receive,
            "case 'result':",
            'this.#settle(frame, (pending) => pending.resolve(frame.output));'
          ),
          durable: 'Nothing on the client.',
          volatile: 'The pending entry and timer are removed.',
          status: 'normal',
        },
        {
          id: 'hook',
          title: 'Completion calls the lifecycle hook',
          description:
            'When the attempt completes, the scheduler commits the completion and then emits attempt_settled. In this trace the example’s hook passes the result to socket.created(). The hook is best effort: if it throws, or the object crashes after the completion commits, no created event is stored.',
          stage: ['focus:object'],
          source: sourceFocus(
            todoList,
            'this.durability.lifecycle((lifecycleEvent) => {',
            'this.socket.created(lifecycleEvent.result);'
          ),
          durable:
            'The todo and the completed operation, committed before the hook runs.',
          volatile: 'The lifecycle event, delivered once in memory.',
          status: 'normal',
        },
        {
          id: 'publish',
          title: 'Store the event, then push it',
          description:
            'socket.created() inserts the event with the next sequence, deletes rows beyond retention, and sends the frame to every open socket subscribed to created.',
          stage: ['focus:events'],
          source: sourceFocus(
            publish,
            'INSERT INTO durability_socket_events',
            'sendFrame(ws, frame);'
          ),
          durable: 'The event row, kept until retention trims it.',
          volatile: 'The event frame sent to subscribed sockets.',
          status: 'commit',
        },
        {
          id: 'event',
          title: 'Events carry their sequence',
          description:
            'The client records the event’s sequence as the last one it saw, then runs the created handlers.',
          stage: ['focus:connection'],
          source: sourceFocus(
            receive,
            "case 'event':",
            'this.#dispatch(frame.name, frame.payload);'
          ),
          durable: 'Nothing on the client.',
          volatile: 'The last sequence, now the event’s.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'disconnect',
      title: 'Lose the connection mid-call',
      description:
        'An illustrative drop while createTodo is in flight: what the client rejects, what the object kept, and what replay restores.',
      steps: [
        {
          id: 'dropped',
          title: 'Sent calls reject without replay',
          description:
            'The socket closes before the result arrives. Every call already sent rejects with SocketConnectionLostError, because the object may already have run it. Unsent calls stay queued.',
          stage: ['*', 'focus:connection'],
          source: sourceFocus(
            disconnected,
            'for (const [id, pending] of this.#pending) {',
            'pending.reject(new SocketConnectionLostError(pending.method));'
          ),
          durable:
            'On the object, the operation row and alarm may already be committed.',
          volatile: 'The result frame and the rejected call’s promise.',
          status: 'failure',
        },
        {
          id: 'stored',
          title: 'The object stores events nobody receives',
          description:
            'The operation finishes inside the object, independent of any socket. In this trace the completion hook stores its created event with a sequence; the push loop skips sockets that are no longer open.',
          stage: ['focus:events'],
          source: sourceFocus(
            publish,
            'for (const ws of this.#context.getWebSockets()) {',
            'continue;'
          ),
          durable:
            'The todo, the completed operation, and the event row if the hook ran.',
          volatile: 'Nothing is sent to this tab.',
          status: 'commit',
        },
        {
          id: 'backoff',
          title: 'Reconnect with jittered backoff',
          description:
            'The connection waits jitter(exponential(attempt, 250, 60000)): 125 to 250 ms after the first drop, up to 30 to 60 s. Queued calls do not open a socket early.',
          stage: ['focus:connection'],
          source: sourceFocus(
            disconnected,
            "this.#setStatus('disconnected');",
            'jitter(exponential(this.#attempt, 250, 60_000))'
          ),
          durable: 'Nothing.',
          volatile: 'The attempt count and the retry timer.',
          status: 'recovery',
        },
        {
          id: 'reopen',
          title: 'Resubscribe, then send queued calls',
          description:
            'The new socket goes through the Worker and fetch() again. On open the attempt count resets, the subscribe frame carries since, and unsent calls are sent once.',
          stage: ['flow:connect'],
          source: sourceFocus(open, 'this.#attempt = 0;', 'this.#startPing();'),
          durable: 'A new socket attachment on the object.',
          volatile: 'The last sequence survived in the connection.',
          status: 'recovery',
        },
        {
          id: 'replay',
          title: 'Replay the missed events',
          description:
            'The object sends retained rows after since, filtered to the subscribed names, and replies replayed: true. The client fires resync only for names it had not subscribed to before.',
          stage: ['focus:events'],
          source: sourceFocus(
            subscribe,
            'const fresh = frame.replayed',
            'return;'
          ),
          durable: 'Event rows are read, not changed.',
          volatile: 'The replayed events update the page.',
          status: 'recovery',
        },
        {
          id: 'no-event',
          title: 'A missed hook leaves nothing to replay',
          description:
            'Had the hook thrown, or the object crashed after the completion committed, there would be no event row for this todo. The event log has no gap, so replay succeeds without it and no resync fires; the page does not show the todo until a later resync calls list().',
          stage: ['focus:object'],
          source: sourceFocus(
            todoList,
            'this.durability.lifecycle((lifecycleEvent) => {',
            'this.socket.created(lifecycleEvent.result);'
          ),
          durable:
            'The todo and the completed operation, without an event row.',
          volatile: 'The lifecycle event, which was never stored.',
          status: 'gap',
        },
        {
          id: 'gap',
          title: 'Too far behind: rebuild from list()',
          description:
            'If since is ahead of the head, or the event right after since has been trimmed (since + 1 is below the oldest retained sequence), the object replies replayed: false. The client fires resync for every name, and the page reloads from the todos table.',
          stage: ['focus:todos'],
          source: sourceFocus(
            replay,
            'if (since === undefined || since > head) {',
            'if (since + 1 < oldest) {'
          ),
          durable: 'The todos table is the source of truth.',
          volatile: 'Events older than retention are gone.',
          status: 'recovery',
        },
        {
          id: 'retry',
          title: 'Retrying the lost call is up to you',
          description:
            'The client never resends a rejected call. Here create() makes new IDs each time, so calling it again after SocketConnectionLostError can create a second todo. A safe retry reuses the same operation ID and payload.',
          stage: ['focus:app'],
          source: sourceFocus(
            openList,
            'create: (title: string) =>',
            'payload: { id: crypto.randomUUID(), title, done: false },'
          ),
          durable: 'A second call with fresh IDs is a new operation.',
          volatile: 'The page cannot tell whether the first call ran.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'limits',
      title: 'Timeouts, keep-alive, and close',
      description:
        'What a local timeout does not do, how an idle object hibernates, and when the client stops reconnecting.',
      steps: [
        {
          id: 'timeout',
          title: 'A timeout is not cancellation',
          description:
            'After timeoutMs (two minutes by default) the call is removed and rejects with SocketTimeoutError. Nothing is sent to the object; a handler already running keeps running.',
          stage: ['*', 'focus:connection'],
          source: sourceFocus(
            send,
            'timer: setTimeout(',
            'reject(new SocketTimeoutError(method, this.#config.timeoutMs));'
          ),
          durable: 'Whatever the handler commits on the object stays.',
          volatile: 'The pending entry, removed locally.',
          status: 'gap',
        },
        {
          id: 'late',
          title: 'A late result is dropped',
          description:
            'If the result arrives after the timeout, no pending entry matches its ID and the frame is ignored. The page never learns the outcome from this call.',
          stage: ['flow:call'],
          source: sourceFocus(
            receive,
            'const pending = this.#pending.get(frame.id);',
            'return;'
          ),
          durable: 'The object’s outcome is in its own storage.',
          volatile: 'The result frame is discarded.',
          status: 'gap',
        },
        {
          id: 'ping',
          title: 'Keep-alive pings detect a dead socket',
          description:
            'The client pings every 30 seconds by default. If, when the timer fires, nothing at all has arrived for more than two intervals, it closes the socket with code 4000 and takes the reconnect path.',
          stage: ['flow:call'],
          source: sourceFocus(
            ping,
            'this.#pingTimer = setInterval(() => {',
            'this.#ws?.send(pingText);'
          ),
          durable: 'Nothing.',
          volatile: 'The ping timer and the time anything last arrived.',
          status: 'normal',
        },
        {
          id: 'pong',
          title: 'The runtime answers without the object',
          description:
            'DurabilitySocket registers the ping and pong text as an auto-response, so the runtime replies itself and an idle object can stay evicted while the tab stays connected.',
          stage: ['focus:websockets'],
          source: sourceFocus(
            autoResponse,
            'this.#context.setWebSocketAutoResponse(',
            "JSON.stringify({ v: socketProtocolVersion, type: 'pong' })"
          ),
          durable: 'Nothing.',
          volatile: 'No object instance is needed.',
          status: 'normal',
        },
        {
          id: 'hibernate',
          title: 'Eviction is invisible to the client',
          description:
            'The runtime can evict the object while the socket stays open, and auto-answered pings do not wake it. The next other frame starts a new instance, which must delegate webSocketMessage(); subscriptions come back from the attachment, so the client does not resubscribe.',
          stage: ['focus:object'],
          source: sourceFocus(
            todoList,
            'override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {',
            'this.socket.webSocketClose(ws);'
          ),
          durable: 'Event rows, the todos table, and the attachment.',
          volatile: 'The object instance, rebuilt on the next frame.',
          status: 'recovery',
        },
        {
          id: 'protocol',
          title: 'Protocol errors stop reconnecting',
          description:
            'An invalid frame from the object rejects every pending call with SocketProtocolError. If the object closes with code 4002 because it could not parse a frame, sent calls first reject with SocketConnectionLostError and unsent calls with SocketProtocolError. Either way the connection closes and does not reconnect: a retry cannot fix a protocol mismatch.',
          stage: ['focus:socket'],
          source: sourceFocus(
            disconnected,
            '#abandon(error: SocketProtocolError): void {',
            'this.close();'
          ),
          durable: 'Nothing changes on the object.',
          volatile: 'All pending calls, sent or not, are rejected.',
          status: 'failure',
        },
        {
          id: 'close',
          title: 'close() ends the connection',
          description:
            'close() stops the timers, rejects pending calls with SocketClosedError, drops every handler, and closes with code 1000. On the object, webSocketClose() has nothing to clean up.',
          stage: ['focus:connection'],
          source: sourceFocus(
            close,
            "this.#setStatus('closed');",
            "this.#ws?.close(1000, 'Client closed');"
          ),
          durable: 'Event rows stay until retention trims them.',
          volatile: 'Everything the connection held.',
          status: 'normal',
        },
        {
          id: 'reload',
          title: 'A page reload starts from nothing',
          description:
            'All of this state is fields on one object in browser memory. After a reload the last sequence is gone, so the first subscribe resyncs everything, and calls that were pending get no answer.',
          stage: ['focus:connection'],
          source: sourceFocus(
            state,
            'readonly #pending = new Map<string, PendingCall>();',
            '#lastSeq: number | undefined;'
          ),
          durable: 'The object’s tables are unaffected.',
          volatile: 'Pending calls, handlers, and the last sequence.',
          status: 'gap',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
