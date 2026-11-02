import emailSource from '../../../examples/email-queue/worker.ts?raw';
import fanoutSource from '../../../packages/durability/src/fanout.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const file = 'examples/email-queue/worker.ts';
const fanoutFile = 'packages/durability/src/fanout.ts';

const consumer = sourceExcerpt(
  emailSource,
  file,
  'consumer',
  'EmailConsumer.consume',
  'export class EmailConsumer extends WorkerEntrypoint<Env> {',
  '      // Unsettled messages retry; exhausting the budget dead-letters this target only.\n    }\n  }\n}'
);
const delivery = sourceExcerpt(
  emailSource,
  file,
  'delivery',
  'EmailDelivery Durable Object',
  '/** The application owns this DO and composes its capabilities explicitly. */',
  '    return this.scheduler.alarm(info);\n  }\n}'
);
const routing = sourceExcerpt(
  emailSource,
  file,
  'routing',
  'Routing client and VIP lane',
  'export const routing = DurabilityRouting.client({',
  '      next({ context: { lane: name } })\n);'
);
const redrive = sourceExcerpt(
  emailSource,
  file,
  'redrive',
  'Accepted-target redrive',
  'export async function redrive(env: Env, after: number): Promise<number> {',
  '  return accepted;\n}'
);
const fetchHandler = sourceExcerpt(
  emailSource,
  file,
  'fetch',
  'Accept an HTTP batch',
  'export default {',
  '} satisfies ExportedHandler<Env>;'
);
const enqueue = sourceExcerpt(
  fanoutSource,
  fanoutFile,
  'fanout-enqueue',
  'Accept the batch in one transaction',
  '  async enqueue(',
  '    return { success: true, value: entries.map(({ id }) => id), load };\n  }'
);
const runDue = sourceExcerpt(
  fanoutSource,
  fanoutFile,
  'fanout-run-due',
  'Find targets with work',
  '  async #runDue(): Promise<void> {',
  '    );\n  }'
);
const runTarget = sourceExcerpt(
  fanoutSource,
  fanoutFile,
  'fanout-run-target',
  'Claim a batch for one target',
  '  async #runTarget(id: string): Promise<void> {',
  '      release();\n    }\n  }'
);
const removeDelivery = sourceExcerpt(
  fanoutSource,
  fanoutFile,
  'fanout-remove',
  'Settle one delivery',
  '  #removeDelivery(sql: SqlStorage, row: DeliveryRow): boolean {',
  '    return true;\n  }'
);
const retry = sourceExcerpt(
  fanoutSource,
  fanoutFile,
  'fanout-retry',
  'Back off or dead-letter a failed delivery',
  '  async #retry(',
  '      error,\n    });\n  }'
);
const deadLetter = sourceExcerpt(
  fanoutSource,
  fanoutFile,
  'fanout-dead-letter',
  'Persist the dead-letter decision first',
  '  async #deadLetter(',
  '        caught\n      );\n    }\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'email',
  title: 'Durable email fan-out',
  summary:
    'Routing picks one EmailDelivery object by name. Its fanout stores an independent email and archive obligation in the object’s SQLite storage, and the object’s alarm resumes them after eviction. Step through a delivery, a lost acknowledgement, and a redrive.',
  diagram: {
    canvas: { width: 1000, height: 950 },
    direction: 'down',
    routing: 'auto',
    flows: {
      accept: { label: 'accept a batch', color: 'blue' },
      deliver: { label: 'deliver the email', color: 'orange' },
      archive: { label: 'archive and park', color: 'purple' },
      recover: { label: 'resume from the alarm', color: 'green' },
      redrive: { label: 'redrive a parked target', color: 'red' },
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
      redrive: {
        rank: 0,
        row: 2,
        label: 'redrive()',
        sublabel: 'admin function',
        icon: 'workers',
        tone: 'external',
      },
      routing: {
        rank: 1,
        row: 1,
        label: 'Routing client',
        sublabel: 'one shard per push',
        icon: 'shield',
      },
      delivery: {
        rank: 2,
        row: 1,
        label: 'EmailDelivery',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      bucket: {
        rank: 2,
        row: 2,
        label: 'R2 bucket',
        sublabel: 'DEAD_LETTERS',
        size: [220, 72],
        icon: 'r2',
        tone: 'external',
      },
      fanout: {
        rank: 3,
        row: 1,
        label: 'DurabilityFanout',
        sublabel: 'in memory',
        icon: 'shield',
      },
      objectAlarm: {
        rank: 4,
        row: 0,
        label: 'Object alarm',
        sublabel: 'ctx.storage.setAlarm',
        icon: 'clock',
      },
      tables: {
        rank: 4,
        row: 1,
        label: 'Fanout tables',
        sublabel: 'durability_fanout_*',
        icon: 'database',
      },
      consumer: {
        rank: 4,
        row: 2,
        label: 'EmailConsumer',
        sublabel: 'WorkerEntrypoint',
        size: [270, 72],
        icon: 'workers',
      },
      provider: {
        rank: 5,
        row: 2,
        label: 'Email API',
        sublabel: 'external service',
        icon: 'browser',
        tone: 'external',
      },
    },
    edges: [
      { from: 'worker', to: 'routing', label: 'push()', flow: 'accept' },
      {
        from: 'routing',
        to: 'delivery',
        label: 'enqueue(batch)',
        flow: 'accept',
      },
      {
        from: 'delivery',
        to: 'fanout',
        label: 'fanout.enqueue()',
        flow: 'accept',
      },
      { from: 'fanout', to: 'tables', label: 'rows', flow: 'accept' },
      {
        from: 'fanout',
        to: 'objectAlarm',
        label: 'setAlarm',
        flow: 'accept',
      },
      {
        from: 'objectAlarm',
        to: 'delivery',
        label: 'alarm()',
        flow: 'recover',
        back: true,
      },
      {
        from: 'fanout',
        to: 'consumer',
        label: 'consume() / ack()',
        flow: 'deliver',
        both: true,
      },
      {
        from: 'consumer',
        to: 'provider',
        label: 'Idempotency-Key',
        flow: 'deliver',
      },
      {
        from: 'fanout',
        to: 'bucket',
        label: 'archive / DLQ put',
        flow: 'archive',
      },
      {
        from: 'redrive',
        to: 'bucket',
        label: 'list, get, delete',
        flow: 'redrive',
      },
      {
        from: 'redrive',
        to: 'routing',
        label: 'push(target)',
        flow: 'redrive',
      },
    ],
    groups: [
      {
        id: 'delivery-object',
        label: 'One object per shard',
        contains: ['delivery', 'fanout', 'objectAlarm', 'tables'],
      },
    ],
  },
  details: {
    worker: {
      description:
        'The demo HTTP handler. It wraps each email as { body }, so fanout generates the message IDs, and pushes the batch through the VIP lane with a five-second caller timeout. It replies 202 only when the push reports success.',
      href: '/primitives/routing/',
      source: 'fetch',
    },
    redrive: {
      description:
        'An exported administrative function, not an HTTP route. It lists parked entries in R2, re-enqueues each failed target through the routing client, and deletes an entry only after its push is accepted.',
      href: '/primitives/fanout/',
      source: 'redrive',
    },
    routing: {
      description:
        'Runs in the caller. Sharding returns the lane, or customer-<customerId> from the first message; the client calls getByName(shard) and invokes enqueue once on that one object. It owns no records.',
      href: '/primitives/routing/',
      source: 'routing',
    },
    delivery: {
      description:
        'Your class, one object per shard name. Its fields build one scheduler from this.ctx and the fanout attached to it, and its alarm() delegates to the scheduler.',
      href: '/primitives/fanout/',
      source: 'delivery',
    },
    fanout: {
      description:
        'Lives only in this object instance: target callbacks, per-target running passes, the cached backlog count, and load counters. Eviction discards it; the next instance rebuilds it from the same tables.',
      href: '/primitives/fanout/',
      source: 'delivery',
    },
    objectAlarm: {
      description:
        'The object’s single alarm. Every fanout transaction goes through the scheduler, which sets it to the earliest pending delivery, including a claimed row’s attempt deadline.',
      href: '/primitives/scheduler/',
      source: 'delivery',
    },
    tables: {
      description:
        'In ctx.storage.sql: durability_fanout_messages holds one manifest per deduplication key (ID, payload, frozen target list, remaining count); durability_fanout_deliveries holds one row per message and target; durability_fanout_seq orders them.',
      href: '/primitives/fanout/',
      source: 'fanout-enqueue',
    },
    consumer: {
      description:
        'An ordinary WorkerEntrypoint reached through the EMAIL_CONSUMER service binding. It settles each message with ack(), retry(), or deadLetter(), which call back into the delivery object.',
      href: '/primitives/fanout/',
      source: 'consumer',
    },
    provider: {
      description:
        'A separate system behind the EMAIL_API binding. It must deduplicate a repeated Idempotency-Key; the consumer only forwards the message ID.',
      href: '/reference/guarantees/',
      source: 'consumer',
    },
    bucket: {
      description:
        'One R2 bucket with two prefixes: email-archive/ for every archived message and email-dlq/ for parked failed targets. It is not the fanout’s scheduling state.',
      href: '/primitives/fanout/',
      source: 'delivery',
    },
  },
  excerpts: [
    consumer,
    delivery,
    routing,
    redrive,
    fetchHandler,
    enqueue,
    runDue,
    runTarget,
    removeDelivery,
    retry,
    deadLetter,
  ],
  scenarios: [
    {
      id: 'delivery',
      title: 'Register and deliver',
      description:
        'Follow one batch from the HTTP request to settled email and archive targets in the delivery object’s storage.',
      steps: [
        {
          id: 'request',
          title: 'The Worker pushes through the VIP lane',
          description:
            'The demo handler wraps each email as { body }, so fanout will generate message IDs. The lane transform puts the whole batch on the vip shard; the timeout transform bounds the call at five seconds.',
          stage: ['worker', 'routing', 'flow:accept'],
          source: sourceFocus(
            fetchHandler,
            'const messages = (await request.json<Email[]>()).map((body) => ({ body }));',
            '.push({ messages });'
          ),
          durable: 'No email obligation exists yet.',
          volatile: 'The request holds the batch and the lane context.',
          status: 'normal',
        },
        {
          id: 'shard',
          title: 'Pick one object by name',
          description:
            'Sharding returns the lane, or customer-<customerId> from the first message. The client calls getByName(shard) and invokes enqueue once on that object, so its storage, alarm, and backlog belong to that shard.',
          stage: ['delivery', 'delivery-object', 'flow:accept'],
          source: sourceFocus(
            routing,
            'invoke: (stub, batch: Batch) => stub.enqueue(batch),',
            "`customer-${batch.messages[0]?.body.customerId ?? 'unknown'}`,"
          ),
          durable: 'Nothing is written by routing.',
          volatile:
            'The client keeps advisory load observations per shard in memory.',
          status: 'normal',
        },
        {
          id: 'wire',
          title: 'The object composes scheduler and fanout',
          description:
            'Fields build one scheduler from this.ctx and a fanout attached to it. Constructing the fanout migrates its tables in ctx.storage.sql and registers its delivery table with the scheduler.',
          stage: ['fanout', 'focus:fanout'],
          source: sourceFocus(
            delivery,
            'private readonly scheduler = new DurabilityScheduler({ context: this.ctx });',
            'routing: this.routing,'
          ),
          durable: 'The fanout tables exist in this object’s storage.',
          volatile:
            'The scheduler, fanout, target callbacks, and load counters are rebuilt on every new instance.',
          status: 'normal',
        },
        {
          id: 'targets',
          title: 'Two independent targets',
          description:
            'email and archive are separate recipients. Every accepted message gets a delivery row per target, and each row advances on its own; neither target is ordered before the other.',
          stage: ['focus:fanout'],
          source: sourceFocus(
            delivery,
            'targets: {',
            'storage: async (message) => {'
          ),
          durable:
            'Configuration writes nothing; accepted messages store a frozen copy of the target list.',
          volatile: 'The live object holds a callback for each target ID.',
          status: 'normal',
        },
        {
          id: 'accept',
          title: 'Accept the batch in one transaction',
          description:
            'enqueue() writes a manifest per message and one delivery row per target in one storage transaction, which also sets the object alarm. A repeated key with the same message is skipped; different work under the same key returns success: false.',
          stage: [
            'tables',
            'objectAlarm',
            '-objectAlarm->delivery',
            'focus:fanout',
          ],
          source: sourceFocus(
            enqueue,
            'registered = await this.#transaction((sql) => {',
            'INSERT INTO durability_fanout_deliveries'
          ),
          durable:
            'Manifests, an email and an archive row per message, and the alarm commit together.',
          volatile: 'The cached backlog count is adjusted.',
          status: 'commit',
        },
        {
          id: 'respond',
          title: 'Reply 202 after acceptance',
          description:
            'The handler replies 202 only when enqueue reported success, so the obligations already exist. A timeout or transport error throws instead, although the enqueue may still have committed.',
          stage: ['focus:worker'],
          source: sourceFocus(
            fetchHandler,
            'return Response.json(result, { status: result.success ? 202 : 409 });'
          ),
          durable: 'Both obligations are stored before the reply.',
          volatile: 'The request can end; delivery does not depend on it.',
          status: 'commit',
        },
        {
          id: 'claim',
          title: 'Claim a batch per target',
          description:
            'Delivery starts in the background right away. Each target takes a permit, lists up to 25 due rows, and claims them in one transaction: attempt + 1 and next_attempt_at set to the 30-second attempt deadline.',
          stage: ['focus:tables'],
          source: sourceFocus(
            runTarget,
            'const deadline = Date.now() + policy.attemptTimeoutMs;',
            'claimed.push({ row: { ...row, attempt }, message });'
          ),
          durable:
            'If the object is evicted mid-delivery, the claimed rows are due again at their deadline.',
          volatile: 'The permit and the claimed batch.',
          status: 'commit',
        },
        {
          id: 'consume',
          title: 'Call EmailConsumer over RPC',
          description:
            'The email target calls the consumer through a service binding. Each message carries ack(), retry(), and deadLetter(); over Workers RPC these are stubs that call back into this EmailDelivery object.',
          stage: ['consumer', 'flow:deliver'],
          source: sourceFocus(
            delivery,
            'deliver: (messages) => this.env.EMAIL_CONSUMER.consume(messages),'
          ),
          durable: 'The email rows stay pending while the call runs.',
          volatile: 'The RPC call and its callback stubs.',
          status: 'normal',
        },
        {
          id: 'send',
          title: 'Call the provider',
          description:
            'The consumer sends the message ID as the provider’s idempotency key. The source does not implement provider deduplication.',
          stage: ['provider', 'flow:deliver'],
          source: sourceFocus(
            consumer,
            'const response = await this.env.EMAIL_API.fetch(',
            "headers: { 'Idempotency-Key': message.id },"
          ),
          durable:
            'The email obligation remains unsettled while the provider call is in flight.',
          volatile:
            'The response and message batch are held by this consumer invocation.',
          status: 'normal',
        },
        {
          id: 'ack',
          title: 'Acknowledge after success',
          description:
            'On success the consumer awaits ack(). A 429 asks for a retry in 30 seconds and a 400 dead-letters the target; any other response leaves the message unsettled, which retries it.',
          stage: ['focus:consumer'],
          source: sourceFocus(
            consumer,
            'if (response.ok) {',
            'await message.retry(30_000);'
          ),
          durable: 'The settlement is written in the delivery object.',
          volatile: 'The consumer releases the message after the await.',
          status: 'commit',
        },
        {
          id: 'release',
          title: 'Delete the delivery row',
          description:
            'ack deletes the row only if this attempt still owns it, decrements the manifest’s remaining count, and deletes the manifest once every target has settled. Only then can the same ID be registered as new work on this object.',
          stage: ['focus:tables'],
          source: sourceFocus(
            removeDelivery,
            'if (!deleteAttempt(sql, deliveriesTable, attemptOf(row))) {',
            'WHERE key = ? AND remaining = 0`,'
          ),
          durable:
            'The email row is gone; the archive row follows its own path.',
          volatile: 'The cached backlog count drops by one.',
          status: 'commit',
        },
        {
          id: 'archive',
          title: 'The archive target runs on its own',
          description:
            'The archive row is claimed and written independently, keyed by its delivery identity. The conditional put refuses to overwrite, so a retried write leaves the first object in place, and the target is acked after the write.',
          stage: ['bucket', 'flow:archive'],
          source: sourceFocus(
            delivery,
            '`${archivePrefix}${encodeURIComponent(message.id)}`,',
            "{ onlyIf: { etagDoesNotMatch: '*' } }"
          ),
          durable:
            'An archive object in R2; the archive row is deleted after its ack.',
          volatile: 'Archive success never waits for the provider.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'lost-ack',
      title: 'Provider effect before acknowledgement',
      description:
        'The at-least-once duplicate-effect window, not a claim that the Worker can undo or reconcile a provider send.',
      steps: [
        {
          id: 'attempt',
          title: 'Issue the first send',
          description:
            'The provider can accept the request before the local acknowledgement is made.',
          stage: ['*', 'flow:deliver'],
          source: sourceFocus(
            consumer,
            'const response = await this.env.EMAIL_API.fetch(',
            "headers: { 'Idempotency-Key': message.id },"
          ),
          durable: 'The email row is claimed with a 30-second deadline.',
          volatile: 'The invocation waits for the provider response.',
          status: 'normal',
        },
        {
          id: 'thrown',
          title: 'A thrown call schedules a retry',
          description:
            'If the provider sends the email but the consume call then throws while EmailDelivery is still running, fanout observes the failure. It schedules the next attempt after the retry backoff, or dead-letters the target to the R2 park once five attempts are used.',
          stage: ['focus:fanout'],
          source: sourceFocus(
            retry,
            'if (row.attempt >= policy.maxAttempts) {',
            'nextAttemptAt = Date.now() + delay;'
          ),
          durable:
            'The email row with a new next attempt time, or the dead-letter decision.',
          volatile: 'The thrown error, recorded as last_error.',
          status: 'failure',
        },
        {
          id: 'crash',
          title: 'Evicted before ack',
          description:
            'If instead EmailDelivery is evicted after the provider sends the email and before ack() commits, no instance observes the failure. Nothing settles the email row and its persisted claim deadline is unchanged.',
          stage: ['focus:consumer'],
          source: sourceFocus(consumer, 'await message.ack();'),
          durable:
            'The email row is still pending, due again at its claim deadline, and the object alarm is set for it.',
          volatile:
            'The response, the RPC call, and its callback stubs are lost.',
          status: 'failure',
        },
        {
          id: 'wake',
          title: 'The alarm resumes the object',
          description:
            'After the claim deadline the alarm calls alarm() on a new EmailDelivery instance, and the scheduler’s pass lists the targets that still have rows. A settled archive row is gone and is not redelivered.',
          stage: ['flow:recover'],
          source: sourceFocus(
            delivery,
            'override alarm(info?: AlarmInvocationInfo) {',
            'return this.scheduler.alarm(info);'
          ),
          durable: 'The email row and its attempt count.',
          volatile: 'A fresh scheduler and fanout with free permits.',
          status: 'recovery',
        },
        {
          id: 'replay',
          title: 'Redeliver with the same message ID',
          description:
            'The row is claimed again and the same message, with the same ID, reaches the consumer and then the provider.',
          stage: ['flow:deliver'],
          source: sourceFocus(
            consumer,
            "headers: { 'Idempotency-Key': message.id },"
          ),
          durable: 'The original email obligation is the one being retried.',
          volatile: 'A new consumer invocation owns the redelivery.',
          status: 'recovery',
        },
        {
          id: 'deduplicate',
          title: 'The provider must deduplicate the key',
          description:
            'If the provider honours the key, it returns the prior outcome without sending again. Otherwise this retry sends a second email; the consumer cannot guarantee provider deduplication, and an HTTP timeout is not proof that sending failed.',
          stage: ['focus:provider'],
          source: sourceFocus(
            consumer,
            'const response = await this.env.EMAIL_API.fetch(',
            "headers: { 'Idempotency-Key': message.id },"
          ),
          durable:
            'Provider-side idempotency state is external to this example.',
          volatile: 'Nothing from the first attempt survived locally.',
          status: 'gap',
        },
        {
          id: 'settle',
          title: 'Acknowledge the retry',
          description:
            'A successful response is followed by an awaited ack(), which deletes the email row in the delivery object.',
          stage: ['focus:consumer'],
          source: sourceFocus(consumer, 'await message.ack();'),
          durable: 'The email target is settled.',
          volatile: 'The consumer can release the message.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'naive',
      title: 'Why replying before persisting loses email',
      description:
        'A naive endpoint replies 202, starts the send in memory, and stores nothing. There is no naive source here: each step shows the composition line that closes the gap.',
      steps: [
        {
          id: 'naive-reply',
          title: 'Naive: reply 202 first',
          description:
            'A naive endpoint replies before anything is stored. Here the handler awaits push() and replies 202 only when result.success says the batch was accepted.',
          stage: ['*', 'focus:worker'],
          source: sourceFocus(
            fetchHandler,
            'const result = await routing',
            'return Response.json(result, { status: result.success ? 202 : 409 });'
          ),
          durable: 'Acceptance precedes the reply.',
          volatile: 'The request only waits for acceptance, not for sending.',
          status: 'normal',
        },
        {
          id: 'naive-intent',
          title: 'Naive: the email exists only in memory',
          description:
            'The naive version holds the email only in the request that is sending it. Here the manifest and per-target delivery rows commit in the delivery object before enqueue returns.',
          stage: ['focus:tables'],
          source: sourceFocus(
            enqueue,
            'INSERT INTO durability_fanout_messages'
          ),
          durable: 'Each obligation is a row in the object’s storage.',
          volatile: 'Nothing about the email is held only in memory.',
          status: 'commit',
        },
        {
          id: 'naive-stop',
          title: 'Naive: a stop loses the email',
          description:
            'If the naive process stops before sending, the caller believes in an email that never leaves. Here the same transaction set the object alarm, and every alarm pass lists the targets that still have rows.',
          stage: ['flow:recover'],
          source: sourceFocus(
            runDue,
            'SELECT DISTINCT target_id FROM durability_fanout_deliveries'
          ),
          durable: 'The rows and the alarm survive the stop.',
          volatile: 'The interrupted request is gone.',
          status: 'recovery',
        },
        {
          id: 'naive-duplicate',
          title: 'Stored intent is still at least once',
          description:
            'Persisting intent closes the loss window but not the duplicate one: a send whose ack is lost is retried with the same key. The “Provider effect before acknowledgement” scenario steps through it.',
          stage: ['focus:provider'],
          source: sourceFocus(
            consumer,
            "headers: { 'Idempotency-Key': message.id },"
          ),
          durable: 'The provider’s deduplication record decides.',
          volatile: 'No local state proves what the provider committed.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'redrive',
      title: 'Redrive one parked target',
      description:
        'After a target’s retries are exhausted, redrive re-enqueues only that target and deletes its R2 entry only after acceptance.',
      steps: [
        {
          id: 'decide',
          title: 'Store the dead-letter decision first',
          description:
            'When a target exhausts five attempts or the consumer calls deadLetter(), fanout first marks the row phase = dead_letter in a transaction, so an eviction cannot turn the decision into another consumer delivery.',
          stage: ['*', 'focus:tables'],
          source: sourceFocus(
            deadLetter,
            "`phase = 'dead_letter', dead_lettered_at = ?, dead_letter_reason = ?,"
          ),
          durable: 'The row is in the dead-letter phase.',
          volatile: 'The failed delivery attempt has ended.',
          status: 'failure',
        },
        {
          id: 'park',
          title: 'Park the failed target in R2',
          description:
            'The dlq callback writes the entry under email-dlq/, keyed by the delivery identity and refusing to overwrite. The row is deleted after the write succeeds; a failed write is retried 60 seconds later.',
          stage: ['flow:archive'],
          source: sourceFocus(delivery, 'dlq: async (message) => {', '    },'),
          durable:
            'An R2 entry records the failed target; sibling targets are not parked.',
          volatile: 'Nothing; the decision was stored before the write.',
          status: 'commit',
        },
        {
          id: 'read',
          title: 'Read the parked entry',
          description:
            'redrive() lists the email-dlq/ prefix, skips entries older than the 30-day replay window, and keeps each entry’s target and message ID.',
          stage: ['focus:redrive'],
          source: sourceFocus(
            redrive,
            'const entry = (await stored.json()) as StoredMessage<Email>;'
          ),
          durable:
            'The R2 entry remains until a target-specific push is accepted.',
          volatile: 'The redrive loop has one decoded entry.',
          status: 'normal',
        },
        {
          id: 'accept',
          title: 'Re-enqueue only that target',
          description:
            'The push names only the recorded target and uses the entry ID as the deduplication key. It has no lane context, so sharding picks customer-<customerId>, which need not be the object that parked the entry.',
          stage: ['flow:redrive'],
          source: sourceFocus(
            redrive,
            'const result = await routing.push({',
            '});'
          ),
          durable:
            'A new single-target obligation exists; the R2 entry is still present.',
          volatile:
            'The result is held while the loop decides whether deletion is safe.',
          status: 'commit',
        },
        {
          id: 'delete',
          title: 'Delete only after acceptance',
          description:
            'Rejection or uncertainty keeps the entry. A crash between acceptance and deletion can redrive it again; deduplication only holds on the same object while the new registration is still retained.',
          stage: ['focus:bucket'],
          source: sourceFocus(
            redrive,
            'await env.DEAD_LETTERS.delete(object.key);'
          ),
          durable:
            'The accepted entry is removed only after the delete completes.',
          volatile: 'The loop advances its accepted count.',
          status: 'recovery',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
