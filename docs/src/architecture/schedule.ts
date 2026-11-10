import schedule from '../../../packages/durability/src/schedule/index.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const scheduleFile = 'packages/durability/src/schedule/index.ts';

const construct = sourceExcerpt(
  schedule,
  scheduleFile,
  'construct',
  'Attach to the object’s scheduler',
  '    this.#engine = engineFor(config);',
  '      holding: () => this.#loop !== undefined,\n    });'
);
const alarmMethod = sourceExcerpt(
  schedule,
  scheduleFile,
  'alarm-method',
  'Delegate the object alarm',
  '  alarm(info?: AlarmInvocationInfo): Promise<void> {',
  '    return this.#engine.alarm(info);\n  }'
);
const set = sourceExcerpt(
  schedule,
  scheduleFile,
  'set',
  'Store a versioned schedule',
  '  async set(definition: ScheduleDefinition): Promise<boolean> {',
  '    return applied;\n  }'
);
const nextPending = sourceExcerpt(
  schedule,
  scheduleFile,
  'next-pending',
  'Choose the alarm time',
  '  #nextPendingAt(sql: SqlStorage): number | undefined {',
  '    return held.length === 0 ? undefined : Math.min(...held);\n  }'
);
const identity = sourceExcerpt(
  schedule,
  scheduleFile,
  'identity',
  'Derive the run’s idempotency key',
  '  #idempotencyKey(scheduledTime: number): string {',
  '    return `${this.#keyPrefix}${scheduledTime}`;\n  }'
);
const hold = sourceExcerpt(
  schedule,
  scheduleFile,
  'hold',
  'Keep the alarm invocation open',
  '  #hold(): Promise<void> {',
  '      await this.#startQueued();\n    }\n  }'
);
const interrupt = sourceExcerpt(
  schedule,
  scheduleFile,
  'interrupt',
  'Report runs that lost their instance',
  '  async #interruptOrphans(): Promise<void> {',
  '        error,\n      });\n    }\n  }'
);
const tick = sourceExcerpt(
  schedule,
  scheduleFile,
  'tick',
  'Advance the cursor and insert the run',
  '  async #tick(): Promise<void> {',
  '      this.#start(due.run);\n    }\n  }'
);
const start = sourceExcerpt(
  schedule,
  scheduleFile,
  'start',
  'Start a run outside the transaction',
  '  #start(run: ScheduledRun): void {',
  "          'durability.schedule.dispatch_failed',\n          { scheduledTime },\n          error\n        )\n      );\n  }"
);
const record = sourceExcerpt(
  schedule,
  scheduleFile,
  'record',
  'Persist the outcome',
  '  async #record(',
  '    this.#deliver(run, outcome, 1);\n  }'
);
const deliverDue = sourceExcerpt(
  schedule,
  scheduleFile,
  'deliver-due',
  'Find outcomes to deliver',
  '  #deliverDue(): void {',
  '      this.#deliver(this.#describe(row), outcomeOf(row), row.attempt + 1);\n    }\n  }'
);
const deliverOnce = sourceExcerpt(
  schedule,
  scheduleFile,
  'deliver-once',
  'Deliver and delete the run',
  '  async #deliverOnce(',
  '        run.scheduledTime\n      );\n    });\n  }'
);
const failDelivery = sourceExcerpt(
  schedule,
  scheduleFile,
  'fail-delivery',
  'Retry or dead-letter a delivery',
  '  async #failDelivery(',
  '      nextAttemptAt,\n    });\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'schedule',
  title: 'How DurabilitySchedule uses your Durable Object',
  summary:
    'DurabilitySchedule keeps one schedule row and one row per in-flight run in the object’s SQLite storage, and holds an alarm invocation open while runs are in flight. Step through one tick, evict the object mid-run, then follow an outcome until it is acknowledged.',
  diagram: {
    canvas: { width: 1000, height: 960 },
    direction: 'down',
    routing: 'auto',
    flows: {
      configure: { label: 'set the schedule', color: 'blue' },
      run: { label: 'run a tick', color: 'orange' },
      outcome: { label: 'deliver the outcome', color: 'purple' },
    },
    nodes: {
      caller: {
        rank: 0,
        row: 1,
        label: 'Worker',
        sublabel: 'control plane',
        icon: 'workers',
        tone: 'external',
      },
      object: {
        rank: 1,
        row: 1,
        label: 'Cron',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      alarm: {
        rank: 2,
        row: 0,
        label: 'Object alarm',
        sublabel: 'storage.setAlarm',
        icon: 'clock',
      },
      schedule: {
        rank: 2,
        row: 1,
        label: 'DurabilitySchedule',
        sublabel: 'in memory',
        icon: 'shield',
      },
      'on-outcome': {
        rank: 2,
        row: 2,
        label: 'onOutcome',
        sublabel: 'your handler',
        icon: 'workers',
      },
      'schedule-table': {
        rank: 3,
        row: 0,
        label: 'durability_schedule',
        sublabel: 'next tick',
        icon: 'database',
      },
      'runs-table': {
        rank: 3,
        row: 1,
        label: 'durability_schedule_runs',
        sublabel: 'one row per run',
        icon: 'database',
      },
      run: {
        rank: 3,
        row: 2,
        label: 'run',
        sublabel: 'your handler',
        icon: 'workers',
      },
      target: {
        rank: 4,
        row: 2,
        label: 'Target',
        sublabel: 'external service',
        icon: 'browser',
        tone: 'external',
      },
    },
    edges: [
      { from: 'caller', to: 'object', label: 'configure()', flow: 'configure' },
      { from: 'object', to: 'schedule', label: 'set()', flow: 'configure' },
      {
        from: 'alarm',
        to: 'object',
        label: 'alarm()',
        flow: 'run',
        back: true,
      },
      { from: 'schedule', to: 'alarm', flow: 'configure' },
      { from: 'schedule', to: 'on-outcome', flow: 'outcome' },
      {
        from: 'schedule',
        to: 'schedule-table',
        label: 'cursor',
        flow: 'configure',
      },
      { from: 'schedule', to: 'runs-table', label: 'runs', flow: 'run' },
      { from: 'schedule', to: 'run', label: 'run()', flow: 'run' },
      { from: 'run', to: 'target', label: 'idempotencyKey', flow: 'run' },
    ],
    groups: [
      {
        id: 'durable-object',
        label: 'One Durable Object',
        contains: [
          'object',
          'alarm',
          'schedule',
          'on-outcome',
          'schedule-table',
          'runs-table',
          'run',
        ],
      },
    ],
  },
  details: {
    caller: {
      description:
        'Whatever owns the schedule definition calls the object over RPC with an expression and a version. Each object holds one schedule.',
      href: '/primitives/schedule/',
      source: 'set',
    },
    object: {
      description:
        'Your class (Cron in the example below). The schedule is a field built on the object’s DurabilityScheduler, so it is rebuilt with every new instance. Its alarm() method must delegate to the scheduler.',
      href: '/primitives/scheduler/',
      source: 'alarm-method',
    },
    alarm: {
      description:
        'The object’s single alarm, set by the scheduler to the next tick’s firing time (or another helper’s earlier work), never sooner than alarmMinDelayMs. It is the fallback that brings the object back after eviction.',
      href: '/primitives/scheduler/',
      source: 'next-pending',
    },
    schedule: {
      description:
        'In memory it holds the run slots in use, the outcome deliveries in flight, and the loop that keeps an alarm invocation open while they last. Eviction discards all of it.',
      href: '/primitives/schedule/',
      source: 'hold',
    },
    'on-outcome': {
      description:
        'Receives each run’s persisted outcome at least once. Returning acknowledges it; throwing or timing out retries it with outcomeRetries.',
      href: '/reference/guarantees/',
      source: 'deliver-once',
    },
    'schedule-table': {
      description:
        'One row in the object’s SQLite storage: version, expression, jitter, and the next tick’s nominal time. A cancel keeps it as a tombstone with no expression.',
      href: '/reference/storage/',
      source: 'set',
    },
    'runs-table': {
      description:
        'One row per run from its tick until its outcome is delivered or dead-lettered: state, due time, next delivery time, delivery attempt, and error. No finished-run history remains.',
      href: '/reference/storage/',
      source: 'tick',
    },
    run: {
      description:
        'Your work for one tick, started outside any storage transaction with the scheduled time, due time, idempotencyKey, and an AbortSignal for runTimeoutMs. It is attempted once.',
      href: '/primitives/schedule/',
      source: 'start',
    },
    target: {
      description:
        'A separate service the run calls. It must deduplicate or reconcile on the idempotencyKey; an interrupted run is reported, not repeated, but its effect may have happened.',
      href: '/reference/guarantees/',
      source: 'identity',
    },
  },
  excerpts: [
    construct,
    set,
    nextPending,
    alarmMethod,
    hold,
    tick,
    start,
    record,
    deliverOnce,
    interrupt,
    deliverDue,
    identity,
    failDelivery,
  ],
  scenarios: [
    {
      id: 'tick',
      title: 'Set a schedule and run one tick',
      description:
        'Follow one schedule from set() to a run whose outcome is acknowledged and forgotten.',
      steps: [
        {
          id: 'attach',
          title: 'The schedule attaches to the object’s scheduler',
          description:
            'DurabilitySchedule is constructed with the object’s DurabilityScheduler, so it shares the object’s one alarm. Its run identity is prefixed with the Durable Object ID.',
          stage: ['object', 'schedule', 'durable-object', 'focus:schedule'],
          source: sourceFocus(
            construct,
            'this.#engine = engineFor(config);',
            "this.#keyPrefix = objectId === undefined ? '' : `${objectId}:`;"
          ),
          durable: 'Nothing is written yet.',
          volatile:
            'The helper, its run slots, and its loop are rebuilt after every eviction.',
          status: 'normal',
        },
        {
          id: 'tables',
          title: 'Create two tables and register with the scheduler',
          description:
            'The constructor applies migrations through ctx.storage.sql, then registers its runs table with its own way to compute the next pending time. A second schedule on the same scheduler throws.',
          stage: ['schedule-table', 'runs-table'],
          source: sourceFocus(
            construct,
            "this.#engine.migrateSchema('schedule', durabilityScheduleMigrations);",
            'holding: () => this.#loop !== undefined,'
          ),
          durable:
            'durability_schedule and durability_schedule_runs exist in this object’s storage.',
          volatile:
            'The registration with the scheduler repeats on each construction.',
          status: 'commit',
        },
        {
          id: 'set',
          title: 'Store a newer version of the schedule',
          description:
            'set() writes the expression, a fixed jitter, and the first tick after now, but only when the version is higher than the stored one. The same version writes nothing, yet its transaction still repairs a lost alarm.',
          stage: ['caller', 'flow:configure'],
          source: sourceFocus(
            set,
            'const applied = await this.#engine.transaction((sql) => {',
            'jitter_ms: jitterMs,'
          ),
          durable: 'One schedule row with the next tick’s nominal time.',
          volatile: 'The RPC call waits for the commit.',
          status: 'commit',
        },
        {
          id: 'arm',
          title: 'Set the object alarm to the next tick',
          description:
            'In the same transaction the scheduler asks the schedule for its next pending time: the next tick’s nominal time plus jitter. The alarm is set to it, never sooner than alarmMinDelayMs.',
          stage: ['alarm', '-alarm->object', 'focus:alarm'],
          source: sourceFocus(
            nextPending,
            'const tick = firesAt(readSchedule(sql));',
            'return Math.min(...pending);'
          ),
          durable: 'The alarm is stored with the schedule row.',
          volatile: 'Nothing else.',
          status: 'commit',
        },
        {
          id: 'hold',
          title: 'The alarm opens a loop that stays open',
          description:
            'When the alarm fires, the class delegates to the scheduler, which calls the schedule’s alarm pass. That pass loops, and stays pending while runs or deliveries are in flight, so the alarm invocation keeps the object in memory.',
          stage: ['+alarm->object', 'flow:run'],
          source: sourceFocus(
            hold,
            'async #drive(): Promise<void> {',
            'await this.#sleep(this.#nextWakeAt());'
          ),
          durable: 'Nothing is written yet.',
          volatile: 'The loop and its sleep timer.',
          status: 'normal',
        },
        {
          id: 'tick',
          title: 'Advance the cursor and insert the run together',
          description:
            'One transaction moves the stored next tick forward and inserts the run, running if a slot is free and queued otherwise. A replayed alarm finds the cursor already moved; missed ticks collapse into one run.',
          stage: ['focus:runs-table'],
          source: sourceFocus(
            tick,
            'const scheduledTime = schedule.next_at;',
            'ON CONFLICT DO NOTHING'
          ),
          durable:
            'The schedule row points at the following tick and the run row exists.',
          volatile: 'The run’s slot is reserved before the commit.',
          status: 'commit',
        },
        {
          id: 'run',
          title: 'Start the run outside the transaction',
          description:
            'The run receives its idempotencyKey and a signal that aborts after runTimeoutMs. It is attempted once and never retried. Its slot is held until the handler itself settles, even after a timeout.',
          stage: ['run', 'target', 'flow:run'],
          source: sourceFocus(
            start,
            'const handler = Promise.resolve().then(() =>',
            'return error;'
          ),
          durable: 'The run row is marked running.',
          volatile: 'The handler promise, its timer, and its slot.',
          status: 'normal',
        },
        {
          id: 'record',
          title: 'Persist the outcome before delivering it',
          description:
            'The outcome, complete or errored, is written only if the row is still running, so it survives a crash before delivery.',
          stage: ['focus:runs-table'],
          source: sourceFocus(
            record,
            'const recorded = await this.#engine.transaction(',
            "WHERE scheduled_time = ? AND state = 'running'"
          ),
          durable: 'The run row holds its outcome.',
          volatile: 'The slot is released once the handler has settled.',
          status: 'commit',
        },
        {
          id: 'deliver',
          title: 'Deliver the outcome, then forget the run',
          description:
            'onOutcome receives the run and its outcome. When it returns, the run row is deleted; nothing about the run is kept afterwards.',
          stage: ['on-outcome', 'flow:outcome'],
          source: sourceFocus(
            deliverOnce,
            'this.#onOutcome({ ...run, attempt }, outcome)',
            "'DELETE FROM durability_schedule_runs WHERE scheduled_time = ?',"
          ),
          durable: 'Only the schedule row remains.',
          volatile: 'The delivery promise.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Evict the object mid-run',
      description:
        'An illustrative eviction while a run is in flight, not execution of a particular application.',
      steps: [
        {
          id: 'evicted',
          title: 'The object is evicted during a run',
          description:
            'Assume the run has called the target service, but the runtime evicts the object before the outcome is recorded. The loop, the slot, and the handler are gone.',
          stage: ['*', 'flow:run'],
          source: sourceFocus(
            start,
            'this.#run({ ...run, signal: controller.signal })'
          ),
          durable:
            'The run row is still marked running; the schedule row already points at the next tick.',
          volatile: 'Slots, deliveries, the loop, and the handler promise.',
          status: 'failure',
        },
        {
          id: 'fallback',
          title: 'The next tick is the eviction fallback',
          description:
            'While a run is held, it does not move the alarm; the next tick does. With no tick left, the held run’s time sets it instead, which the scheduler moves to no sooner than alarmMinDelayMs.',
          stage: ['focus:alarm'],
          source: sourceFocus(
            nextPending,
            'if (pending.length > 0) {',
            'return held.length === 0 ? undefined : Math.min(...held);'
          ),
          durable: 'The alarm, at the next tick at the latest.',
          volatile: 'Nothing survives in memory.',
          status: 'recovery',
        },
        {
          id: 'wake',
          title: 'The alarm starts a new instance',
          description:
            'The runtime creates a new instance, which constructs the scheduler and the schedule again, and calls alarm(). Delegating to the scheduler (or to this method) runs the schedule’s alarm pass.',
          stage: ['focus:object'],
          source: sourceFocus(
            alarmMethod,
            'alarm(info?: AlarmInvocationInfo): Promise<void> {',
            'return this.#engine.alarm(info);'
          ),
          durable: 'Both tables and the alarm.',
          volatile: 'A fresh helper with no slots in use.',
          status: 'recovery',
        },
        {
          id: 'orphans',
          title: 'A running row without a slot is interrupted',
          description:
            'The first thing each pass does is look for rows marked running that no slot in this instance holds. They are marked errored with ScheduledRunInterruptedError, not run again.',
          stage: ['focus:runs-table'],
          source: sourceFocus(
            interrupt,
            "WHERE state = 'running'",
            "SET state = 'errored', error = ?, next_at = ?, attempt = 0"
          ),
          durable: 'The run row holds an errored outcome.',
          volatile: 'Nothing from the interrupted run.',
          status: 'recovery',
        },
        {
          id: 'report',
          title: 'onOutcome reports the interruption',
          description:
            'The pass delivers every persisted outcome that is due, so onOutcome receives the errored outcome.',
          stage: ['flow:outcome'],
          source: sourceFocus(
            deliverDue,
            "WHERE state IN ('complete', 'errored') AND next_at <= ?",
            'this.#deliver(this.#describe(row), outcomeOf(row), row.attempt + 1);'
          ),
          durable: 'The row stays until onOutcome returns.',
          volatile: 'The delivery promise.',
          status: 'recovery',
        },
        {
          id: 'receiver',
          title: 'The target may already have done the work',
          description:
            'The interrupted run may have completed its effect before the eviction. Durability reports it as errored and never repeats it, so the target or onOutcome must reconcile using the run’s idempotencyKey.',
          stage: ['focus:target'],
          source: sourceFocus(
            identity,
            'return `${this.#keyPrefix}${scheduledTime}`;'
          ),
          durable:
            'Whether the effect happened is recorded only by the target, if at all.',
          volatile: 'Nothing from the first run survived.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'outcomes',
      title: 'Deliver an outcome until acknowledged',
      description:
        'What happens when onOutcome fails, and why it may see the same outcome twice.',
      steps: [
        {
          id: 'retry',
          title: 'A failed delivery is retried later',
          description:
            'If onOutcome throws or exceeds outcomeTimeoutMs, the delivery attempt and its retry time are stored in a transaction that also reconciles the alarm.',
          stage: ['*', 'focus:on-outcome'],
          source: sourceFocus(
            failDelivery,
            'const nextAttemptAt = Date.now() + this.#retryDelay(attempt);',
            'UPDATE durability_schedule_runs SET attempt = ?, next_at = ?'
          ),
          durable: 'The row keeps its outcome with a new attempt and time.',
          volatile: 'The failed delivery and its error.',
          status: 'commit',
        },
        {
          id: 'sleep',
          title: 'The loop waits for the retry',
          description:
            'The loop sleeps until the next tick or outcome retry and keeps the alarm invocation open. The scheduler hands off to a new alarm before the wall-time limit, and that alarm joins the same loop.',
          stage: ['focus:schedule'],
          source: sourceFocus(
            hold,
            'if (this.#active.size === 0 && this.#delivering.size === 0) {',
            'await this.#sleep(this.#nextWakeAt());'
          ),
          durable: 'The row and the alarm.',
          volatile: 'The sleeping loop.',
          status: 'normal',
        },
        {
          id: 'redeliver',
          title: 'The same outcome is delivered again',
          description:
            'When the retry is due, in this instance or a new one, the pass reads the stored outcome and delivers it with the next attempt number.',
          stage: ['focus:runs-table'],
          source: sourceFocus(
            deliverDue,
            "WHERE state IN ('complete', 'errored') AND next_at <= ?"
          ),
          durable: 'The outcome itself never changes.',
          volatile: 'The new delivery promise.',
          status: 'recovery',
        },
        {
          id: 'duplicate',
          title: 'An acknowledged outcome can repeat',
          description:
            'If the object is evicted after onOutcome returns but before the delete commits, the outcome is delivered again. onOutcome must deduplicate by the run’s idempotencyKey.',
          stage: ['flow:outcome'],
          source: sourceFocus(
            deliverOnce,
            'await this.#engine.transaction((sql) => {',
            "'DELETE FROM durability_schedule_runs WHERE scheduled_time = ?',"
          ),
          durable: 'The row survives until the delete commits.',
          volatile: 'onOutcome’s success is not recorded anywhere.',
          status: 'gap',
        },
        {
          id: 'dead-letter',
          title: 'After the last attempt, the outcome is dropped',
          description:
            'When outcomeRetries.maxAttempts deliveries have failed, the row is deleted and a dead-letter failure and lifecycle event are reported. The outcome is not stored anywhere else.',
          stage: ['focus:runs-table'],
          source: sourceFocus(
            failDelivery,
            'if (attempt >= this.#maxOutcomeAttempts) {',
            "'durability.schedule.outcome_dead_lettered',"
          ),
          durable: 'The run row is gone.',
          volatile: 'The report and the best-effort lifecycle event.',
          status: 'failure',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
