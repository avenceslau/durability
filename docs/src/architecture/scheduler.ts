import example from '../../../examples/subscription-renewals/worker.ts?raw';
import scheduler from '../../../packages/durability/src/scheduler/index.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/subscription-renewals/worker.ts';
const schedulerFile = 'packages/durability/src/scheduler/index.ts';

const subscription = sourceExcerpt(
  example,
  exampleFile,
  'subscription',
  'Subscription Durable Object',
  'export class Subscription extends DurableObject<Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const engineState = sourceExcerpt(
  scheduler,
  schedulerFile,
  'engine-state',
  'What the engine keeps in memory',
  'export class Engine {',
  '  private readonly activeByTable = new Map<string, Set<string>>();'
);
const attach = sourceExcerpt(
  scheduler,
  schedulerFile,
  'attach',
  'Join the object’s one engine',
  'type ObjectScheduler = { engine: unknown; installation: symbol };',
  "    throw new Error('Unknown DurabilityScheduler instance');\n  }\n  return engine;\n};"
);
const configure = sourceExcerpt(
  scheduler,
  schedulerFile,
  'configure',
  'Merge scheduler options',
  '  attach(\n    context: DurabilityContext,',
  '      waiter(this.createRelease());\n    }\n  }'
);
const register = sourceExcerpt(
  scheduler,
  schedulerFile,
  'register',
  'Register a helper’s channel',
  '  register(participant: Participant): void {',
  '      this.waitUntil(resumed, onError);\n    }\n  }'
);
const unattached = sourceExcerpt(
  scheduler,
  schedulerFile,
  'unattached',
  'Postpone channels nothing attached',
  '  private async postponeUnattachedChannels(',
  '          now\n        );\n      }\n    });\n  }'
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
  'Set the object alarm from every table',
  '  private async reconcile(',
  '    return timerTimes.length === 0 ? undefined : Math.min(...timerTimes);\n  }'
);
const earlyTimer = sourceExcerpt(
  scheduler,
  schedulerFile,
  'early-timer',
  'Start near-due work from memory',
  '  private scheduleEarlyAlarm(timestamp: number | undefined): void {',
  '    this.earlyAlarm = { timestamp, timer };\n  }'
);
const permits = sourceExcerpt(
  scheduler,
  schedulerFile,
  'permits',
  'Share one pool of permits',
  '  tryAcquirePermit(): (() => void) | undefined {',
  '    };\n  }'
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
  'Run every helper’s due work',
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
  id: 'scheduler',
  title: 'How DurabilityScheduler uses your Durable Object',
  summary:
    'A Durable Object has one alarm and one scheduler. Every helper on the object joins the same engine, which owns the alarm and one pool of concurrency permits. Step through two helpers sharing it, evict the object, then see how an alarm pass survives failures and long work.',
  diagram: {
    canvas: { width: 1000, height: 1000 },
    direction: 'down',
    routing: 'auto',
    flows: {
      write: { label: 'commit rows and the alarm', color: 'blue' },
      run: { label: 'run due work', color: 'orange' },
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
      alarm: {
        rank: 2,
        row: 0,
        label: 'Object alarm',
        sublabel: 'storage.setAlarm',
        icon: 'clock',
      },
      scheduler: {
        rank: 2,
        row: 1,
        label: 'Scheduler',
        sublabel: 'in memory',
        icon: 'shield',
        size: [210, 72],
      },
      timer: {
        rank: 2,
        row: 2,
        label: 'Early timer',
        sublabel: 'setTimeout',
        icon: 'clock',
      },
      durability: {
        rank: 3,
        row: 0.5,
        label: 'Durability',
        sublabel: 'chargeInvoice',
        icon: 'shield',
      },
      alarms: {
        rank: 3,
        row: 1.5,
        label: 'DurabilityAlarms',
        sublabel: 'renew',
        icon: 'shield',
      },
      calls: {
        rank: 4,
        row: 0.5,
        label: 'durability_calls',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      'alarms-table': {
        rank: 4,
        row: 1.5,
        label: 'durability_alarms',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
    },
    edges: [
      { from: 'caller', to: 'object', label: 'subscribe()', flow: 'write' },
      { from: 'object', to: 'scheduler', label: 'alarm(info)', flow: 'run' },
      {
        from: 'alarm',
        to: 'object',
        label: 'alarm()',
        flow: 'run',
        back: true,
      },
      { from: 'scheduler', to: 'alarm', flow: 'write' },
      { from: 'scheduler', to: 'timer', flow: 'write' },
      {
        from: 'scheduler',
        to: 'durability',
        label: 'runDue',
        flow: 'run',
        route: 'straight',
      },
      {
        from: 'scheduler',
        to: 'alarms',
        label: 'runDue',
        flow: 'run',
        route: 'straight',
      },
      { from: 'durability', to: 'calls', label: 'rows', flow: 'write' },
      { from: 'alarms', to: 'alarms-table', label: 'rows', flow: 'write' },
    ],
    groups: [
      {
        id: 'durable-object',
        label: 'One Durable Object',
        contains: [
          'object',
          'alarm',
          'scheduler',
          'timer',
          'durability',
          'alarms',
          'calls',
          'alarms-table',
        ],
      },
    ],
  },
  details: {
    caller: {
      description:
        'Gets a stub with env.SUBSCRIPTIONS.getByName(customerId) and calls subscribe() over RPC. Each customer has its own object, so its own scheduler, tables, and alarm.',
      href: '/getting-started/',
      source: 'subscription',
    },
    object: {
      description:
        'Your class. It constructs one scheduler from this.ctx and passes it to every helper. Its alarm() method must delegate to scheduler.alarm(), or to any helper’s alarm(); each runs the due work of every helper on the object.',
      href: '/primitives/scheduler/',
      source: 'subscription',
    },
    alarm: {
      description:
        'The object’s single alarm. Only the scheduler sets it: to the earliest pending row of any attached helper, never sooner than alarmMinDelayMs. It survives eviction and brings the object back.',
      href: '/reference/guarantees/',
      source: 'reconcile',
    },
    scheduler: {
      description:
        'The object’s one engine, shared by every helper and scheduler built for this.ctx. It lives only in this object instance: the merged options, the attached tables and channels, the concurrency permits and their FIFO waiters, the early timer, and the set of running keys. Eviction discards all of it.',
      href: '/primitives/scheduler/',
      source: 'engine-state',
    },
    timer: {
      description:
        'A setTimeout for work due before the alarm may fire (within alarmMinDelayMs, or at any time with liveTimers). It exists only in this instance; the alarm is the fallback after eviction.',
      href: '/primitives/scheduler/',
      source: 'early-timer',
    },
    durability: {
      description:
        'One attached helper. Its channel of durability_calls, the default one here, is registered with the engine, and its eager starts and alarm-driven attempts draw from the shared permits.',
      href: '/primitives/operations/',
      source: 'subscription',
    },
    alarms: {
      description:
        'Another attached helper on the same engine. Its renew handler registers chargeInvoice, so one handler runs while another operation waits for a permit from the same pool.',
      href: '/primitives/alarms/',
      source: 'subscription',
    },
    calls: {
      description:
        'Durability’s rows in the object’s SQLite storage. The engine reads the earliest pending next_attempt_at from it when it reconciles the alarm.',
      href: '/reference/storage/',
      source: 'reconcile',
    },
    'alarms-table': {
      description:
        'DurabilityAlarms’ rows in the same storage. The engine reads it the same way, so one alarm serves both tables.',
      href: '/reference/storage/',
      source: 'reconcile',
    },
  },
  excerpts: [
    subscription,
    engineState,
    attach,
    configure,
    register,
    unattached,
    transaction,
    reconcile,
    earlyTimer,
    runAlarm,
    permits,
    execute,
    alarm,
  ],
  scenarios: [
    {
      id: 'shared',
      title: 'Share one alarm between two helpers',
      description:
        'Follow the subscription example, where Durability and DurabilityAlarms share one scheduler.',
      steps: [
        {
          id: 'one-scheduler',
          title: 'One scheduler per object instance',
          description:
            'The class constructs a DurabilityScheduler from this.ctx. The first attachment for an object creates its engine, the only code that sets the object’s alarm and its early timer. It starts with alarmConcurrency permits, here 5, which every attached helper shares.',
          stage: [
            'object',
            'scheduler',
            'alarm',
            'timer',
            '-alarm->object',
            'durable-object',
            'focus:scheduler',
          ],
          source: sourceFocus(
            subscription,
            'private readonly scheduler = new DurabilityScheduler({',
            'alarmConcurrency: 5,'
          ),
          durable: 'Nothing is written yet.',
          volatile:
            'The engine, its permits, and its timer are rebuilt after every eviction.',
          status: 'normal',
        },
        {
          id: 'attach',
          title: 'Both helpers attach to the same engine',
          description:
            'Each helper is given scheduler: this.scheduler and uses that scheduler’s engine. A helper given context: this.ctx would reach the same engine, because the engine is looked up by ctx.storage: the first attachment creates it and every later one joins it. A second copy of the library reaching the same object throws instead of setting the alarm.',
          stage: ['durability', 'alarms', 'focus:scheduler'],
          source: sourceFocus(
            attach,
            'const existing = objectSchedulers.get(context.storage);',
            'engine.attach(context, config);'
          ),
          durable: 'Nothing is written yet.',
          volatile: 'Both helpers hold a reference to one engine.',
          status: 'normal',
        },
        {
          id: 'options',
          title: 'Scheduler options merge across attachments',
          description:
            'Every attachment passes its scheduler options to the engine. An option one attachment sets applies to every helper, an attachment that omits it accepts that value, and an attachment that sets a different value throws.',
          stage: ['focus:scheduler'],
          source: sourceFocus(
            configure,
            'for (const key of schedulerOptionKeys) {',
            'Object.assign(merged, { [key]: value });'
          ),
          durable: 'Nothing is written yet.',
          volatile:
            'The merged options, rebuilt by the attachments of each new instance.',
          status: 'normal',
        },
        {
          id: 'tables',
          title: 'Each helper registers its channel',
          description:
            'After creating its tables through ctx.storage.sql, each helper registers its channel of its table, default unless it was given channel, with its due-work callback. The first channel of a table registers the table with one callback that runs every attached channel; a second instance on a channel already attached throws. Here each helper uses the default channel of its own table.',
          stage: ['calls', 'alarms-table'],
          source: sourceFocus(
            register,
            'registerChannel(participant: ChannelParticipant): void {',
            'this.claimChannel(table.name, channel, helper);'
          ),
          durable:
            'durability_calls and durability_alarms exist in this object’s storage.',
          volatile:
            'The attached tables and channels, rebuilt on each construction.',
          status: 'commit',
        },
        {
          id: 'write',
          title: 'Rows and the alarm commit together',
          description:
            'When subscribe() calls renew(at), the helper’s insert and the alarm update run inside one storage transaction. The early timer is set only after the commit.',
          stage: ['caller', 'flow:write'],
          source: sourceFocus(
            transaction,
            'const result = await this.storage.transaction(async (transaction) => {',
            'this.scheduleEarlyAlarm(nextPendingAt);'
          ),
          durable: 'The row and the alarm commit or roll back together.',
          volatile: 'The early timer, if one is needed.',
          status: 'commit',
        },
        {
          id: 'earliest',
          title: 'The alarm serves the earliest row of any table',
          description:
            'Reconciliation asks every attached table for its earliest pending time, across all of its channels, and sets the one alarm to the minimum, but no sooner than alarmMinDelayMs. Every helper on the object goes through this engine, so no other code moves the alarm.',
          stage: ['focus:alarm'],
          source: sourceFocus(
            reconcile,
            'for (const participant of this.participants) {',
            'await physicalAlarm.setAlarm(target);'
          ),
          durable: 'One alarm time for both tables.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'timer',
          title: 'Near-due work starts from memory',
          description:
            'The alarm cannot fire sooner than alarmMinDelayMs, so work due earlier gets a setTimeout at its exact time. When it fires, it runs the same alarm pass in the background.',
          stage: ['focus:timer'],
          source: sourceFocus(
            earlyTimer,
            'if (!this.liveTimers && delay >= this.alarmMinDelayMs) {',
            'const execution = this.alarm().catch(onError);'
          ),
          durable: 'The alarm stays set as the fallback.',
          volatile: 'The timer exists only in this instance.',
          status: 'normal',
        },
        {
          id: 'alarm-pass',
          title: 'One alarm pass runs every helper',
          description:
            'When the alarm fires, the class delegates to scheduler.alarm(); either helper’s alarm() would call the same engine. The engine calls each attached table’s due-work callback concurrently, which runs the due rows of every attached channel, then reconciles the alarm again.',
          stage: ['+alarm->object', 'flow:run'],
          source: sourceFocus(
            runAlarm,
            'const execution = Promise.all(',
            'participant.runDue(startedAt, info)'
          ),
          durable: 'Due rows are read from both tables.',
          volatile: 'The alarm pass and its running attempts.',
          status: 'normal',
        },
        {
          id: 'permits',
          title: 'Handlers share one pool of permits',
          description:
            'The renew handler holds a permit while it registers chargeInvoice. That operation starts eagerly only if another permit is free; otherwise the next timer or alarm pass waits for one in FIFO order.',
          stage: ['focus:scheduler'],
          source: sourceFocus(
            permits,
            'tryAcquirePermit(): (() => void) | undefined {',
            'this.permitWaiters.push(resolve);'
          ),
          durable: 'The chargeInvoice row is committed either way.',
          volatile: 'Permits and waiters exist only in this instance.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Evict the object with work pending',
      description:
        'An illustrative eviction while both helpers have pending rows, not execution of the example code.',
      steps: [
        {
          id: 'evicted',
          title: 'Eviction discards the engine',
          description:
            'Assume the object is evicted while a renewal runs and a charge waits for a permit. Everything the engine kept in memory is gone; everything committed is still in storage.',
          stage: ['*', 'focus:scheduler'],
          source: sourceFocus(
            engineState,
            'private readonly participants: Participant[] = [];',
            'private readonly activeByTable = new Map<string, Set<string>>();'
          ),
          durable: 'Rows in both tables, their attempt counts, and the alarm.',
          volatile:
            'Attached tables and channels, permits, waiters, the early timer, running keys, and handler promises are lost.',
          status: 'failure',
        },
        {
          id: 'timer-lost',
          title: 'The alarm replaces the lost timer',
          description:
            'Work that was waiting on the early timer now waits for the alarm. Every commit set the alarm no later than alarmMinDelayMs after it, so that work runs at most that much later than due.',
          stage: ['focus:alarm'],
          source: sourceFocus(
            reconcile,
            'const target = Math.max(physicalNextAt, Date.now() + this.alarmMinDelayMs);'
          ),
          durable: 'The alarm time.',
          volatile: 'The timer is gone.',
          status: 'recovery',
        },
        {
          id: 'wake',
          title: 'The alarm starts a new instance',
          description:
            'The runtime creates a new instance, whose fields construct the scheduler and both helpers again on one new engine, and calls alarm(). Without this delegation, pending rows in either table would not run again.',
          stage: ['flow:run'],
          source: sourceFocus(
            subscription,
            'alarm(info?: AlarmInvocationInfo) {',
            'return this.scheduler.alarm(info);'
          ),
          durable: 'Both tables and the alarm.',
          volatile: 'A fresh engine with all permits free.',
          status: 'recovery',
        },
        {
          id: 'participants',
          title: 'Only constructed helpers are consulted',
          description:
            'The pass runs the callbacks of the tables registered in this instance, and reconciliation reads only those tables. Constructing every helper as a field, as the example does, ensures both tables are read.',
          stage: ['focus:scheduler'],
          source: sourceFocus(
            runAlarm,
            'this.participants.map((participant) =>',
            'participant.runDue(startedAt, info)'
          ),
          durable: 'Due rows are read from both tables.',
          volatile: 'The due lists for this pass.',
          status: 'recovery',
        },
        {
          id: 'unattached',
          title: 'Due rows of a missing channel are kept',
          description:
            'Assume a table also held due rows on a channel no instance attached, for example one a library uses but this deploy no longer constructs. The pass keeps those rows, moves their next_attempt_at 60 seconds later, and reports durability.channel_missing. They run once a helper attaches that channel again.',
          stage: ['focus:scheduler'],
          source: sourceFocus(
            unattached,
            "'durability.channel_missing',",
            'now + unattachedChannelRetryMs,'
          ),
          durable:
            'The rows of the missing channel, with a later next_attempt_at.',
          volatile: 'Nothing beyond the report.',
          status: 'gap',
        },
        {
          id: 'claim',
          title: 'Interrupted attempts still count',
          description:
            'Each due row gets a new attempt through a conditional UPDATE of its stored count. The interrupted renewal used attempt 1, so this is attempt 2 with the same identity.',
          stage: ['focus:durability'],
          source: sourceFocus(execute, 'const attempt = claimAttempt('),
          durable:
            'The stored attempt count increases before the handler runs.',
          volatile: 'New handler calls replace the lost ones.',
          status: 'recovery',
        },
      ],
    },
    {
      id: 'alarm-limits',
      title: 'Work within alarm limits',
      description:
        'How the scheduler keeps pending work running when an alarm pass fails or runs long.',
      steps: [
        {
          id: 'failure',
          title: 'A failing pass sets its own alarm',
          description:
            'The runtime retries a throwing alarm() only a few times and then drops it, which would strand pending rows. The engine catches the error and sets the alarm alarmMinDelayMs later instead.',
          stage: ['*', 'focus:alarm'],
          source: sourceFocus(
            alarm,
            'if (!(await this.armFallbackAlarm())) {',
            'reportFailure('
          ),
          durable: 'A new alarm time is written directly to storage.',
          volatile: 'The failed pass and its error.',
          status: 'recovery',
        },
        {
          id: 'retry-hook',
          title: 'onAlarmRetry reports the failure',
          description:
            'After the fallback alarm is set, the optional onAlarmRetry hook receives the error and the fallback alarm’s delay. It is best effort: a returned promise goes to waitUntil, and its own failure is only logged.',
          stage: ['focus:scheduler'],
          source: sourceFocus(alarm, 'this.notifyAlarmRetry(error, info);'),
          durable: 'Nothing beyond the fallback alarm.',
          volatile: 'The hook call and its promise.',
          status: 'normal',
        },
        {
          id: 'retry',
          title: 'Retry from memory before the fallback',
          description:
            'Then the engine sets the early timer to run the pass again after 1 second, doubling with each failure in a row up to alarmMinDelayMs. A pass that succeeds resets the count. The fallback alarm stays set in case the instance is evicted.',
          stage: ['focus:timer'],
          source: sourceFocus(
            alarm,
            'this.failedRuns += 1;',
            'this.scheduleEarlyAlarm(Date.now() + delay);'
          ),
          durable: 'The fallback alarm.',
          volatile: 'The early timer and the count of failed passes.',
          status: 'recovery',
        },
        {
          id: 'fallback-fails',
          title: 'Only a failed setAlarm reaches the platform',
          description:
            'If even the fallback setAlarm fails, the original error is thrown and the platform’s own retries apply. Once those are exhausted, the object has no alarm until another write reconciles it.',
          stage: ['focus:object'],
          source: sourceFocus(alarm, 'throw error;'),
          durable: 'Possibly no alarm at all.',
          volatile: 'The error propagates to the runtime.',
          status: 'gap',
        },
        {
          id: 'handoff',
          title: 'Hand off before the wall-time limit',
          description:
            'If due work is still running after alarmHandoffMs (14 minutes by default), the pass sets a new alarm and returns before the runtime’s alarm wall-time limit. Running attempts continue if the instance stays alive.',
          stage: ['flow:run'],
          source: sourceFocus(
            runAlarm,
            'if (result === handoff) {',
            'await this.armForHandoff(Date.now());'
          ),
          durable: 'The next alarm is stored before the pass returns.',
          volatile: 'The running attempts and their promises.',
          status: 'normal',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
