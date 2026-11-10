import example from '../../../examples/subscription-renewals/worker.ts?raw';
import durability from '../../../packages/durability/src/operations/index.ts?raw';
import durabilityAlarms from '../../../packages/durability/src/alarms/index.ts?raw';
import scheduler from '../../../packages/durability/src/scheduler/index.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/subscription-renewals/worker.ts';
const durabilityFile = 'packages/durability/src/operations/index.ts';
const alarmsFile = 'packages/durability/src/alarms/index.ts';
const schedulerFile = 'packages/durability/src/scheduler/index.ts';

const subscription = sourceExcerpt(
  example,
  exampleFile,
  'subscription',
  'Subscription Durable Object',
  'export class Subscription extends DurableObject<Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const construct = sourceExcerpt(
  durabilityAlarms,
  alarmsFile,
  'construct',
  'Attach to the object storage',
  "    this.#engine.migrateSchema('namedAlarms', durabilityNamedAlarmMigrations);",
  '      runDue: (now, info) => this.#runDue(now, info),\n    });'
);
const schedule = sourceExcerpt(
  durabilityAlarms,
  alarmsFile,
  'schedule',
  'Schedule or replace an occurrence',
  '  async #schedule(name: string, scheduledTime: number): Promise<void> {',
  '      scheduledTime,\n    });\n  }'
);
const cancel = sourceExcerpt(
  durabilityAlarms,
  alarmsFile,
  'cancel',
  'Cancel a pending occurrence',
  '  async #cancel(name: string): Promise<boolean> {',
  '    return true;\n  }'
);
const runDue = sourceExcerpt(
  durabilityAlarms,
  alarmsFile,
  'run-due',
  'Find due occurrences',
  '  async #runDue(',
  '      throw failures[0];\n    }\n  }'
);
const execute = sourceExcerpt(
  durabilityAlarms,
  alarmsFile,
  'execute',
  'Run one attempt of an occurrence',
  '  #execute(',
  '        isErrorInstance(error, DurableAlarmTimeoutError) && !retryTimeouts,\n    });\n  }'
);
const reconcile = sourceExcerpt(
  scheduler,
  schedulerFile,
  'reconcile',
  'Set the object alarm',
  '  private async reconcile(',
  '    return timerTimes.length === 0 ? undefined : Math.min(...timerTimes);\n  }'
);
const register = sourceExcerpt(
  durability,
  durabilityFile,
  'register',
  'Register the charge operation',
  '  async #run(input: {',
  '    this.#engine.waitUntil(background, onError);\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'alarms',
  title: 'How DurabilityAlarms uses your Durable Object',
  summary:
    'DurabilityAlarms keeps one row per alarm name in the object’s SQLite storage and serves every name from the object’s single alarm. Step through a monthly renewal, evict the object mid-renewal, then replace and cancel an occurrence.',
  diagram: {
    canvas: { width: 1000, height: 980 },
    direction: 'down',
    routing: 'auto',
    flows: {
      schedule: { label: 'schedule an occurrence', color: 'blue' },
      run: { label: 'run a due occurrence', color: 'orange' },
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
        label: 'Subscription',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      alarms: {
        rank: 2,
        row: 1,
        label: 'DurabilityAlarms',
        sublabel: 'in memory',
        icon: 'shield',
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
        label: 'durability_alarms',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      renew: {
        rank: 3,
        row: 2,
        label: 'renew',
        sublabel: 'your handler',
        icon: 'workers',
      },
      durability: {
        rank: 4,
        row: 2,
        label: 'Durability',
        sublabel: 'chargeInvoice',
        icon: 'shield',
      },
      payments: {
        rank: 5,
        row: 2,
        label: 'Payments',
        sublabel: 'external service',
        icon: 'browser',
        tone: 'external',
      },
    },
    edges: [
      { from: 'caller', to: 'object', label: 'subscribe()', flow: 'schedule' },
      { from: 'object', to: 'alarms', label: 'renew(at)', flow: 'schedule' },
      { from: 'alarms', to: 'sqlite', label: 'upsert', flow: 'schedule' },
      { from: 'alarms', to: 'alarm', label: 'setAlarm', flow: 'schedule' },
      { from: 'alarms', to: 'renew', label: 'invoke', flow: 'run' },
      {
        from: 'renew',
        to: 'durability',
        label: 'chargeInvoice()',
        flow: 'run',
      },
      {
        from: 'durability',
        to: 'payments',
        label: 'Idempotency-Key',
        flow: 'run',
      },
      {
        from: 'alarm',
        to: 'object',
        label: 'alarm()',
        flow: 'run',
        back: true,
      },
    ],
    groups: [
      {
        id: 'durable-object',
        label: 'One Durable Object',
        contains: [
          'object',
          'alarms',
          'alarm',
          'sqlite',
          'renew',
          'durability',
        ],
      },
    ],
  },
  details: {
    caller: {
      description:
        'Gets a stub with env.SUBSCRIPTIONS.getByName(customerId) and calls subscribe() over RPC, so every request for one customer reaches the same object.',
      href: '/getting-started/',
      source: 'subscription',
    },
    object: {
      description:
        'Your class. The scheduler and both helpers are fields, so they are rebuilt whenever the runtime creates a new instance. Its alarm() method must delegate to the scheduler or to any helper’s alarm(), which all run the same pass.',
      href: '/primitives/alarms/',
      source: 'subscription',
    },
    alarms: {
      description:
        'Turns each handler name into a scheduling method. In memory it holds only the map of running occurrences (one per name) and their abort controllers; permits and timers belong to the scheduler. Eviction discards all of it.',
      href: '/primitives/scheduler/',
      source: 'execute',
    },
    alarm: {
      description:
        'The object’s single alarm, shared with Durability through the scheduler. It is set to the earliest pending row of any helper, never sooner than alarmMinDelayMs, so it survives eviction and brings the object back.',
      href: '/primitives/scheduler/',
      source: 'reconcile',
    },
    sqlite: {
      description:
        'One row per channel and alarm name in the object’s own SQLite storage: generation, scheduled time, attempt, next retry time, status, and error. Success deletes the row, so no history is kept.',
      href: '/reference/storage/',
      source: 'construct',
    },
    renew: {
      description:
        'Runs outside any storage transaction with the occurrence’s idempotencyKey, scheduled time, attempt number, and an AbortSignal for the attempt timeout.',
      href: '/reference/identity/',
      source: 'execute',
    },
    durability: {
      description:
        'A Durability helper on the same scheduler. chargeInvoice is a separate durable operation with its own row in durability_calls and its own retries, independent of the alarm occurrence.',
      href: '/primitives/operations/',
      source: 'register',
    },
    payments: {
      description:
        'A separate service. It must deduplicate on the Idempotency-Key header; nothing in the object can prove what the service committed.',
      href: '/reference/guarantees/',
      source: 'subscription',
    },
  },
  excerpts: [
    subscription,
    construct,
    schedule,
    reconcile,
    runDue,
    execute,
    register,
    cancel,
  ],
  scenarios: [
    {
      id: 'renewal',
      title: 'Schedule and run a renewal',
      description:
        'Follow one subscription from the RPC call to a renewal that charges the customer and schedules the next one.',
      steps: [
        {
          id: 'field',
          title: 'The helper belongs to the object instance',
          description:
            'DurabilityAlarms is constructed with the object’s shared DurabilityScheduler, which wraps this.ctx. It reads and writes only this object’s storage; another subscription object has its own rows and its own alarm.',
          stage: ['object', 'alarms', 'durable-object', 'focus:alarms'],
          source: sourceFocus(
            subscription,
            'private readonly alarms = new DurabilityAlarms({',
            'scheduler: this.scheduler,'
          ),
          durable: 'Nothing is written yet.',
          volatile:
            'The helper, its map of running occurrences, and the scheduler are rebuilt after every eviction.',
          status: 'normal',
        },
        {
          id: 'migrate',
          title: 'Create the table in the object’s SQLite',
          description:
            'The constructor applies migrations synchronously through ctx.storage.sql, then registers its channel of durability_alarms, default here, with the scheduler so every alarm pass looks for its due names.',
          stage: ['sqlite', 'focus:sqlite'],
          source: sourceFocus(
            construct,
            "this.#engine.migrateSchema('namedAlarms'",
            'runDue: (now, info) => this.#runDue(now, info),'
          ),
          durable:
            'durability_alarms and durability_memos exist in this object’s storage.',
          volatile:
            'The registration with the scheduler is in memory and repeats on each construction.',
          status: 'commit',
        },
        {
          id: 'rpc',
          title: 'A Worker subscribes the customer',
          description:
            'subscribe() stores the customer ID, then calls the generated renew method with a time 30 days out. These are two separate writes, not one transaction.',
          stage: ['caller', 'flow:schedule'],
          source: sourceFocus(
            subscription,
            'async subscribe(customerId: string) {',
            'await this.alarms.renew(Date.now() + renewalPeriodMs);'
          ),
          durable: 'customerId is stored in the object’s key-value storage.',
          volatile: 'The RPC call is waiting on renew().',
          status: 'normal',
        },
        {
          id: 'upsert',
          title: 'Upsert the occurrence with a new generation',
          description:
            'The row is keyed by channel and name. Each call writes a fresh generation ID, resets the attempt count to 0, and deletes memoized results of any previous occurrence of the name, all inside one storage transaction.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            schedule,
            'const generation = crypto.randomUUID();',
            'deleteMemos(sql, this.#table, key);'
          ),
          durable: 'One pending row for renew, with attempt 0.',
          volatile: 'The generation ID is held only until the write.',
          status: 'commit',
        },
        {
          id: 'arm',
          title: 'Set the object alarm in the same transaction',
          description:
            'Before the transaction commits, the scheduler sets the object’s one alarm to the earliest pending row of every attached helper, but no sooner than alarmMinDelayMs. renew() resolves after the commit; nothing runs for 30 days.',
          stage: ['alarm', '-alarm->object', 'focus:alarm'],
          source: sourceFocus(
            reconcile,
            'const target = Math.max(physicalNextAt, Date.now() + this.alarmMinDelayMs);',
            'await physicalAlarm.setAlarm(target);'
          ),
          durable: 'The alarm is stored with the row it serves.',
          volatile:
            'An occurrence due within alarmMinDelayMs would also get an in-memory timer that only this instance has.',
          status: 'commit',
        },
        {
          id: 'wake',
          title: 'The alarm fires and calls your class',
          description:
            'Thirty days later the runtime calls alarm(), possibly on a new instance. The class delegates to the shared scheduler, which runs the due work of every attached helper in one pass.',
          stage: ['+alarm->object', 'focus:object'],
          source: sourceFocus(
            subscription,
            'alarm(info?: AlarmInvocationInfo) {',
            'return this.scheduler.alarm(info);'
          ),
          durable: 'The renew row is read, not changed.',
          volatile: 'The alarm pass and its due lists.',
          status: 'normal',
        },
        {
          id: 'invoke',
          title: 'Claim the attempt and call renew',
          description:
            'DurabilityAlarms selects the pending renew row, and the scheduler takes a permit and durably increments its attempt count before the handler runs. The handler receives an idempotencyKey derived from the stored generation, so every retry of this occurrence gets the same key.',
          stage: ['renew', 'focus:renew'],
          source: sourceFocus(
            execute,
            'return handler({',
            'idempotencyKey: `durability-alarm:v1:${row.generation_id}`,'
          ),
          durable: 'The attempt count is 1 before any external effect.',
          volatile:
            'The occurrence is in the running map, so the same name cannot run twice in this instance.',
          status: 'commit',
        },
        {
          id: 'charge',
          title: 'Register the charge as its own operation',
          description:
            'The handler registers chargeInvoice with the alarm’s idempotencyKey as the operation ID. Durability stores that row in the same object, and its handler forwards the ID to the payments service.',
          stage: ['durability', 'payments', 'flow:run'],
          source: sourceFocus(
            subscription,
            'await this.durability.chargeInvoice({',
            'payload: { customerId, periodStart: scheduledTime },'
          ),
          durable:
            'A pending chargeInvoice row, committed with the alarm reconciled in the same transaction.',
          volatile:
            'The charge attempt starts only if the shared pool has a free permit.',
          status: 'commit',
        },
        {
          id: 'next',
          title: 'Success leaves the next renewal in place',
          description:
            'The handler ends by calling renew() again, which upserts the row with a new generation. When the attempt returns, the success delete matches only the old generation and attempt, so next month’s row stays, and the alarm moves to it once the charge has settled.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            execute,
            'complete: (_result, attempt) => {',
            'return removed ? timestamp : undefined;'
          ),
          durable: 'The renew row now describes next month’s occurrence.',
          volatile: 'The permit is released and the running entry removed.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Evict the object mid-renewal',
      description:
        'An illustrative eviction between registering the charge and scheduling the next renewal, not execution of the example code.',
      steps: [
        {
          id: 'evicted',
          title: 'The object is evicted inside the handler',
          description:
            'Assume chargeInvoice has committed, but the runtime evicts the object before renew() schedules next month. Registering the charge reconciled the alarm, and the renew row was still pending, so the alarm is set no later than alarmMinDelayMs after that commit.',
          stage: ['*', 'flow:run'],
          source: sourceFocus(
            subscription,
            'await this.durability.chargeInvoice({'
          ),
          durable:
            'The renew row (attempt 1, same generation), the chargeInvoice row, and the alarm.',
          volatile:
            'Permits, the running-occurrence map, timers, and the handler promise are lost.',
          status: 'failure',
        },
        {
          id: 'wake',
          title: 'The alarm starts a new instance',
          description:
            'The runtime creates a new instance, which constructs the scheduler and both helpers again, and calls alarm(). The class must delegate to the scheduler, which runs due work for Durability and DurabilityAlarms in one pass.',
          stage: ['focus:object'],
          source: sourceFocus(
            subscription,
            'alarm(info?: AlarmInvocationInfo) {',
            'return this.scheduler.alarm(info);'
          ),
          durable: 'Both tables and the alarm.',
          volatile: 'Fresh helpers with all permits free.',
          status: 'recovery',
        },
        {
          id: 'due',
          title: 'The interrupted occurrence is still due',
          description:
            'The renew row is pending with a past next_attempt_at, so the alarm pass selects it again from this instance’s channel.',
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
          id: 'same-key',
          title: 'Attempt 2 gets the same idempotencyKey',
          description:
            'The interrupted attempt still counts toward maxAttempts. The generation did not change, so the retry receives the same idempotencyKey as attempt 1.',
          stage: ['focus:renew'],
          source: sourceFocus(
            execute,
            'idempotencyKey: `durability-alarm:v1:${row.generation_id}`,'
          ),
          durable: 'The stored attempt count becomes 2.',
          volatile: 'A new handler call replaces the lost one.',
          status: 'recovery',
        },
        {
          id: 'dedupe',
          title: 'Registering the same charge is a no-op',
          description:
            'chargeInvoice is called again with the same ID and the same payload, so the insert does nothing and no second operation is created. The existing charge row keeps its own retries.',
          stage: ['focus:durability'],
          source: sourceFocus(
            register,
            'ON CONFLICT(channel, id) DO NOTHING',
            'throw new DuplicateDurablePayloadError(input.id, input.operation);'
          ),
          durable:
            'Still one chargeInvoice row; renew() now schedules next month.',
          volatile: 'Nothing from the first attempt survived.',
          status: 'recovery',
        },
        {
          id: 'receiver',
          title: 'The payments service must deduplicate',
          description:
            'If the charge’s handler was also interrupted after the service accepted it, the operation runs again with the same ID. Only the service’s handling of the repeated Idempotency-Key prevents a double charge.',
          stage: ['focus:payments'],
          source: sourceFocus(
            subscription,
            "headers: { 'Idempotency-Key': id },"
          ),
          durable:
            'Exactly-once effects require the receiver’s own deduplication record.',
          volatile: 'No in-memory state from the first attempt survived.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'replace',
      title: 'Replace or cancel an occurrence',
      description:
        'What happens when a name is scheduled again or cancelled, including while its handler runs.',
      steps: [
        {
          id: 'replace',
          title: 'Scheduling a name again replaces it',
          description:
            'Calling subscribe() twice upserts the same row. The new generation, time, and attempt 0 overwrite a pending or failed occurrence, and its memoized results are deleted in the same transaction.',
          stage: ['*', 'focus:sqlite'],
          source: sourceFocus(
            schedule,
            'ON CONFLICT(channel, name) DO UPDATE SET',
            'deleteMemos(sql, this.#table, key);'
          ),
          durable:
            'Still one row for renew, with a new generation and idempotencyKey.',
          volatile:
            'Waiters on the replaced occurrence are notified after the commit.',
          status: 'commit',
        },
        {
          id: 'running',
          title: 'A running handler is not stopped',
          description:
            'If renew is already running in this instance, a pass that finds the name due waits for that run instead of starting another. The replacement runs on a later pass.',
          stage: ['focus:alarms'],
          source: sourceFocus(
            execute,
            'const running = this.#active.get(row.name);',
            'return running.settled;'
          ),
          durable: 'The row holds the replacement’s generation.',
          volatile:
            'One running entry per name; the old handler keeps its permit.',
          status: 'normal',
        },
        {
          id: 'fenced',
          title: 'The old attempt cannot delete the replacement',
          description:
            'Success deletes the row only where generation and attempt still match the attempt that ran. After a replacement nothing matches, so the delete is a no-op.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            execute,
            'const removed = deleteAttempt(this.#engine.sql, this.#table, {',
            'return removed ? timestamp : undefined;'
          ),
          durable: 'The replacement row is untouched.',
          volatile: 'The old run’s result is discarded.',
          status: 'commit',
        },
        {
          id: 'cancel',
          title: 'cancel() deletes a pending occurrence',
          description:
            'renew.cancel() deletes the pending row and its memos and reconciles the alarm in one transaction. A failed occurrence is left for purgeBefore().',
          stage: ['focus:alarms'],
          source: sourceFocus(
            cancel,
            'const cancelled = await this.#engine.transaction((sql) => {',
            'deleteMemos(sql, this.#table, key);'
          ),
          durable:
            'The row is gone; the alarm moves to other pending work or is deleted.',
          volatile: 'Nothing yet.',
          status: 'commit',
        },
        {
          id: 'abort',
          title: 'A running attempt is only aborted',
          description:
            'After the commit, cancel() aborts the running attempt’s signal. The handler must honour it; an effect already sent is not undone, and the handler can still call renew() and schedule a new occurrence.',
          stage: ['focus:renew'],
          source: sourceFocus(
            cancel,
            'this.#active',
            '?.controller?.abort(new Error(`Durable alarm "${name}" was cancelled`));'
          ),
          durable:
            'Settlement writes match no row, so the attempt cannot retry.',
          volatile: 'The abort signal reaches only this instance’s handler.',
          status: 'gap',
        },
        {
          id: 'app-cancel',
          title: 'The example cancels with its own state',
          description:
            'The example does not call cancel(). It deletes customerId, so the next occurrence still fires, the handler returns without charging or rescheduling, and success deletes the row.',
          stage: ['focus:object'],
          source: sourceFocus(
            subscription,
            'if (customerId === undefined) {',
            'return; // Cancelled; let this occurrence complete without renewing.'
          ),
          durable: 'customerId is deleted; the renew row runs once more.',
          volatile: 'Nothing.',
          status: 'normal',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
