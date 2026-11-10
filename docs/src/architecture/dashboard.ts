import pipelineSource from '../../../examples/job-dashboard/pipeline.ts?raw';
import dashboardSource from '../../../examples/job-dashboard/dashboard.ts?raw';
import clientSource from '../../../examples/job-dashboard/client.ts?raw';
import workerSource from '../../../examples/job-dashboard/worker.ts?raw';
import socketSource from '../../../packages/durability/src/socket/index.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const pipelineFile = 'examples/job-dashboard/pipeline.ts';
const dashboardFile = 'examples/job-dashboard/dashboard.ts';
const socketFile = 'packages/durability/src/socket/index.ts';

const workerFetch = sourceExcerpt(
  workerSource,
  'examples/job-dashboard/worker.ts',
  'worker-fetch',
  'Route by tenant',
  'export default {',
  '  },\n};'
);
const operation = sourceExcerpt(
  pipelineSource,
  pipelineFile,
  'pipeline-operation',
  'Retained import operation and lifecycle results',
  'export class Pipeline extends DurableObject<Env> {',
  '    includeResults: true,\n  });'
);
const fanout = sourceExcerpt(
  pipelineSource,
  pipelineFile,
  'pipeline-fanout',
  'Durable delivery to the Dashboard',
  '  // Push side. Delivery is durable: the dashboard gets the batch again after',
  '    batchDelayMs: 100,\n  });'
);
const lifecycle = sourceExcerpt(
  pipelineSource,
  pipelineFile,
  'pipeline-lifecycle',
  'Best-effort lifecycle projection hook',
  '    this.durability.lifecycle((event) => {',
  '    });'
);
const enqueue = sourceExcerpt(
  pipelineSource,
  pipelineFile,
  'pipeline-enqueue',
  'Stable fanout delivery identity',
  '  private async publish(',
  '    ]);\n  }'
);
const importOrder = sourceExcerpt(
  pipelineSource,
  pipelineFile,
  'pipeline-import',
  'Register imports and delegate the alarm',
  '  /** Registers the import; resolves on acceptance, not completion. */',
  '    return this.scheduler.alarm(info);\n  }'
);
const ingest = sourceExcerpt(
  dashboardSource,
  dashboardFile,
  'dashboard-ingest',
  'SQL projection followed by socket publication',
  '  ingest(events: JobEvent[]): void {',
  '      this.socket.job(record);'
);
const clientSnapshot = sourceExcerpt(
  clientSource,
  'examples/job-dashboard/client.ts',
  'client-snapshot',
  'Browser snapshot reload and incremental events',
  '  const reload = async () => {',
  '  });'
);
const socketPublish = sourceExcerpt(
  socketSource,
  socketFile,
  'socket-publish',
  'Store an event, then send it',
  '  #publish(name: string, payload: unknown): void {',
  '      sendFrame(ws, frame);\n    }\n  }'
);
const socketReplay = sourceExcerpt(
  socketSource,
  socketFile,
  'socket-replay',
  'Replay or ask for a snapshot',
  '  #replay(',
  '    return true;\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'dashboard',
  title: 'Live dashboard projection',
  summary:
    'Each tenant has a Pipeline object that owns the import operations and a separate Dashboard object that owns a SQL read model. A best-effort lifecycle hook stages a durable fanout delivery between them; the browser rebuilds only from the Dashboard.',
  diagram: {
    canvas: { width: 1150, height: 900 },
    direction: 'right',
    routing: 'auto',
    flows: {
      import: { label: 'run an import', color: 'blue' },
      project: { label: 'project to the dashboard', color: 'orange' },
      alarm: { label: 'the Pipeline alarm', color: 'purple' },
      resync: { label: 'resynchronize the browser', color: 'green' },
    },
    nodes: {
      worker: {
        rank: 0,
        row: 0,
        label: 'Worker',
        sublabel: 'fetch handler',
        icon: 'workers',
        tone: 'external',
      },
      objectAlarm: {
        rank: 2,
        row: 0,
        label: 'Pipeline alarm',
        sublabel: 'ctx.storage.setAlarm',
        icon: 'clock',
      },
      pipeline: {
        rank: 1,
        row: 0,
        label: 'Pipeline',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      calls: {
        rank: 1,
        below: 'pipeline',
        row: 1,
        label: 'durability_calls',
        sublabel: 'import operations',
        icon: 'database',
      },
      orders: {
        rank: 0,
        row: 1,
        label: 'Orders API',
        sublabel: 'ORDERS binding',
        size: [215, 72],
        icon: 'browser',
        tone: 'external',
      },
      hook: {
        rank: 1,
        below: 'calls',
        row: 2,
        label: 'Lifecycle hook',
        sublabel: 'in memory',
        icon: 'shield',
      },
      fanout: {
        rank: 1,
        below: 'hook',
        row: 3,
        label: 'Fanout deliveries',
        sublabel: 'durability_fanout_*',
        icon: 'database',
      },
      dashboard: {
        rank: 1,
        below: 'fanout',
        row: 5,
        label: 'Dashboard',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      jobs: {
        rank: 2,
        row: 5,
        label: 'jobs',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      socket: {
        rank: 1,
        below: 'dashboard',
        row: 6,
        label: 'DurabilitySocket',
        sublabel: 'events + WebSockets',
        icon: 'database',
      },
      browser: {
        rank: 0,
        row: 6,
        label: 'Browser',
        sublabel: 'socket client',
        icon: 'browser',
        tone: 'external',
      },
    },
    edges: [
      {
        from: 'worker',
        to: 'pipeline',
        label: 'importOrder()',
        flow: 'import',
      },
      {
        from: 'pipeline',
        to: 'objectAlarm',
        label: 'alarm()',
        flow: 'alarm',
        both: true,
      },
      { from: 'pipeline', to: 'calls', label: 'register', flow: 'import' },
      {
        from: 'calls',
        to: 'orders',
        label: 'Idempotency-Key',
        flow: 'import',
        back: true,
      },
      {
        from: 'calls',
        to: 'hook',
        label: 'lifecycle event',
        flow: 'project',
      },
      { from: 'hook', to: 'fanout', label: 'enqueue()', flow: 'project' },
      {
        from: 'fanout',
        to: 'dashboard',
        label: 'ingest() RPC',
        flow: 'project',
      },
      { from: 'dashboard', to: 'jobs', label: 'upsert', flow: 'project' },
      {
        from: 'dashboard',
        to: 'socket',
        label: 'job event',
        flow: 'project',
      },
      {
        from: 'socket',
        to: 'browser',
        label: 'push, replay',
        flow: 'project',
        back: true,
      },
      { from: 'browser', to: 'dashboard', label: 'work()', flow: 'resync' },
    ],
    groups: [
      {
        id: 'pipeline-object',
        label: 'Pipeline per tenant',
        contains: ['objectAlarm', 'pipeline', 'calls', 'hook', 'fanout'],
      },
      {
        id: 'dashboard-object',
        label: 'Dashboard per tenant',
        contains: ['dashboard', 'jobs', 'socket'],
      },
    ],
  },
  details: {
    worker: {
      description:
        'Routes POST /tenants/:tenant/imports?order=:id to PIPELINE.getByName(tenant) and /ws upgrades to DASHBOARD.getByName(tenant). Both objects are named by the tenant.',
      href: '/compositions/job-dashboard/',
      source: 'worker-fetch',
    },
    objectAlarm: {
      description:
        'The Pipeline’s single alarm. Its one scheduler drives both the import operations and the fanout deliveries, and alarm() delegates to it. The Dashboard has no scheduler and no alarm.',
      href: '/primitives/scheduler/',
      source: 'pipeline-import',
    },
    pipeline: {
      description:
        'Owns import execution and results. Its fields build one scheduler from this.ctx, a Durability helper, a tracker over its operations, and a fanout to the Dashboard. Browsers never connect here.',
      href: '/primitives/operations/',
      source: 'pipeline-operation',
    },
    calls: {
      description:
        'The authoritative import:<orderId> rows and their results in the Pipeline’s SQLite storage. The tracker’s jobs source reads them; the Dashboard never does.',
      href: '/primitives/operations/',
      source: 'pipeline-import',
    },
    orders: {
      description:
        'A separate service. It receives the operation ID as Idempotency-Key and must honour it, because a retried attempt can repeat the request.',
      href: '/reference/guarantees/',
      source: 'pipeline-operation',
    },
    hook: {
      description:
        'A lifecycle callback in the Pipeline instance. It runs after a change commits, its promise rides on waitUntil, and a failure is only logged. It is not a durable handoff.',
      href: '/reference/lifecycle/',
      source: 'pipeline-lifecycle',
    },
    fanout: {
      description:
        'Fanout manifest and delivery rows in the Pipeline’s storage, keyed id:generation:status. A failed or interrupted ingest call is retried within the default budget of five attempts; an exhausted delivery is dropped, since no dead-letter queue is configured, and needs reconciliation.',
      href: '/primitives/fanout/',
      source: 'pipeline-fanout',
    },
    dashboard: {
      description:
        'Owns the read model and the WebSocket sessions. ingest() is called by the Pipeline’s fanout; socket RPC work() serves snapshots and importOrder() calls the Pipeline and waits on its tracker handle.',
      href: '/primitives/tracker/',
      source: 'dashboard-ingest',
    },
    jobs: {
      description:
        'The Dashboard’s own SQL projection, created in its constructor. Persistent, but not authoritative: it only holds what ingest() received.',
      href: '/primitives/tracker/',
      source: 'dashboard-ingest',
    },
    socket: {
      description:
        'Stores each outbound event in durability_socket_events (the last 1,000 by default) and sends it over hibernatable WebSockets accepted with ctx.acceptWebSocket. Subscriptions live in each socket’s attachment.',
      href: '/primitives/socket/',
      source: 'socket-publish',
    },
    browser: {
      description:
        'A local map, rebuilt from the Dashboard’s work() snapshot on first connect and whenever missed events could not be replayed.',
      href: '/primitives/client/',
      source: 'client-snapshot',
    },
  },
  excerpts: [
    workerFetch,
    operation,
    fanout,
    lifecycle,
    enqueue,
    importOrder,
    ingest,
    clientSnapshot,
    socketPublish,
    socketReplay,
  ],
  scenarios: [
    {
      id: 'projection',
      title: 'Normal projection handoffs',
      description:
        'Each handoff has its own owner and storage; the Dashboard’s SQL view is not the Pipeline’s operation record.',
      steps: [
        {
          id: 'tenant',
          title: 'One Pipeline per tenant',
          description:
            'The front Worker names the Pipeline after the tenant and calls importOrder() over RPC. The tenant’s Dashboard is a different object with its own storage and failure boundary.',
          stage: ['worker', 'pipeline', 'pipeline-object', 'flow:import'],
          source: sourceFocus(
            workerFetch,
            'const pipeline = env.PIPELINE.getByName(tenant);',
            'await pipeline.importOrder(orderId);'
          ),
          durable: 'Nothing is written yet.',
          volatile: 'The HTTP request waits on the RPC call.',
          status: 'normal',
        },
        {
          id: 'register',
          title: 'Register the import',
          description:
            'importOrder registers an operation with the stable ID import:<orderId> in durability_calls and resolves on acceptance, not completion. Repeating the import targets the same row.',
          stage: ['calls', 'focus:calls'],
          source: sourceFocus(
            importOrder,
            'return this.durability.importOrder({',
            'id: `import:${orderId}`,'
          ),
          durable: 'A pending import row commits with the Pipeline’s alarm.',
          volatile:
            'If a permit is free, the attempt starts in the background now.',
          status: 'commit',
        },
        {
          id: 'alarm',
          title: 'One scheduler, one alarm',
          description:
            'The Pipeline’s scheduler drives both its operations and its fanout from the object’s one alarm, and alarm() delegates to it. The Dashboard has no scheduler: SQL, its tracker source, and the socket need no background work.',
          stage: ['objectAlarm', 'flow:alarm'],
          source: sourceFocus(
            importOrder,
            'override alarm(info?: AlarmInvocationInfo) {',
            'return this.scheduler.alarm(info);'
          ),
          durable: 'The alarm is set for the earliest pending row.',
          volatile:
            'The scheduler and its permits are rebuilt with every new instance.',
          status: 'normal',
        },
        {
          id: 'fetch',
          title: 'Fetch the order with the operation ID',
          description:
            'The handler sends the operation ID as Idempotency-Key and passes the attempt’s abort signal. ORDERS must honour the key, because a retry can repeat the request.',
          stage: ['orders', 'focus:orders'],
          source: sourceFocus(
            operation,
            'const response = await this.env.ORDERS.fetch(',
            "{ headers: { 'Idempotency-Key': id }, signal }"
          ),
          durable: 'The import row stays pending while the request runs.',
          volatile: 'The fetch and its abort signal.',
          status: 'normal',
        },
        {
          id: 'retained-operation',
          title: 'Expose operation results to the hook',
          description:
            'Durability owns the import operation and its result. This option puts a completed summary on lifecycle events; it does not register anything itself.',
          stage: ['hook', 'focus:hook'],
          source: sourceFocus(operation, '    includeResults: true,'),
          durable:
            'The Pipeline retains the operation and its result under the stable import ID.',
          volatile:
            'Lifecycle hooks run in memory after the change commits; nothing records that they ran.',
          status: 'commit',
        },
        {
          id: 'lifecycle-selection',
          title: 'Select a projection state',
          description:
            'The hook maps registered to pending, a completed attempt with its result to completed, and a terminal failure to failed. A retryable failure emits retry_scheduled, which the hook ignores.',
          stage: ['focus:hook'],
          source: sourceFocus(
            lifecycle,
            "if (event.type === 'registered') {",
            "return this.publish(event, { status: 'failed', error: event.error });"
          ),
          durable:
            'The triggering registration or settlement has committed; after registered, the operation is still pending.',
          volatile:
            'The callback is best-effort work in the Pipeline instance.',
          status: 'normal',
        },
        {
          id: 'durable-fanout',
          title: 'Commit the fanout obligation',
          description:
            'The delivery ID includes operation ID, generation, and status, so a committed fanout message can be retried safely. The enqueue commits in the Pipeline’s storage and sets its alarm.',
          stage: ['fanout', 'focus:fanout'],
          source: sourceFocus(
            enqueue,
            'id: `${event.id}:${event.generation}:${state.status}`,',
            'state,'
          ),
          durable:
            'After enqueue commits, the fanout retries the delivery within its attempt budget; once exhausted, it is dropped without a dead-letter queue.',
          volatile:
            'The hook call that started the enqueue is not itself a durable handoff.',
          status: 'commit',
        },
        {
          id: 'deliver',
          title: 'Deliver over RPC to the Dashboard',
          description:
            'After up to 100 ms of batching, the fanout calls ingest() on the tenant’s Dashboard. With ackOnReturn the batch is acknowledged when ingest returns; a throw or an eviction uses one of five attempts and leaves the rows to be retried.',
          stage: ['dashboard', 'dashboard-object', 'focus:dashboard'],
          source: sourceFocus(
            fanout,
            'this.env.DASHBOARD.getByName(this.tenant).ingest(',
            'ackOnReturn: true,'
          ),
          durable:
            'The delivery rows stay in the Pipeline until the ack or until their attempts are exhausted.',
          volatile: 'The RPC call between the two objects.',
          status: 'normal',
        },
        {
          id: 'sql-and-socket',
          title: 'Project, then publish',
          description:
            'ingest upserts the Dashboard’s jobs table and only then emits the socket job event, with no await in between. The predicate stops a late pending event from overwriting a settled row of the same generation; a different generation always passes, so it is not a freshness order.',
          stage: ['jobs', 'socket', 'focus:dashboard'],
          source: sourceFocus(
            ingest,
            'ON CONFLICT(id) DO UPDATE SET',
            '      this.socket.job(record);'
          ),
          durable:
            'The jobs table and socket event history are Dashboard-owned storage, separate from the Pipeline.',
          volatile:
            'Watcher callbacks and current socket connections are in memory.',
          status: 'commit',
        },
        {
          id: 'browser-snapshot',
          title: 'Render the SQL snapshot',
          description:
            'On resync the client clears its map and pages work() records into it. Job events that arrive meanwhile write to the same map with no buffering or version check, so a page read before an event can overwrite it. The rebuilt map is not an atomic snapshot.',
          stage: ['browser', 'flow:resync'],
          source: sourceFocus(
            clientSnapshot,
            '    jobs.clear();',
            'record);\n    render([...jobs.values()]);\n  });'
          ),
          durable:
            'The snapshot comes from the Dashboard’s jobs table through its tracker records API.',
          volatile:
            'The browser map is rebuilt and can be discarded at any time.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'naive',
      title: 'Why a direct-push dashboard loses updates',
      description:
        'A naive version sends WebSocket messages straight from the lifecycle callback and treats the browser as the state store. There is no naive source here: each step shows the composition line that closes the gap.',
      steps: [
        {
          id: 'naive-push',
          title: 'Naive: push to browsers from the hook',
          description:
            'A naive hook sends to sockets directly, so an unreachable object or browser loses the update. Here the hook only enqueues a fanout message with a stable ID, and delivery to the Dashboard is retried from the Pipeline’s storage.',
          stage: ['*', 'focus:fanout'],
          source: sourceFocus(enqueue, 'await this.fanout.enqueue(['),
          durable: 'A delivery row per projection event.',
          volatile: 'Nothing is sent from the Pipeline to a browser.',
          status: 'commit',
        },
        {
          id: 'naive-store',
          title: 'Naive: the browser holds the only copy',
          description:
            'The naive browser keeps the only copy of job state. Here ingest upserts the jobs table in the Dashboard’s own storage, so the browser’s map can be thrown away.',
          stage: ['focus:jobs'],
          source: sourceFocus(
            ingest,
            'INSERT INTO jobs (id, name, generation, created_at, status, state)'
          ),
          durable: 'One projected row per job in the Dashboard.',
          volatile: 'The browser map is only a cache.',
          status: 'commit',
        },
        {
          id: 'naive-missed',
          title: 'Naive: a disconnected browser misses updates',
          description:
            'Here each job event is stored in durability_socket_events before it is sent, so a reconnecting client can replay what it missed while the event is still retained.',
          stage: ['focus:socket'],
          source: sourceFocus(
            socketPublish,
            "'INSERT INTO durability_socket_events (name, payload, created_at) VALUES (?, ?, ?) RETURNING seq',"
          ),
          durable: 'The last 1,000 events, by default.',
          volatile: 'Open WebSockets receive the frame immediately.',
          status: 'commit',
        },
        {
          id: 'naive-gap',
          title: 'One gap remains before the enqueue',
          description:
            'All three fixes start once the enqueue has committed. The hook itself is best effort; the “Lost projection before fanout commits” scenario steps through that gap.',
          stage: ['focus:hook'],
          source: sourceFocus(
            lifecycle,
            'this.durability.lifecycle((event) => {'
          ),
          durable: 'Nothing is stored until the enqueue commits.',
          volatile: 'The hook call can be lost with the instance.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'lost-projection',
      title: 'Lost projection before fanout commits',
      description:
        'A projection gap, not a failure of delivery after a fanout event has been committed.',
      steps: [
        {
          id: 'operation-settles',
          title: 'The operation settles first',
          description:
            'A completed operation has an authoritative retained result in durability_calls before the lifecycle hook tries to publish it.',
          stage: ['*', 'focus:calls'],
          source: sourceFocus(
            lifecycle,
            "        event.type === 'attempt_settled' &&",
            'event.result !== undefined'
          ),
          durable: 'The Pipeline has the completed operation result.',
          volatile: 'The hook has not enqueued anything yet.',
          status: 'commit',
        },
        {
          id: 'enqueue-gap',
          title: 'Eviction can lose the handoff',
          description:
            'If the Pipeline is evicted after settlement but before the enqueue commits, there is no fanout row to retry. The source comment names this lifecycle hook as best effort.',
          stage: ['focus:hook'],
          source: sourceFocus(
            enqueue,
            '    await this.fanout.enqueue([',
            '    ]);'
          ),
          durable: 'No fanout row exists in this failure window.',
          volatile: 'The interrupted hook call disappears with the instance.',
          status: 'gap',
        },
        {
          id: 'resync-is-projection-only',
          title: 'Resync reads only Dashboard state',
          description:
            'The client reacts to resync by calling work() and rebuilding its map. That cannot repair the missing event, because work() reads the Dashboard’s jobs table. The registered hook published pending separately, so the row is either absent or stuck at pending, depending on whether that earlier delivery arrived.',
          stage: ['flow:resync'],
          source: sourceFocus(
            clientSnapshot,
            '  conn.on.resync(() => void reload());'
          ),
          durable:
            'The job has no row or a stale pending row, and no completed socket event.',
          volatile:
            'The reconnect and the browser cache never consult the Pipeline.',
          status: 'recovery',
        },
        {
          id: 'reconciliation-needed',
          title: 'Reconciliation remains application work',
          description:
            'Production needs an explicit process that reads authoritative Pipeline history and idempotently writes missing rows into the projection. These source files do not implement it.',
          stage: ['focus:jobs'],
          source: sourceFocus(ingest, '      this.sql.exec(', '      );'),
          durable:
            'A reconciler would need to write the missing or stale Dashboard row itself.',
          volatile:
            'No client resync or fanout retry can invent an event that was never enqueued.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'recovery',
      title: 'Recover a dropped connection',
      description:
        'Fanout retries a failed ingest, and the socket replays or resynchronizes a browser that missed events.',
      steps: [
        {
          id: 'batch',
          title: 'Ingest returns or the batch is retried',
          description:
            'If ingest throws, or either object is evicted during the call, the fanout keeps the rows in the Pipeline and retries the batch, up to five attempts by default. An exhausted delivery is dropped because no dead-letter queue is configured, and only reconciliation can restore its projection. Once ingest returns, the batch is acknowledged.',
          stage: ['*', 'focus:fanout'],
          source: sourceFocus(
            fanout,
            'deliver: (messages) =>',
            'ackOnReturn: true,'
          ),
          durable:
            'Delivery rows stay until the ack commits or attempts run out.',
          volatile:
            'The RPC call can be lost; the rows stay within the attempt budget.',
          status: 'recovery',
        },
        {
          id: 'publish',
          title: 'Store the event, then send it',
          description:
            'Each job event gets a sequence number in durability_socket_events, events beyond the retention limit are deleted, and the frame goes to every open WebSocket subscribed to job.',
          stage: ['focus:socket'],
          source: sourceFocus(
            socketPublish,
            "'INSERT INTO durability_socket_events (name, payload, created_at) VALUES (?, ?, ?) RETURNING seq',",
            'seq - this.#retention'
          ),
          durable: 'The event and its sequence number.',
          volatile: 'The frame on each open WebSocket.',
          status: 'commit',
        },
        {
          id: 'drop',
          title: 'The connection drops',
          description:
            'While disconnected, the browser misses job events. The client remembers the last sequence number it saw; its map is only a cache.',
          stage: ['focus:browser'],
          source: sourceFocus(clientSnapshot, 'conn.on.job((record) => {'),
          durable: 'The Dashboard keeps storing events and rows.',
          volatile: 'Missed frames and the stale browser map.',
          status: 'failure',
        },
        {
          id: 'replay',
          title: 'Replay from the last sequence',
          description:
            'On reconnect the client subscribes with that sequence number. Retained events after it are replayed; if the next event it needs (since + 1) was already trimmed, or the sequence is ahead of the log, the subscription reports that replay was impossible.',
          stage: ['focus:socket'],
          source: sourceFocus(
            socketReplay,
            'if (since + 1 < oldest) {',
            'return false;'
          ),
          durable: 'Replay reads durability_socket_events.',
          volatile: 'The reconnecting socket’s subscription.',
          status: 'recovery',
        },
        {
          id: 'resync',
          title: 'Rebuild from the Dashboard snapshot',
          description:
            'On first connect and whenever replay was impossible, resync fires: the client pages work(), which reads tracker records over the jobs table, and rebuilds its map. Live job events land in the same map during the reload, so a stale page record can overwrite a newer event; the reload is not a race-free resync. It also cannot recover a missing enqueue.',
          stage: ['flow:resync'],
          source: sourceFocus(
            clientSnapshot,
            '  const reload = async () => {',
            '    render([...jobs.values()]);'
          ),
          durable: 'The snapshot is the Dashboard’s jobs table.',
          volatile: 'A new browser map.',
          status: 'recovery',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
