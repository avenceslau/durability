import example from '../../../examples/subscription-renewals/worker.ts?raw';
import scheduler from '../../../packages/durability/src/scheduler.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/subscription-renewals/worker.ts';
const schedulerFile = 'packages/durability/src/scheduler.ts';

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
  'Share one engine between helpers',
  'export const engineFor = (attachment: SchedulerAttachment): Engine => {',
  '  return engine;\n};'
);
const register = sourceExcerpt(
  scheduler,
  schedulerFile,
  'register',
  'Register a helper’s table',
  '  register(participant: Participant): void {',
  '    this.participants.push(participant);\n  }'
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
  '      this.notifyAlarmRetry(error, info);\n    }\n  }'
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
    'A Durable Object has one alarm. DurabilityScheduler owns it for every helper in the object, together with one pool of concurrency permits. Step through two helpers sharing it, evict the object, then see how an alarm pass survives failures and long work.',
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
        'Your class. It constructs one scheduler from this.ctx and passes it to every helper. Its alarm() method must delegate to scheduler.alarm(), which runs the due work of every helper.',
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
        'Its engine lives only in this object instance: the list of attached tables, the concurrency permits and their FIFO waiters, the early timer, and the set of running keys. Eviction discards all of it.',
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
        'One attached helper. Its table, durability_calls, is registered with the engine, and its eager starts and alarm-driven attempts draw from the shared permits.',
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
    register,
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
            'The class constructs one DurabilityScheduler from this.ctx. Its engine is the only code that sets the object’s alarm and its early timer, and it starts with alarmConcurrency permits, here 5, which every attached helper shares.',
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
            'Each helper is given scheduler: this.scheduler, so it looks up that scheduler’s engine instead of creating one. A helper given context instead builds a private engine, which would set the alarm from its own table only.',
          stage: ['durability', 'alarms', 'focus:scheduler'],
          source: sourceFocus(
            attach,
            'if (attachment.scheduler === undefined) {',
            'const engine = engines.get(attachment.scheduler);'
          ),
          durable: 'Nothing is written yet.',
          volatile: 'Both helpers hold a reference to one engine.',
          status: 'normal',
        },
        {
          id: 'tables',
          title: 'Each helper registers its table',
          description:
            'After creating its tables through ctx.storage.sql, each helper registers its table and its due-work callback. Registering the same table twice throws, so two helpers of one kind cannot share a scheduler.',
          stage: ['calls', 'alarms-table'],
          source: sourceFocus(
            register,
            'if (this.participants.some(({ table }) => table.name === name)) {',
            'this.participants.push(participant);'
          ),
          durable:
            'durability_calls and durability_alarms exist in this object’s storage.',
          volatile:
            'The list of attached tables, rebuilt on each construction.',
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
            'Reconciliation asks every attached table for its earliest pending time and sets the one alarm to the minimum, but no sooner than alarmMinDelayMs. A second, private scheduler in the same object would overwrite this decision with its own.',
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
            'When the alarm fires, the class delegates to scheduler.alarm(). The engine calls each attached table’s due-work callback concurrently, then reconciles the alarm again.',
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
            'private availablePermits: number;',
            'private readonly activeByTable = new Map<string, Set<string>>();'
          ),
          durable: 'Rows in both tables, their attempt counts, and the alarm.',
          volatile:
            'Permits, waiters, the early timer, running keys, and handler promises are lost.',
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
            'The runtime creates a new instance, whose fields construct the scheduler and both helpers again, and calls alarm(). Without this delegation, pending rows in either table would not run again.',
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
            'The pass runs the callbacks of the helpers registered in this instance. Constructing every helper as a field, as the example does, ensures both tables are read.',
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
            'After the fallback alarm is set, the optional onAlarmRetry hook receives the error. It is best effort: a returned promise goes to waitUntil, and its own failure is only logged.',
          stage: ['focus:scheduler'],
          source: sourceFocus(alarm, 'this.notifyAlarmRetry(error, info);'),
          durable: 'Nothing beyond the fallback alarm.',
          volatile: 'The hook call and its promise.',
          status: 'normal',
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
