import dashboard from '../../../examples/job-dashboard/dashboard.ts?raw';
import pipeline from '../../../examples/job-dashboard/pipeline.ts?raw';
import worker from '../../../examples/job-dashboard/worker.ts?raw';
import durability from '../../../packages/durability/src/operations/index.ts?raw';
import scheduler from '../../../packages/durability/src/scheduler/index.ts?raw';
import tracker from '../../../packages/durability/src/tracker/index.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const dashboardFile = 'examples/job-dashboard/dashboard.ts';
const pipelineFile = 'examples/job-dashboard/pipeline.ts';
const workerFile = 'examples/job-dashboard/worker.ts';
const durabilityFile = 'packages/durability/src/operations/index.ts';
const schedulerFile = 'packages/durability/src/scheduler/index.ts';
const trackerFile = 'packages/durability/src/tracker/index.ts';

const pipelineObject = sourceExcerpt(
  pipeline,
  pipelineFile,
  'pipeline',
  'Pipeline Durable Object',
  'export class Pipeline extends DurableObject<Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const dashboardObject = sourceExcerpt(
  dashboard,
  dashboardFile,
  'dashboard',
  'Dashboard Durable Object',
  'export class Dashboard extends DurableObject<Env> {',
  '    this.socket.webSocketClose(ws);\n  }'
);
const frontWorker = sourceExcerpt(
  worker,
  workerFile,
  'worker',
  'Front Worker',
  '  async fetch(request: Request, env: Env) {',
  '    });'
);
const construct = sourceExcerpt(
  tracker,
  trackerFile,
  'construct',
  'Resolve the sources once',
  '  readonly #sources: Array<[string, UntypedSource]>;',
  '    ]);\n  }'
);
const operationSource = sourceExcerpt(
  durability,
  durabilityFile,
  'operation-source',
  'Durability as a tracked source',
  '  #trackedSource(): UntypedSource {',
  '        this.#engine.watch(this.#table, id, () => listener()),\n    };\n  }'
);
const get = sourceExcerpt(
  tracker,
  trackerFile,
  'get',
  'Reacquire a handle by ID',
  '  /** Reacquires a handle by id, for example after an RPC disconnect. */',
  '    ) as unknown as TrackerHandle<Sources, Key>;\n  }'
);
const records = sourceExcerpt(
  tracker,
  trackerFile,
  'records',
  'Generations and plain records',
  'const resultFor = (',
  '});'
);
const wait = sourceExcerpt(
  tracker,
  trackerFile,
  'wait',
  'Subscribe, then read',
  '  #wait(',
  '      check();\n    });\n  }'
);
const watchers = sourceExcerpt(
  scheduler,
  schedulerFile,
  'watchers',
  'Settlement listeners live in memory',
  '  /** In-memory only: listeners never survive eviction. */',
  '      listener(completed);\n    }\n  }'
);
const settle = sourceExcerpt(
  scheduler,
  schedulerFile,
  'settle',
  'Notify after the completion commits',
  '        // One transaction: a failed memo cleanup must undo the completion, not orphan the memos.',
  '          this.notify(spec.table, key, row);'
);

