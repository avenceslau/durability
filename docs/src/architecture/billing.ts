import source from '../../../examples/subscription-renewals/worker.ts?raw';
import alarmsSource from '../../../packages/durability/src/durability-alarms.ts?raw';
import durabilitySource from '../../../packages/durability/src/durability.ts?raw';
import schedulerSource from '../../../packages/durability/src/scheduler.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const file = 'examples/subscription-renewals/worker.ts';
const alarmsFile = 'packages/durability/src/durability-alarms.ts';
const durabilityFile = 'packages/durability/src/durability.ts';
const schedulerFile = 'packages/durability/src/scheduler.ts';

const fetchHandler = sourceExcerpt(
  source,
  file,
  'fetch',
  'Route by customer',
  'export default {',
  '} satisfies ExportedHandler<Env>;'
);
const scheduler = sourceExcerpt(
  source,
  file,
  'scheduler',
  'One physical alarm owner',
  '  // One object uses both helpers, so they must share a scheduler: it owns the',
  '    alarmConcurrency: 5,\n  });'
);
const helpers = sourceExcerpt(
  source,
  file,
  'helpers',
  'Attach both helpers to the scheduler',
  '  private readonly durability = new Durability({',
  '  private readonly alarms = new DurabilityAlarms({\n    scheduler: this.scheduler,'
);
const charge = sourceExcerpt(
  source,
  file,
  'charge',
  'Charge with a stable key',
  '      chargeInvoice: async ({ id, payload }',
  '    retries: { maxAttempts: 8 },\n  });'
);
const renew = sourceExcerpt(
  source,
  file,
  'renew',
  'Renewal → operation handoff',
  '      renew: async ({ idempotencyKey, scheduledTime })',
  '        await this.alarms.renew(scheduledTime + renewalPeriodMs);\n      },'
);
const subscribe = sourceExcerpt(
  source,
  file,
  'subscribe',
  'Subscribe and schedule',
  '  async subscribe(customerId: string)',
  '    await this.alarms.renew(Date.now() + renewalPeriodMs);\n  }'
);
const cancel = sourceExcerpt(
  source,
  file,
  'cancel',
  'Cancel the subscription',
  '  async cancel() {',
  "    await this.ctx.storage.delete('customerId');\n  }"
);
const alarm = sourceExcerpt(
  source,
  file,
  'alarm',
  'Delegate the object alarm',
  '  alarm(info?: AlarmInvocationInfo) {',
  '    return this.scheduler.alarm(info);\n  }'
);
const scheduleAlarm = sourceExcerpt(
  alarmsSource,
  alarmsFile,
  'schedule-alarm',
  'Replace the named occurrence',
  '  async #schedule(name: string, scheduledTime: number): Promise<void> {',
  '      deleteMemos(sql, alarmsTable, name);\n    });'
);
const executeAlarm = sourceExcerpt(
  alarmsSource,
  alarmsFile,
  'execute-alarm',
  'Run one occurrence',
  '  #execute(',
  '        return removed ? timestamp : undefined;\n      },'
);
const register = sourceExcerpt(
  durabilitySource,
  durabilityFile,
  'register',
  'Register the charge operation',
  '  async #run(input: {',
  '    this.#engine.waitUntil(background, onError);\n  }'
);
const runDue = sourceExcerpt(
  durabilitySource,
  durabilityFile,
  'run-due',
  'Find due operations',
  '  async #runDue(now: number): Promise<void> {',
  '    });\n  }'
);
const runAlarm = sourceExcerpt(
  schedulerSource,
  schedulerFile,
  'run-alarm',
  'One alarm pass for every table',
  '  private async runAlarm(info?: AlarmInvocationInfo): Promise<void> {',
  '    await this.scheduleNextAlarm();\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'billing',
  title: 'Follow a renewal through the subscription object',
  summary:
    'One Durable Object per customer holds the renewal clock and every charge operation in its own SQLite storage, and one scheduler drives both from the object’s single alarm. Step through a renewal, then lose a payment acknowledgement.',
  diagram: {
    canvas: { width: 1000, height: 950 },
    direction: 'down',
    routing: 'auto',
    flows: {
      subscribe: { label: 'subscribe', color: 'blue' },
      renew: { label: 'run the renewal', color: 'orange' },
      charge: { label: 'charge the invoice', color: 'purple' },
    },
    nodes: {
      worker: {
        rank: 0,
        row: 1,
        label: 'Worker',
        sublabel: 'fetch handler',
        icon: 'workers',
        tone: 'external',
      },
      subscription: {
        rank: 1,
        row: 1,
        label: 'Subscription',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      scheduler: {
        rank: 2,
        row: 1,
        label: 'Scheduler',
        sublabel: 'shared, in memory',
        icon: 'shield',
      },
      objectAlarm: {
        rank: 2,
        row: 2,
        label: 'Object alarm',
        sublabel: 'ctx.storage.setAlarm',
        icon: 'clock',
      },
      customer: {
        rank: 2,
        row: 0,
        label: 'customerId',
        sublabel: 'ctx.storage.put',
        icon: 'database',
      },
      alarms: {
        rank: 3,
        row: 1,
        label: 'durability_alarms',
        sublabel: 'renew occurrence',
        icon: 'database',
      },
      calls: {
        rank: 3,
        row: 2,
        label: 'durability_calls',
        sublabel: 'charge operations',
        icon: 'database',
      },
      renew: {
        rank: 4,
        row: 1,
        label: 'renew',
        sublabel: 'alarm handler',
        icon: 'workers',
      },
      charge: {
        rank: 4,
        row: 2,
        label: 'chargeInvoice',
        sublabel: 'operation handler',
        icon: 'workers',
      },
      payments: {
        rank: 5,
        row: 2,
        label: 'Payment service',
        sublabel: 'PAYMENTS binding',
        size: [235, 72],
        icon: 'browser',
        tone: 'external',
      },
    },
    edges: [
      {
        from: 'worker',
        to: 'subscription',
        label: 'subscribe()',
        flow: 'subscribe',
      },
      {
        from: 'subscription',
        to: 'customer',
        label: 'put',
        flow: 'subscribe',
      },
      {
        from: 'subscription',
        to: 'scheduler',
        label: 'renew(at)',
        flow: 'subscribe',
      },
      {
        from: 'scheduler',
        to: 'alarms',
        label: 'upsert',
        flow: 'subscribe',
      },
      { from: 'scheduler', to: 'objectAlarm', flow: 'subscribe' },
      {
        from: 'objectAlarm',
        to: 'subscription',
        label: 'alarm()',
        flow: 'renew',
        back: true,
      },
      { from: 'alarms', to: 'renew', label: 'due', flow: 'renew' },
      { from: 'renew', to: 'customer', label: 'get', flow: 'renew' },
      {
        from: 'renew',
        to: 'calls',
        label: 'chargeInvoice()',
        flow: 'renew',
      },
      { from: 'calls', to: 'charge', label: 'attempt', flow: 'charge' },
      {
        from: 'charge',
        to: 'payments',
        label: 'Idempotency-Key: id',
        flow: 'charge',
      },
    ],
    groups: [
      {
        id: 'subscription-object',
        label: 'One object per customer',
        contains: [
          'subscription',
          'scheduler',
          'objectAlarm',
          'customer',
          'alarms',
          'calls',
          'renew',
          'charge',
        ],
      },
    ],
  },
  details: {
    worker: {
      description:
        'Parses POST /:customerId/(subscribe|cancel) and calls the object named by the customer with env.SUBSCRIPTIONS.getByName(customerId). Every request for one customer reaches the same object.',
      href: '/compositions/recurring-billing/',
      source: 'fetch',
    },
    subscription: {
      description:
        'Your class. Its fields build one scheduler and both helpers whenever the runtime creates an instance, and its alarm() delegates to the scheduler. Its storage holds only this customer’s subscription.',
      href: '/primitives/scheduler/',
      source: 'alarm',
    },
    scheduler: {
      description:
        'Lives only in this object instance: five permits shared by renewal handlers and charge attempts, the running attempts, and the timer for work due before the alarm. Eviction discards it; the next instance builds a new one.',
      href: '/primitives/scheduler/',
      source: 'scheduler',
    },
    objectAlarm: {
      description:
        'The object’s single alarm. Every scheduler transaction sets it to the earliest pending row across both tables, so the 30-day renewal and a charge retry share it.',
      href: '/primitives/scheduler/',
      source: 'alarm',
    },
    customer: {
      description:
        'A key-value entry in the object’s storage. subscribe() writes it, cancel() deletes it, and every renew reads it. No Durability table holds it.',
      href: '/compositions/recurring-billing/',
      source: 'subscribe',
    },
    alarms: {
      description:
        'One row per alarm name in ctx.storage.sql: generation, scheduled time, next attempt, attempt count, and last error. Scheduling the name again replaces the row with a new generation; a successful occurrence deletes its row.',
      href: '/primitives/alarms/',
      source: 'schedule-alarm',
    },
    calls: {
      description:
        'One row per charge, keyed by the renewal occurrence’s idempotencyKey: payload, status, attempt count, next retry, and result. Rows stay until purgeHistory() deletes them.',
      href: '/primitives/operations/',
      source: 'register',
    },
    renew: {
      description:
        'Named alarm handler. Reads customerId, registers the charge, and schedules the next occurrence. Its attempt is claimed in durability_alarms before it runs.',
      href: '/primitives/alarms/',
      source: 'renew',
    },
    charge: {
      description:
        'Operation handler. Runs outside any storage transaction with the stable operation ID, and throws on a non-OK response so the operation retries, up to eight attempts.',
      href: '/reference/retries/',
      source: 'charge',
    },
    payments: {
      description:
        'A separate system. It must enforce Idempotency-Key at its actual charge boundary; this example only forwards the header and cannot implement that guarantee for the provider.',
      href: '/reference/guarantees/',
      source: 'charge',
    },
  },
  excerpts: [
    fetchHandler,
    scheduler,
    helpers,
    charge,
    renew,
    subscribe,
    cancel,
    alarm,
    scheduleAlarm,
    executeAlarm,
    register,
    runDue,
    runAlarm,
  ],
  scenarios: [
    {
      id: 'renewal',
      title: 'A normal renewal',
      description:
        'Follow a subscription from the first request to a charge, through the object’s storage and alarm.',
      steps: [
        {
          id: 'customer-object',
          title: 'One object per customer',
          description:
            'The Worker names the object after the customer and calls subscribe() over RPC. That object’s storage and alarm belong to this customer alone; another customer’s object has its own tables and its own alarm.',
          stage: [
            'worker',
            'subscription',
            'subscription-object',
            'flow:subscribe',
          ],
          source: sourceFocus(
            fetchHandler,
            'const subscription = env.SUBSCRIPTIONS.getByName(customerId);',
            'await subscription.subscribe(customerId);'
          ),
          durable: 'Nothing is written yet.',
          volatile: 'The RPC call to subscribe() is in flight.',
          status: 'normal',
        },
        {
          id: 'scheduler',
          title: 'One scheduler owns the object’s alarm',
          description:
            'A Durable Object has one alarm, so both helpers attach to a single DurabilityScheduler built from this.ctx. Its five permits are one pool for renewal handlers and charge attempts in this object, not a limit across customers.',
          stage: ['scheduler', 'focus:scheduler'],
          source: sourceFocus(
            scheduler,
            'private readonly scheduler = new DurabilityScheduler({',
            'alarmConcurrency: 5,'
          ),
          durable: 'Nothing is written by the scheduler itself.',
          volatile:
            'The scheduler and its permits exist for this instance and are rebuilt after every eviction.',
          status: 'normal',
        },
        {
          id: 'tables',
          title: 'Each helper creates its table',
          description:
            'Durability and DurabilityAlarms receive scheduler: this.scheduler. Their constructors apply migrations through ctx.storage.sql and register their tables with the same engine, so one alarm pass covers both.',
          stage: ['alarms', 'calls'],
          source: sourceFocus(
            helpers,
            'private readonly durability = new Durability({',
            'scheduler: this.scheduler,'
          ),
          durable:
            'durability_calls, durability_alarms, and the shared durability_memos table exist in this object’s storage.',
          volatile:
            'Each helper’s registration with the engine repeats on every construction.',
          status: 'commit',
        },
        {
          id: 'subscribe',
          title: 'Store the customer, then schedule',
          description:
            'subscribe() writes customerId with ctx.storage.put, then schedules renew. These are two separate awaits, not one transaction: an eviction between them leaves a stored customer with no renewal, a gap production code still needs to handle.',
          stage: ['customer', 'flow:subscribe'],
          source: sourceFocus(
            subscribe,
            "await this.ctx.storage.put('customerId', customerId);",
            'await this.alarms.renew(Date.now() + renewalPeriodMs);'
          ),
          durable: 'customerId is stored when the first await resolves.',
          volatile:
            'The request does not wait 30 days; it only waits for the renewal to be stored.',
          status: 'commit',
        },
        {
          id: 'upsert',
          title: 'Replace the pending occurrence',
          description:
            'The renew row is keyed by name. A repeated subscribe() replaces the pending occurrence with a new generation and a new 30-day deadline rather than adding a second renewal, and deletes the replaced occurrence’s memos.',
          stage: ['focus:alarms'],
          source: sourceFocus(
            scheduleAlarm,
            'ON CONFLICT(name) DO UPDATE SET',
            'generation_id = excluded.generation_id,'
          ),
          durable:
            'One renew row with a fresh generation_id and scheduled_at 30 days out.',
          volatile: 'Nothing; the write is the whole schedule.',
          status: 'commit',
        },
        {
          id: 'arm',
          title: 'Set the object alarm in the same transaction',
          description:
            'The upsert runs in the engine’s storage transaction, which also sets the object’s alarm to the earliest pending row across both tables. The in-memory timer only covers work due within alarmMinDelayMs (15 seconds by default), so for a renewal 30 days out only the stored alarm can wake the object.',
          stage: [
            'objectAlarm',
            '-objectAlarm->subscription',
            'focus:objectAlarm',
          ],
          source: sourceFocus(
            scheduleAlarm,
            'await this.#engine.transaction((sql) => {'
          ),
          durable: 'The alarm is stored with the row it serves.',
          volatile: 'No in-memory timer is set for a renewal this far out.',
          status: 'commit',
        },
        {
          id: 'wake',
          title: 'The alarm fires and delegates to the scheduler',
          description:
            'Thirty days later the runtime calls alarm(), creating a new instance first if the object was evicted. alarm() delegates to the shared scheduler; without that delegation, nothing would run the pending rows.',
          stage: ['+objectAlarm->subscription', 'flow:renew'],
          source: sourceFocus(
            alarm,
            'alarm(info?: AlarmInvocationInfo) {',
            'return this.scheduler.alarm(info);'
          ),
          durable: 'The renew row and the alarm that served it.',
          volatile:
            'A new instance has a fresh scheduler with all five permits free.',
          status: 'normal',
        },
        {
          id: 'pass',
          title: 'One pass runs both tables',
          description:
            'The pass calls runDue for every attached table at once: the renew row in durability_alarms is due, and any pending charge in durability_calls is checked in the same pass.',
          stage: ['focus:scheduler'],
          source: sourceFocus(
            runAlarm,
            'this.participants.map((participant) =>',
            'participant.runDue(startedAt, info)'
          ),
          durable:
            'Rows are read; each attempt is claimed before its handler runs.',
          volatile: 'The pass and its 14-minute handoff timer.',
          status: 'normal',
        },
        {
          id: 'run-renew',
          title: 'Run renew with the occurrence key',
          description:
            'The handler receives scheduledTime and an idempotencyKey derived from the row’s generation. Every retry of this occurrence gets the same key; scheduling the name again creates a new one.',
          stage: ['renew', 'focus:renew'],
          source: sourceFocus(
            executeAlarm,
            'idempotencyKey: `durability-alarm:v1:${row.generation_id}`,'
          ),
          durable:
            'The claimed attempt count is stored in durability_alarms before the handler runs.',
          volatile: 'The handler call and its abort signal.',
          status: 'normal',
        },
        {
          id: 'register',
          title: 'Hand off to payment work',
          description:
            'renew reads customerId, then registers chargeInvoice with the occurrence key as the operation ID. Awaiting it waits for the row to commit in durability_calls, not for a successful charge.',
          stage: ['focus:calls'],
          source: sourceFocus(
            renew,
            'await this.durability.chargeInvoice({',
            'payload: { customerId, periodStart: scheduledTime },'
          ),
          durable:
            'A pending charge row keyed by the occurrence; the object alarm covers it too.',
          volatile:
            'If a permit is free, the attempt starts in the background now.',
          status: 'commit',
        },
        {
          id: 'rearm',
          title: 'Advance the renewal clock',
          description:
            'The next occurrence is scheduledTime plus 30 days, written as a new generation of the renew row. When the handler returns, completion deletes the row only where the old generation and attempt still match, so the replacement survives. Thirty days is a fixed interval, not a calendar month.',
          stage: ['focus:alarms'],
          source: sourceFocus(
            renew,
            'await this.alarms.renew(scheduledTime + renewalPeriodMs);'
          ),
          durable:
            'The next renew row is stored; the charge row is unaffected.',
          volatile:
            'The handler does not wait for the charge, so payment retries never delay the clock.',
          status: 'commit',
        },
        {
          id: 'charge',
          title: 'Cross the external boundary',
          description:
            'The charge attempt is claimed in durability_calls and runs outside any transaction. It forwards its stable ID; the provider must really deduplicate that key, because sending a header is not an exactly-once guarantee.',
          stage: ['charge', 'payments', 'flow:charge'],
          source: sourceFocus(
            charge,
            'headers:',
            'body: JSON.stringify(payload),'
          ),
          durable:
            'The operation record and the provider’s own charge record are separate commits.',
          volatile: 'The fetch and its response can be lost.',
          status: 'normal',
        },
        {
          id: 'settle',
          title: 'Settle or retry the charge',
          description:
            'A non-OK response throws, so the row is rescheduled with its error and retried, up to eight attempts. A successful return marks the row completed.',
          stage: ['focus:calls'],
          source: sourceFocus(
            charge,
            'if (!response.ok) {',
            'retries: { maxAttempts: 8 },'
          ),
          durable:
            'The row is completed, or pending with its next retry time and error.',
          volatile: 'The permit is released for the next attempt.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'lost-ack',
      title: 'Lose the payment acknowledgement',
      description:
        'An illustrative eviction at the external boundary, not execution of the example code. Retries reuse the stored operation ID; only the receiver can make them harmless.',
      steps: [
        {
          id: 'registered',
          title: 'Registration, not payment',
          description:
            'renew has registered the charge with the occurrence key and scheduled the next renewal. Nothing has been paid yet; the row in durability_calls is the only record of the obligation.',
          stage: ['*', 'focus:calls'],
          source: sourceFocus(renew, 'id: idempotencyKey,'),
          durable: 'A pending charge row and the object alarm.',
          volatile: 'The renew handler has returned.',
          status: 'commit',
        },
        {
          id: 'effect',
          title: 'The receiver commits, then the object is evicted',
          description:
            'Assume the provider commits the charge and its idempotency record, but the object is evicted before the result is stored. The highlighted fetch is where that uncertainty enters.',
          stage: ['flow:charge'],
          source: sourceFocus(
            charge,
            'const response = await this.env.PAYMENTS.fetch('
          ),
          durable:
            'The charge row is still pending with its attempt count, and the object alarm is still set.',
          volatile:
            'The scheduler, its permits, the running attempt, and the response are lost.',
          status: 'failure',
        },
        {
          id: 'wake',
          title: 'The alarm brings the object back',
          description:
            'The alarm creates a new instance, which builds a new scheduler and both helpers from this.ctx. alarm() delegates to that scheduler.',
          stage: ['focus:objectAlarm'],
          source: sourceFocus(alarm, 'return this.scheduler.alarm(info);'),
          durable: 'The alarm, both tables, and the stored attempt count.',
          volatile: 'A fresh scheduler with all permits free.',
          status: 'recovery',
        },
        {
          id: 'due',
          title: 'The charge row is still due',
          description:
            'The pass selects pending durability_calls rows whose retry time has passed. The interrupted charge was never settled, so it is selected and its next attempt is claimed.',
          stage: ['focus:calls'],
          source: sourceFocus(
            runDue,
            "WHERE status = 'pending' AND next_attempt_at <= ?"
          ),
          durable:
            'The interrupted attempt still counts toward the eight attempts.',
          volatile: 'The due list for this pass.',
          status: 'recovery',
        },
        {
          id: 'same-key',
          title: 'Retry with the same key',
          description:
            'The new attempt reads its ID and payload from the row, so the provider receives the same Idempotency-Key rather than a new payment identity.',
          stage: ['flow:charge'],
          source: sourceFocus(charge, "headers: { 'Idempotency-Key': id },"),
          durable: 'The stored operation ID is the identity of every attempt.',
          volatile:
            'A new fetch replaces the lost one, not the remote business effect.',
          status: 'recovery',
        },
        {
          id: 'boundary',
          title: 'The receiver decides whether it is safe',
          description:
            'A key-aware provider returns its prior outcome without charging again. A provider that ignores the key can charge twice; nothing in the object can prove what the provider committed.',
          stage: ['focus:payments'],
          source: sourceFocus(charge, "headers: { 'Idempotency-Key': id },"),
          durable:
            'Effectively-once charging requires the receiver’s own deduplication record.',
          volatile:
            'No in-memory flag or attempt number survived the first attempt.',
          status: 'gap',
        },
        {
          id: 'complete',
          title: 'Store the completion',
          description:
            'When the provider answers OK, the handler returns and the row is completed, conditional on the same generation and attempt.',
          stage: ['focus:charge'],
          source: sourceFocus(
            charge,
            'if (!response.ok) {',
            'throw new Error(`Charge failed with ${response.status}`);'
          ),
          durable: 'The charge row is completed.',
          volatile: 'The permit is released.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'naive',
      title: 'Why a naive cron loop double-charges',
      description:
        'A cron callback that reads customers, charges, and then writes “last billed” has an ambiguous window after the charge. There is no naive source here: each step shows the composition line that closes the gap.',
      steps: [
        {
          id: 'naive-due',
          title: 'Naive: decide who is due at run time',
          description:
            'A naive loop finds due customers when it runs, so nothing durable names this period’s charge. Here the due work is the renew row in durability_alarms, and its generation names the occurrence.',
          stage: ['*', 'focus:alarms'],
          source: sourceFocus(
            renew,
            'renew: async ({ idempotencyKey, scheduledTime }) => {'
          ),
          durable: 'One stored row per pending occurrence.',
          volatile: 'Nothing is decided from in-memory state.',
          status: 'normal',
        },
        {
          id: 'naive-charge',
          title: 'Naive: charge before recording anything',
          description:
            'The naive loop calls the payment API first and writes “last billed” afterwards. Here renew only registers a charge row keyed by the occurrence; the payment request runs later, from that row.',
          stage: ['focus:calls'],
          source: sourceFocus(
            renew,
            'await this.durability.chargeInvoice({',
            'id: idempotencyKey,'
          ),
          durable: 'The obligation is stored before any external effect.',
          volatile: 'Nothing about the charge is held only in memory.',
          status: 'commit',
        },
        {
          id: 'naive-crash',
          title: 'Naive: a crash leaves the customer due',
          description:
            'In the naive loop, a crash before the “last billed” write makes the next run charge again with nothing linking the two requests. Here a retried renew registers the same ID and payload again, which is a no-op, and an interrupted charge retries as the same row.',
          stage: ['flow:renew'],
          source: sourceFocus(register, 'ON CONFLICT(id) DO NOTHING'),
          durable: 'Still one charge row for the occurrence.',
          volatile: 'The interrupted attempt is gone, but its row is not.',
          status: 'failure',
        },
        {
          id: 'naive-key',
          title: 'Naive: the second charge is a new request',
          description:
            'The naive retry is indistinguishable from a new charge. Here every attempt sends the operation ID as Idempotency-Key; whether that prevents a second charge is still the receiver’s decision.',
          stage: ['focus:payments'],
          source: sourceFocus(charge, "headers: { 'Idempotency-Key': id },"),
          durable:
            'The receiver’s deduplication record, not this object, decides.',
          volatile:
            'No caller-side state can make the two systems one transaction.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'cancel',
      title: 'Cancel a subscription',
      description: 'What cancel() stops and what it cannot recall.',
      steps: [
        {
          id: 'cancel',
          title: 'cancel() deletes only the customer',
          description:
            'cancel() deletes customerId. It does not touch the renew row, any charge row, or the object alarm.',
          stage: ['*', 'focus:customer'],
          source: sourceFocus(
            cancel,
            "await this.ctx.storage.delete('customerId');"
          ),
          durable:
            'customerId is gone; the pending renew row and any charge rows remain.',
          volatile: 'Nothing else changes in the running instance.',
          status: 'commit',
        },
        {
          id: 'stop',
          title: 'The next renew stops the clock',
          description:
            'When the occurrence runs it finds no customer and returns without registering a charge or scheduling another renewal. Its row is deleted; with no other pending work, the scheduler deletes the object alarm after the pass.',
          stage: ['focus:renew'],
          source: sourceFocus(
            renew,
            'if (customerId === undefined) {',
            'return; // Cancelled; let this occurrence complete without renewing.'
          ),
          durable: 'No renew row remains.',
          volatile: 'The handler returns immediately.',
          status: 'normal',
        },
        {
          id: 'in-flight',
          title: 'A registered charge still runs',
          description:
            'A charge registered before cancel is unaffected: its row stays pending and retries until it settles. Refunding, voiding, or accepting it is application work.',
          stage: ['flow:charge'],
          source: sourceFocus(
            charge,
            'const response = await this.env.PAYMENTS.fetch('
          ),
          durable: 'The charge row keeps its stored payload and retries.',
          volatile: 'cancel() cannot abort an attempt already in flight.',
          status: 'gap',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
