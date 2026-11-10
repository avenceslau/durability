import example from '../../../examples/image-jobs/worker.ts?raw';
import durability from '../../../packages/durability/src/operations/index.ts?raw';
import scheduler from '../../../packages/durability/src/scheduler/index.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/image-jobs/worker.ts';
const durabilityFile = 'packages/durability/src/operations/index.ts';
const schedulerFile = 'packages/durability/src/scheduler/index.ts';

const imageJobs = sourceExcerpt(
  example,
  exampleFile,
  'image-jobs',
  'ImageJobs Durable Object',
  'export class ImageJobs extends DurableObject<Env> {',
  '    return this.durability.alarm(info);\n  }'
);
const construct = sourceExcerpt(
  durability,
  durabilityFile,
  'construct',
  'Attach to the object storage',
  "    this.#engine.migrateSchema('operations', durabilityOperationMigrations);",
  '      runDue: (now) => this.#runDue(now),\n    });'
);
const register = sourceExcerpt(
  durability,
  durabilityFile,
  'register',
  'Register an operation',
  '  async #run(input: {',
  '    this.#engine.waitUntil(background, onError);\n  }'
);
const runDue = sourceExcerpt(
  durability,
  durabilityFile,
  'run-due',
  'Find due operations',
  '  async #runDue(now: number): Promise<void> {',
  '    });\n  }'
);
const transaction = sourceExcerpt(
  scheduler,
  schedulerFile,
  'transaction',
  'Write rows and the alarm together',
  '  async transaction<T>(write: (sql: SqlStorage) => T): Promise<T> {',
  '    return result;\n  }'
);
const reconcile = sourceExcerpt(
  scheduler,
  schedulerFile,
  'reconcile',
  'Set the object alarm',
  '  private async reconcile(',
  '    return timerTimes.length === 0 ? undefined : Math.min(...timerTimes);\n  }'
);
const alarm = sourceExcerpt(
  scheduler,
  schedulerFile,
  'alarm',
  'Keep the alarm alive after a failure',
  '  async alarm(info?: AlarmInvocationInfo): Promise<void> {',
  '    this.scheduleEarlyAlarm(Date.now() + delay);\n  }'
);
const runAlarm = sourceExcerpt(
  scheduler,
  schedulerFile,
  'run-alarm',
  'Hand off before the alarm wall-time limit',
  '  private async runAlarm(info?: AlarmInvocationInfo): Promise<void> {',
  '    await this.scheduleNextAlarm();\n  }'
);
const execute = sourceExcerpt(
  scheduler,
  schedulerFile,
  'execute',
  'Claim, run, and settle one attempt',
  '  startExecution(spec: ExecutionSpec, eagerPermit?: () => void): Promise<void> {',
  '    return execution;\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'operations',
  title: 'How Durability uses your Durable Object',
  summary:
    'Durability keeps every operation in the object’s SQLite storage and drives retries from the object’s single alarm. Step through a registration, then evict the object mid-attempt.',
  diagram: {
    canvas: { width: 1000, height: 900 },
    direction: 'down',
    routing: 'auto',
    flows: {
      register: { label: 'register an operation', color: 'blue' },
      run: { label: 'run an attempt', color: 'orange' },
      recover: { label: 'recover from the alarm', color: 'green' },
    },
    nodes: {
      caller: {
        rank: 0,
        row: 1,
        label: 'Worker',
        sublabel: 'fetch handler',
        icon: 'workers',
        tone: 'external',
      },
      object: {
        rank: 1,
        row: 1,
        label: 'ImageJobs',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      durability: {
        rank: 2,
        row: 1,
        label: 'Durability',
        sublabel: 'in memory',
        icon: 'shield',
      },
      handler: {
        rank: 3,
        row: 2,
        label: 'resizeImage',
        sublabel: 'your handler',
        icon: 'workers',
      },
      api: {
        rank: 4,
        row: 2,
        label: 'Image API',
        sublabel: 'external service',
        icon: 'browser',
        tone: 'external',
      },
      alarm: {
        rank: 3,
        row: 0,
        label: 'Object alarm',
        sublabel: 'ctx.storage.setAlarm',
        icon: 'clock',
      },
      sqlite: {
        rank: 3,
        row: 1,
        label: 'durability_calls',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
    },
    edges: [
      { from: 'caller', to: 'object', label: 'resize()', flow: 'register' },
      {
        from: 'object',
        to: 'durability',
        label: 'resizeImage()',
        flow: 'register',
      },
      {
        from: 'durability',
        to: 'sqlite',
        label: 'rows',
        flow: 'register',
      },
      {
        from: 'durability',
        to: 'alarm',
        label: 'setAlarm',
        flow: 'register',
      },
      {
        from: 'durability',
        to: 'handler',
        label: 'invoke(attempt)',
        flow: 'run',
      },
      {
        from: 'handler',
        to: 'api',
        label: 'Idempotency-Key: id',
        flow: 'run',
      },
      {
        from: 'alarm',
        to: 'object',
        label: 'alarm()',
        flow: 'recover',
        back: true,
      },
    ],
    groups: [
      {
        id: 'durable-object',
        label: 'One Durable Object',
        contains: ['object', 'durability', 'handler', 'alarm', 'sqlite'],
      },
    ],
  },
  details: {
    caller: {
      description:
        'Gets a stub with env.IMAGE_JOBS.getByName(imageId) and calls resize() over RPC. Every request for that image reaches the same object.',
      href: '/getting-started/',
      source: 'image-jobs',
    },
    object: {
      description:
        'Your class. Durability is one of its fields, so the helper is rebuilt whenever the runtime creates a new instance of the object. Its alarm() method must delegate to the helper.',
      href: '/primitives/operations/',
      source: 'image-jobs',
    },
    durability: {
      description:
        'The helper and its engine live only in this object instance: concurrency permits, the map of running attempts, and the in-memory timer for work due before the alarm. Eviction discards all of it.',
      href: '/primitives/scheduler/',
      source: 'register',
    },
    handler: {
      description:
        'Runs outside any storage transaction. It receives the stable operation ID, the attempt number, and an AbortSignal for the attempt timeout.',
      href: '/reference/retries/',
      source: 'image-jobs',
    },
    api: {
      description:
        'A separate service. It must deduplicate on the Idempotency-Key header, because Durability can only prove what it committed to its own storage.',
      href: '/reference/guarantees/',
      source: 'image-jobs',
    },
    alarm: {
      description:
        'A Durable Object has exactly one alarm. Durability sets it to the earliest pending row, never sooner than alarmMinDelayMs, so it survives eviction and brings the object back.',
      href: '/primitives/scheduler/',
      source: 'reconcile',
    },
    sqlite: {
      description:
        'One row per channel and operation ID in the object’s own SQLite storage: handler name, payload, generation, status, attempt, next retry time, error, and result.',
      href: '/reference/storage/',
      source: 'construct',
    },
  },
  excerpts: [
    imageJobs,
    construct,
    register,
    runDue,
    transaction,
    reconcile,
    alarm,
    runAlarm,
    execute,
  ],
  scenarios: [
    {
      id: 'register',
      title: 'Register and run an operation',
      description:
        'Follow one resize from the RPC call to a completed row in the object’s storage.',
      steps: [
        {
          id: 'field',
          title: 'The helper belongs to the object instance',
          description:
            'Durability is constructed with this.ctx, the object’s DurableObjectState, and joins the object’s one scheduler, creating it because no other helper has. It reads and writes only this object’s storage; another object has its own tables and its own alarm.',
          stage: ['object', 'durability', 'durable-object', 'focus:durability'],
          source: sourceFocus(
            imageJobs,
            'private readonly durability = new Durability({',
            'context: this.ctx,'
          ),
          durable: 'Nothing is written yet.',
          volatile:
            'The helper and its engine exist for this instance and are rebuilt after every eviction.',
          status: 'normal',
        },
        {
          id: 'migrate',
          title: 'Create tables in the object’s SQLite',
          description:
            'The constructor applies migrations synchronously through ctx.storage.sql, then registers its channel of durability_calls, default here, with the engine so alarm passes include its rows.',
          stage: ['sqlite', 'focus:sqlite'],
          source: sourceFocus(
            construct,
            "this.#engine.migrateSchema('operations'",
            'runDue: (now) => this.#runDue(now),'
          ),
          durable:
            'durability_calls and durability_memos exist in this object’s storage.',
          volatile:
            'The registration with the engine is in memory and repeats on each construction.',
          status: 'commit',
        },
        {
          id: 'rpc',
          title: 'A Worker calls the object',
          description:
            'The fetch handler reaches the object by name and calls resize(). The object turns that into a call on the generated resizeImage method.',
          stage: ['caller', 'flow:register'],
          source: sourceFocus(
            imageJobs,
            'resize(imageId: string, width: number) {',
            'payload: { imageId, width },'
          ),
          durable: 'Nothing is written until the transaction commits.',
          volatile: 'The RPC call is waiting on registration.',
          status: 'normal',
        },
        {
          id: 'insert',
          title: 'Insert the pending row',
          description:
            'The insert runs inside a storage transaction and is keyed by channel and ID. A repeated ID on the same channel with the same handler and payload is a no-op; a different payload throws instead of being dropped.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            register,
            'const { inserted, winner } = await this.#engine.transaction((sql) => {',
            'ON CONFLICT(channel, id) DO NOTHING'
          ),
          durable: 'A pending row with attempt 0 commits with the transaction.',
          volatile: 'The serialized payload is held only until the write.',
          status: 'commit',
        },
        {
          id: 'arm',
          title: 'Set the object alarm in the same transaction',
          description:
            'Before the transaction commits, the engine sets the object’s one alarm to the earliest pending row, but no sooner than alarmMinDelayMs (15 seconds by default). A row cannot commit without its alarm.',
          stage: ['alarm', '-alarm->object', 'focus:alarm'],
          source: sourceFocus(
            reconcile,
            'const target = Math.max(physicalNextAt, Date.now() + this.alarmMinDelayMs);',
            'await physicalAlarm.setAlarm(target);'
          ),
          durable: 'The alarm is stored with the row it serves.',
          volatile:
            'Work due sooner than the alarm uses an in-memory timer that only this instance has.',
          status: 'commit',
        },
        {
          id: 'eager',
          title: 'Start now if a permit is free',
          description:
            'The RPC call resolves after registration. If the engine has a free permit it starts the attempt in the background and passes the promise to ctx.waitUntil; otherwise the next timer or alarm pass picks the row up.',
          stage: ['handler', 'focus:handler'],
          source: sourceFocus(
            register,
            'const eagerPermit = this.#engine.tryAcquirePermit();',
            'this.#engine.waitUntil(background, onError);'
          ),
          durable: 'The pending row and the alarm are already committed.',
          volatile:
            'The permit and the background promise exist only in this instance.',
          status: 'normal',
        },
        {
          id: 'claim',
          title: 'Claim the attempt before the handler runs',
          description:
            'The engine increments the stored attempt count with a conditional UPDATE. If the attempt limit is reached, the operation fails instead of running.',
          stage: ['focus:sqlite'],
          source: sourceFocus(execute, 'const attempt = claimAttempt('),
          durable:
            'The attempt count is stored before any external effect can happen.',
          volatile:
            'The attempt is registered in the running-attempts map so the same ID cannot run twice in this instance.',
          status: 'commit',
        },
        {
          id: 'handler',
          title: 'The handler calls the image service',
          description:
            'The handler runs outside the storage transaction and forwards the operation ID as the idempotency key.',
          stage: ['api', 'flow:run'],
          source: sourceFocus(imageJobs, "headers: { 'Idempotency-Key': id },"),
          durable: 'The row stays pending while the request is in flight.',
          volatile: 'The fetch, its response, and the attempt timeout.',
          status: 'normal',
        },
        {
          id: 'settle',
          title: 'Store the result',
          description:
            'Completion and memo cleanup run in one synchronous transaction. The UPDATE only matches the same generation and attempt, so a late attempt cannot overwrite a newer one.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            execute,
            'const timestamp = this.transactionSync((sql) => {',
            'deleteMemos(sql, spec.table, key);'
          ),
          durable: 'The row is completed with its JSON result.',
          volatile: 'The permit is released and the running entry removed.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Evict the object mid-attempt',
      description:
        'An illustrative eviction while the image request is in flight, not execution of the example code.',
      steps: [
        {
          id: 'evicted',
          title: 'The object is evicted during the request',
          description:
            'Assume the image service accepts the resize, but the runtime evicts the object before the result is stored. Everything Durability kept in memory is gone.',
          stage: ['*', 'flow:run'],
          source: sourceFocus(
            imageJobs,
            'const response = await this.env.IMAGE_API.fetch('
          ),
          durable:
            'The row is still pending with attempt 1, and the object alarm is still set.',
          volatile:
            'Permits, the running-attempts map, timers, and the fetch promise are lost.',
          status: 'failure',
        },
        {
          id: 'wake',
          title: 'The alarm starts a new instance',
          description:
            'When the alarm fires, the runtime creates a new instance, which constructs a new Durability helper, and calls alarm(). Without this delegation, pending rows would not run again after an eviction.',
          stage: ['flow:recover'],
          source: sourceFocus(
            imageJobs,
            'alarm(info?: AlarmInvocationInfo) {',
            'return this.durability.alarm(info);'
          ),
          durable: 'The alarm, the row, and its attempt count.',
          volatile: 'A fresh helper with all permits free.',
          status: 'recovery',
        },
        {
          id: 'due',
          title: 'Read due rows from SQLite',
          description:
            'The alarm pass selects this channel’s pending rows whose retry time has passed. The interrupted operation is still pending, so it is selected.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            runDue,
            "WHERE channel = ? AND status = 'pending' AND next_attempt_at <= ?"
          ),
          durable: 'Rows are read, not changed.',
          volatile: 'The due list for this pass.',
          status: 'recovery',
        },
        {
          id: 'reclaim',
          title: 'Claim attempt 2 for the same ID',
          description:
            'The interrupted attempt still counts toward maxAttempts. The new attempt receives the same operation ID and payload from the row.',
          stage: ['focus:durability'],
          source: sourceFocus(execute, 'const attempt = claimAttempt('),
          durable: 'The stored attempt count becomes 2.',
          volatile: 'A new handler call replaces the lost one.',
          status: 'recovery',
        },
        {
          id: 'receiver',
          title: 'The image service must deduplicate',
          description:
            'The service already performed the first resize. Only its handling of the repeated Idempotency-Key prevents a second effect; nothing in the object can prove what the service committed.',
          stage: ['focus:api'],
          source: sourceFocus(imageJobs, "headers: { 'Idempotency-Key': id },"),
          durable:
            'Exactly-once effects require the receiver’s own deduplication record.',
          volatile: 'No in-memory state from the first attempt survived.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'alarm-limits',
      title: 'Work within alarm limits',
      description:
        'How Durability keeps pending work running when an alarm() call fails or runs long.',
      steps: [
        {
          id: 'failure',
          title: 'An alarm pass throws',
          description:
            'The runtime retries a failing alarm() only a few times and then drops it, which would strand pending rows. The engine catches the error and sets its own alarm alarmMinDelayMs later instead. It also retries the pass from an in-memory timer after 1 second, doubling with each failure in a row up to alarmMinDelayMs.',
          stage: ['*', 'focus:alarm'],
          source: sourceFocus(
            alarm,
            'if (!(await this.armFallbackAlarm())) {',
            'this.retryFailedRun();'
          ),
          durable: 'A new alarm time is written directly to storage.',
          volatile: 'The failed pass, its error, and the retry timer.',
          status: 'recovery',
        },
        {
          id: 'handoff',
          title: 'Hand off before the wall-time limit',
          description:
            'If due work is still running after alarmHandoffMs (14 minutes by default), the pass sets a new alarm and returns before the runtime’s alarm wall-time limit.',
          stage: ['flow:recover'],
          source: sourceFocus(
            runAlarm,
            'if (result === handoff) {',
            'await this.armForHandoff(Date.now());'
          ),
          durable: 'The next alarm is stored before the pass returns.',
          volatile:
            'Running attempts continue in this instance if it stays alive.',
          status: 'normal',
        },
        {
          id: 'transaction',
          title: 'Pending work always has an alarm',
          description:
            'Registration, retry scheduling, terminal failures, and purges go through this transaction, so a committed pending row always has the object alarm set for it. The in-memory timer is set only after the commit.',
          stage: ['flow:register'],
          source: sourceFocus(
            transaction,
            'const result = await this.storage.transaction(async (transaction) => {',
            'this.scheduleEarlyAlarm(nextPendingAt);'
          ),
          durable: 'Rows and the alarm commit together or not at all.',
          volatile: 'The in-memory timer for work due before the alarm.',
          status: 'commit',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