export const walkthrough = validateWalkthrough({
  id: 'tracker',
  title: 'How DurabilityTracker uses your Durable Object',
  summary:
    'The tracker stores nothing: it reads the tables its sources already keep in the object’s SQLite storage and waits on in-memory settlement listeners. Wait for a job over RPC, lose the wait to an eviction, then serve a dashboard from a custom source.',
  diagram: {
    canvas: { width: 1040, height: 960 },
    direction: 'down',
    routing: 'auto',
    flows: {
      read: { label: 'read a record', color: 'blue' },
      wait: { label: 'wait over RPC', color: 'orange' },
      recover: { label: 'recover from the alarm', color: 'green' },
      push: { label: 'push to the dashboard', color: 'purple' },
      records: { label: 'serve records over a socket', color: 'red' },
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
      browser: {
        size: [184, 72],
        rank: 0,
        row: 2,
        label: 'Browser',
        sublabel: 'WebSocket',
        icon: 'browser',
        tone: 'external',
      },
      pipeline: {
        rank: 1,
        row: 0,
        label: 'Pipeline',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      dashboard: {
        rank: 1,
        row: 2,
        label: 'Dashboard',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      tracker: {
        rank: 2,
        row: 0,
        label: 'DurabilityTracker',
        sublabel: 'in memory',
        icon: 'shield',
      },
      'dashboard-tracker': {
        rank: 2,
        row: 2,
        label: 'DurabilityTracker',
        sublabel: 'custom source',
        icon: 'shield',
      },
      alarm: {
        rank: 4,
        row: 1,
        label: 'Object alarm',
        sublabel: 'ctx.storage.setAlarm',
        icon: 'clock',
      },
      durability: {
        rank: 3,
        row: 0,
        label: 'Durability',
        sublabel: 'source: jobs',
        icon: 'shield',
      },
      jobs: {
        rank: 3,
        row: 2,
        label: 'jobs',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      calls: {
        rank: 4,
        row: 0,
        label: 'durability_calls',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      fanout: {
        rank: 5,
        row: 1,
        label: 'DurabilityFanout',
        sublabel: 'durable push',
        icon: 'queues',
      },
    },
    edges: [
      {
        from: 'worker',
        to: 'pipeline',
        label: 'track().wait()',
        flow: 'wait',
      },
      {
        from: 'dashboard',
        to: 'pipeline',
        label: 'RPC',
        flow: 'wait',
      },
      {
        from: 'pipeline',
        to: 'tracker',
        label: "get('jobs', id)",
        flow: 'read',
      },
      {
        from: 'tracker',
        to: 'durability',
        label: 'get, watch',
        flow: 'read',
      },
      { from: 'durability', to: 'calls', label: 'rows', flow: 'read' },
      {
        from: 'alarm',
        to: 'pipeline',
        label: 'alarm()',
        flow: 'recover',
        back: true,
      },
      {
        from: 'durability',
        to: 'fanout',
        label: 'lifecycle',
        flow: 'push',
      },
      { from: 'fanout', to: 'jobs', label: 'ingest()', flow: 'push' },
      { from: 'browser', to: 'dashboard', label: 'work', flow: 'records' },
      {
        from: 'dashboard',
        to: 'dashboard-tracker',
        label: 'records()',
        flow: 'records',
      },
      {
        from: 'dashboard-tracker',
        to: 'jobs',
        label: 'list, watch',
        flow: 'records',
      },
    ],
    groups: [
      {
        id: 'pipeline-object',
        label: 'Pipeline Durable Object',
        contains: [
          'pipeline',
          'tracker',
          'durability',
          'calls',
          'alarm',
          'fanout',
        ],
      },
      {
        id: 'dashboard-object',
        label: 'Dashboard Durable Object',
        contains: ['dashboard', 'dashboard-tracker', 'jobs'],
      },
    ],
  },
  details: {
    worker: {
      description:
        'Registers an import, then calls track(orderId).wait() on the same Pipeline stub. Workers RPC pipelining sends the wait in the same round trip that returns the handle.',
      href: '/compositions/job-dashboard/',
      source: 'worker',
    },
    browser: {
      description:
        'Talks to the Dashboard over DurabilitySocket. Frames are JSON, so it receives plain records from records(), never handles with functions.',
      href: '/primitives/socket/',
      source: 'dashboard',
    },
    pipeline: {
      description:
        'Runs the jobs. The tracker is one of its fields next to Durability, so both are rebuilt whenever the runtime creates a new instance. Its alarm() delegates to the shared scheduler; the tracker itself needs no delegated method.',
      href: '/primitives/tracker/',
      source: 'pipeline',
    },
    dashboard: {
      description:
        'A second object with its own storage and its own tracker. Its jobs table is a projection fed by the Pipeline’s fanout, not the Pipeline’s records.',
      href: '/compositions/job-dashboard/',
      source: 'dashboard',
    },
    tracker: {
      description:
        'Holds only references to its sources, resolved once in the constructor. Handles, wait timers, and the listeners they install exist only in this instance; eviction or an RPC disconnect discards them.',
      href: '/primitives/tracker/',
      source: 'construct',
    },
    'dashboard-tracker': {
      description:
        'The same class over a custom TrackedSource: get and list read the jobs table, and watch keeps listeners in a Map on the Dashboard instance.',
      href: '/primitives/tracker/',
      source: 'dashboard',
    },
    alarm: {
      description:
        'The tracker never sets it. Durability’s scheduler does, for pending rows. After an eviction it brings the object back and the job settles, but nothing is waiting any more.',
      href: '/primitives/scheduler/',
      source: 'pipeline',
    },
    durability: {
      description:
        'A built-in source. It registers get, list, and watch for the tracker in an in-memory WeakMap, so the experimental contract never appears on its public type.',
      href: '/primitives/operations/',
      source: 'operation-source',
    },
    jobs: {
      description:
        'The Dashboard’s own SQLite table: one row per job ID with generation, status, and state. The Dashboard creates it in its constructor and writes it in ingest().',
      href: '/primitives/tracker/',
      source: 'dashboard',
    },
    calls: {
      description:
        'Durability’s table in the Pipeline’s SQLite storage. Every tracker read is a query against it; records stay until purgeBefore() removes them.',
      href: '/reference/storage/',
      source: 'operation-source',
    },
    fanout: {
      description:
        'Delivers lifecycle events to Dashboard.ingest() from rows in the Pipeline’s storage, retrying until ingest returns. The lifecycle hook that enqueues them is best effort.',
      href: '/primitives/fanout/',
      source: 'pipeline',
    },
  },
  excerpts: [
    pipelineObject,
    construct,
    operationSource,
    frontWorker,
    get,
    wait,
    watchers,
    settle,
    records,
    dashboardObject,
  ],
  scenarios: [
    {
      id: 'wait',
      title: 'Wait for a job over RPC',
      description:
        'Follow one wait from a Worker’s pipelined call to the settled state read back from the Pipeline’s storage.',
      steps: [
        {
          id: 'field',
          title: 'The tracker is a field of the object',
          description:
            'The Pipeline constructs the tracker with its Durability helper as the jobs source. The tracker has no context, no tables, and no alarm: everything it returns is read from its sources.',
          stage: [
            'pipeline',
            'tracker',
            'durability',
            'pipeline-object',
            'focus:tracker',
          ],
          source: sourceFocus(
            pipelineObject,
            'private readonly tracker = new DurabilityTracker({',
            'sources: { jobs: this.durability },'
          ),
          durable: 'Nothing; the tracker writes no storage.',
          volatile:
            'The tracker and its source list, rebuilt with the object instance.',
          status: 'normal',
        },
        {
          id: 'resolve',
          title: 'Durability hands over its source',
          description:
            'Durability registers get, list, and watch in a module-level WeakMap during construction. The tracker looks each source up there once; anything not registered must implement TrackedSource itself.',
          stage: ['focus:durability'],
          source: sourceFocus(
            construct,
            'this.#sources = Object.entries(config.sources).map(([key, input]) => [',
            'trackedSourceOf(input) ?? (input as UntypedSource),'
          ),
          durable: 'Nothing is written.',
          volatile:
            'The WeakMap entry and the resolved source functions, both in memory.',
          status: 'normal',
        },
        {
          id: 'table',
          title: 'Records are rows in the object’s SQLite',
          description:
            'The source’s get and list run SQL against its own channel’s rows of durability_calls through the engine’s ctx.storage.sql handle. A record is whatever that table holds right now.',
          stage: ['calls', 'focus:calls'],
          source: sourceFocus(
            operationSource,
            'get: async (id) => {',
            'return call && callRecord(sql, call);'
          ),
          durable:
            'One durability_calls row per channel and operation ID, kept until purgeBefore().',
          volatile: 'Nothing beyond the query results.',
          status: 'normal',
        },
        {
          id: 'rpc',
          title: 'A Worker asks for a handle and waits',
          description:
            'The Worker registers the import, then calls track(orderId).wait(). track() returns a handle from tracker.get; over Workers RPC its get and wait become stubs that call back into this Pipeline instance.',
          stage: ['worker', 'flow:wait'],
          source: sourceFocus(
            frontWorker,
            'await pipeline.importOrder(orderId);',
            'const outcome = await pipeline.track(orderId).wait({ timeoutMs: 10_000 });'
          ),
          durable: 'The pending row was committed by importOrder.',
          volatile: 'The RPC call and the stubs it holds.',
          status: 'normal',
        },
        {
          id: 'get',
          title: 'Build the handle from the current row',
          description:
            'tracker.get reads the record from the source and copies its contract fields, including the generation. get() and wait() are closures over this instance’s source.',
          stage: ['flow:read'],
          source: sourceFocus(
            get,
            'const record = await resolved.get(id);',
            'itemFor(key, record)'
          ),
          durable: 'The row is read, not changed.',
          volatile:
            'The handle’s closures, which only work while this instance lives.',
          status: 'normal',
        },
        {
          id: 'subscribe',
          title: 'Subscribe before the first read',
          description:
            'wait installs the source’s watch listener, starts the timeout timer, and only then reads. A settlement that commits between the read and the subscription cannot be missed.',
          stage: ['focus:tracker'],
          source: sourceFocus(
            wait,
            'unwatch = source.watch?.(entry.id, check);',
            'check();'
          ),
          durable: 'Still pending in durability_calls.',
          volatile:
            'A listener in the engine’s watchers map and a setTimeout for timeoutMs.',
          status: 'normal',
        },
        {
          id: 'settle',
          title: 'The attempt commits, then notifies',
          description:
            'When the attempt completes, the engine commits the completed row and only then calls notify. Durability’s watch ignores the row it is passed, so the tracker reads the source again.',
          stage: ['focus:durability'],
          source: sourceFocus(
            settle,
            'const timestamp = this.transactionSync((sql) => {',
            'this.notify(spec.table, key, row);'
          ),
          durable: 'The row is completed with its JSON result.',
          volatile: 'The listener runs once, then is removed.',
          status: 'commit',
        },
        {
          id: 'resolve-wait',
          title: 'The wait resolves with the settled state',
          description:
            'The re-read sees completed, so wait clears its timer, unsubscribes, and resolves. If the timeout had fired first, wait would resolve with the latest state instead, and the Worker would answer 202.',
          stage: ['focus:worker'],
          source: sourceFocus(
            frontWorker,
            'return Response.json(outcome, {',
            "status: outcome.status === 'pending' ? 202 : 200,"
          ),
          durable: 'The completed row stays until purgeBefore().',
          volatile: 'The timer, the listener, and the RPC call are gone.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Lose a wait to an eviction',
      description:
        'An illustrative reset of the Pipeline while a caller is waiting, not execution of the example code.',
      steps: [
        {
          id: 'reset',
          title: 'The object resets during a wait',
          description:
            'Assume a deploy or eviction resets the Pipeline while the Worker waits. The engine’s watchers map and the wait timer are gone, and the caller’s wait call fails instead of resolving.',
          stage: ['*', 'focus:tracker'],
          source: sourceFocus(
            watchers,
            '/** In-memory only: listeners never survive eviction. */'
          ),
          durable:
            'The row is still pending and the scheduler’s alarm is still set.',
          volatile: 'Listeners, timers, and the handle’s stubs are lost.',
          status: 'failure',
        },
        {
          id: 'wake',
          title: 'The alarm settles the job with nobody listening',
          description:
            'The alarm starts a new instance, whose alarm() delegates to the scheduler, and the job runs again. notify iterates the listeners for that ID, and the new instance has none.',
          stage: ['flow:recover'],
          source: sourceFocus(
            watchers,
            'for (const listener of this.watchers.get(tableOwner(table))?.get(key) ??',
            'listener(completed);'
          ),
          durable: 'The row is completed.',
          volatile: 'An empty watchers map in a fresh engine.',
          status: 'recovery',
        },
        {
          id: 'reacquire',
          title: 'The caller asks again by ID',
          description:
            'The tracker cannot resume a lost wait. The caller must call track(orderId) again, which reaches tracker.get on the new instance and builds a fresh handle from the stored row.',
          stage: ['flow:wait'],
          source: sourceFocus(
            get,
            '/** Reacquires a handle by id, for example after an RPC disconnect. */',
            'const record = await resolved.get(id);'
          ),
          durable: 'The completed row is read.',
          volatile: 'A new handle with new stubs.',
          status: 'recovery',
        },
        {
          id: 'already-settled',
          title: 'A settled record resolves at once',
          description:
            'The new wait subscribes and reads; the first read already sees completed, so it resolves without waiting for a notification or the timeout.',
          stage: ['flow:read'],
          source: sourceFocus(
            wait,
            'const resolveIfSettled = (result: AnyResult) => {',
            'finish(() => resolve(result));'
          ),
          durable: 'Nothing changes.',
          volatile: 'The listener is removed as the wait resolves.',
          status: 'recovery',
        },
        {
          id: 'not-found',
          title: 'The tracker keeps no copy of results',
          description:
            'A handle is bound to the generation it was built from. If purgeBefore() removed the row, or the ID was reused for new work, get and wait return not_found: the result exists only in the source’s table.',
          stage: ['focus:calls'],
          source: sourceFocus(
            records,
            'record?.generation === entry.generation',
            ": { status: 'not_found' };"
          ),
          durable: 'Whatever durability_calls still holds.',
          volatile: 'Nothing; there is no tracker cache to fall back on.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'dashboard',
      title: 'Serve a dashboard from a custom source',
      description:
        'The Dashboard object exposes its own table through a second tracker, fed by the Pipeline over RPC.',
      steps: [
        {
          id: 'table',
          title: 'The Dashboard owns a projection table',
          description:
            'The Dashboard creates a jobs table in its own SQLite storage. It is a separate object: the Pipeline’s durability_calls is not visible here.',
          stage: ['dashboard', 'jobs', 'dashboard-object', 'focus:jobs'],
          source: sourceFocus(
            dashboardObject,
            '`CREATE TABLE IF NOT EXISTS jobs (',
            'state TEXT NOT NULL'
          ),
          durable: 'The jobs table in the Dashboard’s storage.',
          volatile: 'Nothing yet.',
          status: 'commit',
        },
        {
          id: 'custom-source',
          title: 'The table becomes a TrackedSource',
          description:
            'get and list query the jobs table; watch adds listeners to a Map on the instance. The Dashboard passes this object to its own DurabilityTracker.',
          stage: ['dashboard-tracker', 'focus:dashboard-tracker'],
          source: sourceFocus(
            dashboardObject,
            'private readonly jobs: TrackedSource<Jobs> = {',
            'sources: { jobs: this.jobs },'
          ),
          durable: 'Rows in jobs.',
          volatile: 'The watchers Map, lost on eviction like the engine’s.',
          status: 'normal',
        },
        {
          id: 'snapshot',
          title: 'Browsers get plain records',
          description:
            'Socket frames are JSON, so the work request returns tracker.records(): the same page as list() with only the contract fields and no functions.',
          stage: ['browser', 'flow:records'],
          source: sourceFocus(
            dashboardObject,
            'work: {',
            '}) => this.tracker.records(query),'
          ),
          durable: 'The rows are read, not changed.',
          volatile: 'The page of records sent over the socket.',
          status: 'normal',
        },
        {
          id: 'import',
          title: 'An import waits across two objects',
          description:
            'A browser’s importOrder makes the Dashboard call the Pipeline over RPC: register, then wait on the returned handle for up to 30 seconds. The wait lives in the Pipeline instance.',
          stage: ['pipeline', 'tracker', 'pipeline-object', 'focus:dashboard'],
          source: sourceFocus(
            dashboardObject,
            'const pipeline = this.env.PIPELINE.getByName(this.tenant);',
            'return pipeline.track(orderId).wait({ timeoutMs: 30_000 });'
          ),
          durable: 'The pending row in the Pipeline’s durability_calls.',
          volatile:
            'Two RPC calls in flight and a listener in the Pipeline’s engine.',
          status: 'normal',
        },
        {
          id: 'push',
          title: 'The Pipeline pushes lifecycle events',
          description:
            'A lifecycle hook enqueues each change in the Pipeline’s fanout, which calls Dashboard.ingest() and retries until it returns. The Dashboard learns of changes only through these deliveries.',
          stage: ['durability', 'fanout', 'flow:push'],
          source: sourceFocus(
            pipelineObject,
            'this.env.DASHBOARD.getByName(this.tenant).ingest(',
            'ackOnReturn: true,'
          ),
          durable:
            'Fanout rows in the Pipeline’s storage until ingest returns.',
          volatile: 'The delivery call in flight.',
          status: 'normal',
        },
        {
          id: 'ingest',
          title: 'ingest writes the row, then wakes watchers',
          description:
            'ingest upserts the row, skipping a late pending over a settled row of the same generation, pushes a job event to sockets, and calls the watchers for that ID so a local tracker wait re-reads.',
          stage: ['focus:jobs'],
          source: sourceFocus(
            dashboardObject,
            'ON CONFLICT(id) DO UPDATE SET',
            'listener();'
          ),
          durable: 'The jobs row reflects the delivered state.',
          volatile: 'The socket event and the watcher callbacks.',
          status: 'commit',
        },
        {
          id: 'projection-gap',
          title: 'The projection is not the pipeline',
          description:
            'The lifecycle hook is best effort. If the Pipeline dies after a job settles but before the enqueue commits, that event never reaches the Dashboard, and its tracker keeps reporting pending until something reads the Pipeline’s own records. The example has no such resync.',
          stage: ['focus:fanout'],
          source: sourceFocus(
            pipelineObject,
            '// Lifecycle hooks are best-effort.',
            '// that gap matters.'
          ),
          durable: 'durability_calls is completed; jobs still says pending.',
          volatile: 'The lost hook call.',
          status: 'gap',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
