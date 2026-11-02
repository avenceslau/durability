import example from '../../../examples/email-queue/worker.ts?raw';
import fanout from '../../../packages/durability/src/fanout.ts?raw';
import scheduler from '../../../packages/durability/src/scheduler.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/email-queue/worker.ts';
const fanoutFile = 'packages/durability/src/fanout.ts';
const schedulerFile = 'packages/durability/src/scheduler.ts';

const emailDelivery = sourceExcerpt(
  example,
  exampleFile,
  'email-delivery',
  'EmailDelivery Durable Object',
  'export class EmailDelivery extends DurableObject<Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const consumer = sourceExcerpt(
  example,
  exampleFile,
  'consumer',
  'EmailConsumer settles each message',
  'export class EmailConsumer extends WorkerEntrypoint<Env> {',
  '      // Unsettled messages retry; exhausting the budget dead-letters this target only.'
);
const fetchHandler = sourceExcerpt(
  example,
  exampleFile,
  'fetch',
  'Route a batch to one shard',
  '  async fetch(request): Promise<Response> {',
  '    return Response.json(result, { status: result.success ? 202 : 409 });'
);
const construct = sourceExcerpt(
  fanout,
  fanoutFile,
  'construct',
  'Attach to the scheduler',
  '    this.#engine = engineFor(config);',
  '      runDue: () => this.#runDue(),\n    });'
);
const enqueue = sourceExcerpt(
  fanout,
  fanoutFile,
  'enqueue',
  'Accept a batch',
  '  async enqueue(',
  '    return { success: true, value: entries.map(({ id }) => id), load };\n  }'
);
const runTarget = sourceExcerpt(
  fanout,
  fanoutFile,
  'run-target',
  'Claim a batch per target',
  '  async #runDue(): Promise<void> {',
  '      release();\n    }\n  }'
);
const deliver = sourceExcerpt(
  fanout,
  fanoutFile,
  'deliver',
  'Call the target outside the transaction',
  '  async #deliver(',
  '        serializeError(failure),\n        startedAt\n      );\n    }\n  }'
);
const remove = sourceExcerpt(
  fanout,
  fanoutFile,
  'remove',
  'Delete one settled delivery',
  '  #removeDelivery(sql: SqlStorage, row: DeliveryRow): boolean {',
  '    return true;\n  }'
);
const retry = sourceExcerpt(
  fanout,
  fanoutFile,
  'retry',
  'Store the next attempt time',
  '  async #retry(',
  '      nextAttemptAt,\n      error,\n    });\n  }'
);
const deadLetter = sourceExcerpt(
  fanout,
  fanoutFile,
  'dead-letter',
  'Record intent, then write the DLQ',
  '  async #deadLetter(',
  '        caught\n      );\n    }\n  }'
);
const listDue = sourceExcerpt(
  fanout,
  fanoutFile,
  'list-due',
  'First deliveries, then retries',
  '  #listDue(target: string, now: number): DeliveryRow[] {',
  '    return [...first, ...retries];\n  }'
);
const reconcile = sourceExcerpt(
  scheduler,
  schedulerFile,
  'reconcile',
  'Set the object alarm',
  '  private async reconcile(',
  '    return timerTimes.length === 0 ? undefined : Math.min(...timerTimes);\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'fanout',
  title: 'How DurabilityFanout uses your Durable Object',
  summary:
    'Fanout stores every accepted message and one delivery row per target in the object’s SQLite storage, and the shared scheduler’s alarm keeps unsettled deliveries moving. Step through one email batch, then evict the object mid-delivery and dead-letter a target.',
  diagram: {
    canvas: { width: 1000, height: 900 },
    direction: 'down',
    routing: 'auto',
    flows: {
      register: { label: 'accept a batch', color: 'blue' },
      run: { label: 'deliver to a target', color: 'orange' },
      recover: { label: 'recover from the alarm', color: 'green' },
    },
    nodes: {
      caller: {
        rank: 0,
        row: 1,
        label: 'Worker',
        sublabel: 'routing.push()',
        icon: 'workers',
        tone: 'external',
      },
      object: {
        rank: 1,
        row: 1,
        label: 'EmailDelivery',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      fanout: {
        rank: 2,
        row: 1,
        label: 'DurabilityFanout',
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
        label: 'Fanout tables',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      consumer: {
        rank: 3,
        row: 2,
        label: 'EmailConsumer',
        sublabel: 'WorkerEntrypoint RPC',
        icon: 'workers',
        tone: 'external',
      },
      api: {
        rank: 4,
        row: 2,
        label: 'Email API',
        sublabel: 'external service',
        icon: 'browser',
        tone: 'external',
      },
      r2: {
        rank: 4,
        row: 0,
        label: 'R2 bucket',
        sublabel: 'archive and DLQ',
        icon: 'r2',
        tone: 'external',
      },
    },
    edges: [
      {
        from: 'caller',
        to: 'object',
        label: 'enqueue(batch)',
        flow: 'register',
      },
      { from: 'object', to: 'fanout', label: 'enqueue()', flow: 'register' },
      { from: 'fanout', to: 'sqlite', label: 'rows', flow: 'register' },
      { from: 'fanout', to: 'alarm', label: 'setAlarm', flow: 'register' },
      { from: 'fanout', to: 'consumer', label: 'consume(batch)', flow: 'run' },
      { from: 'consumer', to: 'api', label: 'Idempotency-Key', flow: 'run' },
      {
        from: 'consumer',
        to: 'object',
        label: 'message.ack()',
        flow: 'run',
        back: true,
      },
      { from: 'fanout', to: 'r2', label: 'put(message)', flow: 'run' },
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
        contains: ['object', 'fanout', 'alarm', 'sqlite'],
      },
    ],
  },
  details: {
    caller: {
      description:
        'The fetch handler pushes through DurabilityRouting. The sharding function picks one shard name for the whole batch, and routing calls enqueue() on the object with that name.',
      href: '/primitives/routing/',
      source: 'fetch',
    },
    object: {
      description:
        'Your class. It owns the scheduler and the fanout as fields, so both are rebuilt whenever the runtime creates a new instance. Its alarm() must delegate to scheduler.alarm().',
      href: '/primitives/fanout/',
      source: 'email-delivery',
    },
    fanout: {
      description:
        'Holds the static targets and the DLQ writer, plus in-memory state lost on eviction: the running pass per target, settlement closures for in-flight messages, and a cached pending count. Permits and timers belong to the shared scheduler.',
      href: '/primitives/scheduler/',
      source: 'construct',
    },
    alarm: {
      description:
        'The object’s single alarm, owned by the shared scheduler. Every fanout transaction sets it to the earliest pending delivery, never sooner than alarmMinDelayMs, so unsettled work brings the object back after eviction.',
      href: '/primitives/scheduler/',
      source: 'reconcile',
    },
    sqlite: {
      description:
        'durability_fanout_messages holds one manifest per deduplication key with its frozen target list; durability_fanout_deliveries holds one row per message and target with attempt, phase, and due time; durability_fanout_seq orders first deliveries.',
      href: '/reference/storage/',
      source: 'enqueue',
    },
    consumer: {
      description:
        'A separate Worker entrypoint reached over a service binding. Each message it receives carries ack(), retry(), and deadLetter(); each call is an RPC back into the object.',
      href: '/compositions/email-delivery/',
      source: 'consumer',
    },
    api: {
      description:
        'The external email service. It must deduplicate on the Idempotency-Key header, because a delivery can repeat after an eviction or a lost acknowledgement.',
      href: '/reference/guarantees/',
      source: 'consumer',
    },
    r2: {
      description:
        'One bucket, two prefixes. The archive storage target writes every message under email-archive/; the dlq writer stores terminal deliveries under email-dlq/. Both refuse to overwrite an existing key.',
      href: '/primitives/fanout/',
      source: 'email-delivery',
    },
  },
  excerpts: [
    emailDelivery,
    consumer,
    fetchHandler,
    construct,
    enqueue,
    runTarget,
    listDue,
    deliver,
    remove,
    retry,
    deadLetter,
    reconcile,
  ],
  scenarios: [
    {
      id: 'deliver',
      title: 'Accept and deliver a batch',
      description:
        'Follow one email batch from the routed RPC call to an acknowledged delivery row.',
      steps: [
        {
          id: 'field',
          title: 'Fanout belongs to the object instance',
          description:
            'The scheduler is built from this.ctx, and the fanout attaches to it with two static targets: email and archive. Target IDs and their callbacks are fixed at construction.',
          stage: ['object', 'fanout', 'durable-object', 'focus:fanout'],
          source: sourceFocus(
            emailDelivery,
            'private readonly scheduler = new DurabilityScheduler({ context: this.ctx });',
            'private readonly fanout = new DurabilityFanout<Email>({'
          ),
          durable: 'Nothing is written yet.',
          volatile:
            'The scheduler, the fanout, and their target maps exist for this instance only.',
          status: 'normal',
        },
        {
          id: 'migrate',
          title: 'Create tables in the object’s SQLite',
          description:
            'The constructor applies the fanout and memo migrations through ctx.storage.sql, then registers the deliveries table with the scheduler so every alarm pass runs due deliveries.',
          stage: ['sqlite', 'focus:sqlite'],
          source: sourceFocus(
            construct,
            "this.#engine.migrateSchema('fanout', durabilityFanoutMigrations);",
            'runDue: () => this.#runDue(),'
          ),
          durable:
            'The fanout messages, deliveries, and sequence tables and durability_memos exist in this object.',
          volatile:
            'The registration with the scheduler is in memory and repeats on each construction.',
          status: 'commit',
        },
        {
          id: 'rpc',
          title: 'A Worker routes the batch to one shard',
          description:
            'The fetch handler pushes through routing, which picks one shard name for the whole batch and calls enqueue() on that object. The object forwards the batch to fanout.enqueue().',
          stage: ['caller', 'flow:register'],
          source: sourceFocus(
            fetchHandler,
            'const result = await routing',
            '.push({ messages });'
          ),
          durable: 'Nothing is written until the transaction commits.',
          volatile: 'The RPC call waits for acceptance.',
          status: 'normal',
        },
        {
          id: 'accept',
          title: 'Insert manifests and delivery rows',
          description:
            'One transaction inserts a manifest per message, with its sorted target list, and one pending delivery row per target. A repeated deduplication key with the same ID, payload, and targets is skipped; different work under it rejects the whole batch.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            enqueue,
            'registered = await this.#transaction((sql) => {',
            'ON CONFLICT(id) DO NOTHING'
          ),
          durable:
            'Each message and its email and archive deliveries commit together, or none do.',
          volatile: 'The cached pending count grows with each inserted row.',
          status: 'commit',
        },
        {
          id: 'arm',
          title: 'Set the alarm in the same transaction',
          description:
            'Before the transaction commits, the scheduler sets the object’s one alarm to the earliest pending delivery, no sooner than alarmMinDelayMs (15 seconds by default). A delivery row cannot commit without its alarm.',
          stage: ['alarm', '-alarm->object', 'focus:alarm'],
          source: sourceFocus(
            reconcile,
            'const target = Math.max(physicalNextAt, Date.now() + this.alarmMinDelayMs);',
            'await physicalAlarm.setAlarm(target);'
          ),
          durable: 'The alarm is stored with the rows it serves.',
          volatile:
            'Work due sooner than the alarm uses the scheduler’s in-memory timer.',
          status: 'commit',
        },
        {
          id: 'eager',
          title: 'Acceptance returns; delivery starts in the background',
          description:
            'enqueue() resolves with the message IDs once the batch commits; success means accepted, not delivered. With batchDelayMs at 0 it starts a due pass and hands the promise to ctx.waitUntil.',
          stage: ['focus:fanout'],
          source: sourceFocus(
            enqueue,
            'if (registered.length > 0 && this.#batchDelayMs === 0) {',
            'this.#engine.waitUntil(work, onError);'
          ),
          durable: 'The manifests, deliveries, and alarm are committed.',
          volatile: 'The background pass exists only in this instance.',
          status: 'normal',
        },
        {
          id: 'claim',
          title: 'Claim one batch per target',
          description:
            'Each target runs its own pass under a scheduler permit. One transaction claims up to maxBatchSize (25 here) due rows, incrementing each attempt and moving its due time to the attempt deadline.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            runTarget,
            'const { claims, terminal } = await this.#transaction((sql) => {',
            '            deadline\n          );'
          ),
          durable:
            'Attempt 1 is stored, and each claimed row is due again at its deadline if nothing settles it.',
          volatile:
            'The per-target pass and its permit are held in memory until it finishes.',
          status: 'commit',
        },
        {
          id: 'deliver',
          title: 'Call each target outside the transaction',
          description:
            'Fanout builds one message per claimed row, each with its own ack(), retry(), and deadLetter(), and calls the target under attemptTimeoutMs (30 seconds here). The email callback forwards the batch to EmailConsumer, which posts each email with its message ID as the idempotency key. The archive target’s own pass writes each message to R2 and acks it automatically.',
          stage: ['consumer', 'api', 'r2', '-consumer->object', 'flow:run'],
          source: sourceFocus(
            deliver,
            'await this.#deadline(async () => {',
            'await message.ack();'
          ),
          durable:
            'The delivery rows stay pending while the requests are in flight.',
          volatile:
            'The consume() RPC, the fetch, the R2 put, and the settlement closure for each message.',
          status: 'normal',
        },
        {
          id: 'ack',
          title: 'ack() settles only this target',
          description:
            'message.ack() is an RPC back into the object. It deletes the email delivery row only if this attempt still owns it, decrements the manifest, and deletes the manifest once no target remains.',
          stage: ['+consumer->object', 'focus:consumer'],
          source: sourceFocus(
            remove,
            'if (!deleteAttempt(sql, deliveriesTable, attemptOf(row))) {',
            'WHERE key = ? AND remaining = 0`,'
          ),
          durable:
            'The email delivery and its memos are deleted; the archive delivery settles on its own.',
          volatile: 'The cached pending count drops by one.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Evict the object mid-delivery',
      description:
        'An illustrative eviction while the consumer is sending, not execution of the example code.',
      steps: [
        {
          id: 'evicted',
          title: 'The object is evicted before ack() commits',
          description:
            'Assume the email API accepts the message, but the runtime evicts the object before message.ack() reaches it. The archive target had already written to R2 and acknowledged its own delivery.',
          stage: ['*', 'flow:run'],
          source: sourceFocus(consumer, 'await message.ack();'),
          durable:
            'The email delivery is pending with attempt 1 and due at its claim deadline; the alarm is set for it.',
          volatile:
            'The running passes, permits, settlement closures, cached count, and timers are lost.',
          status: 'failure',
        },
        {
          id: 'wake',
          title: 'The alarm starts a new instance',
          description:
            'When the alarm fires, the runtime constructs a new instance, which rebuilds the scheduler and fanout, and calls alarm(). The class must delegate it to scheduler.alarm().',
          stage: ['flow:recover'],
          source: sourceFocus(
            emailDelivery,
            'override alarm(info?: AlarmInvocationInfo) {',
            'return this.scheduler.alarm(info);'
          ),
          durable: 'The alarm, the delivery row, and its attempt count.',
          volatile: 'A fresh fanout with no running passes.',
          status: 'recovery',
        },
        {
          id: 'due',
          title: 'Select due retries after first deliveries',
          description:
            'Each target’s pass reads first deliveries in enqueue order, then fills the batch with due retries. The interrupted row has attempt 1, so it comes from the retry query.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            listDue,
            'const retries = deliveryRowSchema.array().parse(',
            'AND attempt > 0 AND next_attempt_at <= ?'
          ),
          durable: 'Rows are read, not changed.',
          volatile: 'The due list for this pass.',
          status: 'recovery',
        },
        {
          id: 'reclaim',
          title: 'Claim attempt 2 for the email target only',
          description:
            'The interrupted attempt counts toward maxAttempts (5 here). The archive target has no row left, so only email is delivered again, with the same message ID.',
          stage: ['focus:fanout'],
          source: sourceFocus(runTarget, 'const attempt = claimAttempt('),
          durable: 'The stored attempt becomes 2.',
          volatile: 'A new consume() call replaces the lost one.',
          status: 'recovery',
        },
        {
          id: 'receiver',
          title: 'The email API must deduplicate',
          description:
            'The API already sent the first email. Only its handling of the repeated Idempotency-Key prevents a second one; the object cannot prove what the API committed.',
          stage: ['focus:api'],
          source: sourceFocus(
            consumer,
            "headers: { 'Idempotency-Key': message.id },"
          ),
          durable:
            'At-least-once delivery: exactly-once effects need the receiver’s own deduplication record.',
          volatile: 'Nothing from the first attempt survived in memory.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'dead-letter',
      title: 'Retry and dead-letter one target',
      description:
        'How a target that keeps failing moves to the DLQ without resending to the consumer.',
      steps: [
        {
          id: 'retry',
          title: 'The consumer asks for a retry',
          description:
            'On a 429 the consumer calls message.retry(30_000). Fanout stores the next attempt time in a transaction that also resets the alarm; a consumer that returns without settling gets the policy delay instead.',
          stage: ['*', 'focus:consumer'],
          source: sourceFocus(
            retry,
            'await this.#transaction((sql) => {',
            "'next_attempt_at = ?, last_error = ?, last_error_name = ?',"
          ),
          durable:
            'The new due time and the error are stored on the delivery row.',
          volatile: 'The settlement closure for this attempt is closed.',
          status: 'commit',
        },
        {
          id: 'exhausted',
          title: 'The attempt budget runs out',
          description:
            'Once the stored attempt reaches maxAttempts, the next retry becomes a dead letter instead. A consumer can also call deadLetter() directly, as it does on a 400.',
          stage: ['focus:fanout'],
          source: sourceFocus(
            retry,
            'if (row.attempt >= policy.maxAttempts) {',
            "await this.#deadLetter(claim, 'exhausted', error);"
          ),
          durable: 'The row is still pending, with its last error.',
          volatile: 'The decision is made in memory.',
          status: 'failure',
        },
        {
          id: 'intent',
          title: 'Store dead-letter intent first',
          description:
            'Before any external write, the row moves to the dead_letter phase in a transaction, due again 60 seconds later. An eviction or timeout after this point can no longer turn the decision into another consumer delivery.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            deadLetter,
            'await this.#transaction((sql) => {',
            'Date.now() + infrastructureRetryMs,'
          ),
          durable: 'phase = dead_letter, with its reason and timestamp.',
          volatile: 'The stored message being built for the DLQ.',
          status: 'commit',
        },
        {
          id: 'dlq',
          title: 'Write the dead letter to R2',
          description:
            'The dlq writer stores the message under email-dlq/, keyed by the delivery identity and refusing to overwrite. Only after it succeeds is the delivery row deleted.',
          stage: ['focus:r2'],
          source: sourceFocus(
            emailDelivery,
            'dlq: async (message) => {',
            '`${deadLetterPrefix}${encodeURIComponent(message.id)}`,'
          ),
          durable: 'The R2 object, then the row deletion.',
          volatile: 'The put request.',
          status: 'normal',
        },
        {
          id: 'dlq-failed',
          title: 'A failed DLQ write keeps the intent',
          description:
            'If R2 fails, the error is reported and the row stays in the dead_letter phase. The next pass sends it straight back to the DLQ path, never to the consumer.',
          stage: ['focus:fanout'],
          source: sourceFocus(
            runTarget,
            "row.phase === 'dead_letter' ||",
            'exhausted.push({ row, message });'
          ),
          durable:
            'The dead_letter row, due again in 60 seconds, with its alarm.',
          volatile: 'The failed write and its error.',
          status: 'recovery',
        },
        {
          id: 'gap',
          title: 'Retried writes must collapse',
          description:
            'A crash after R2 accepts the write but before the row is deleted repeats the write. The onlyIf condition makes the repeat a no-op; redrive and retention of the prefix are application code.',
          stage: ['focus:r2'],
          source: sourceFocus(
            deadLetter,
            'await this.#deadline(() => this.#dlq!(stored), infrastructureRetryMs);',
            'await this.#remove(row);'
          ),
          durable: 'The R2 entry is keyed by the delivery identity.',
          volatile: 'Nothing in the object records that the write succeeded.',
          status: 'gap',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
