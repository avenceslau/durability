import worker from '../../../packages/durability/tests/outbox/worker.ts?raw';
import outbox from '../../../packages/durability/src/outbox/index.ts?raw';
import scheduler from '../../../packages/durability/src/scheduler/index.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const workerFile = 'packages/durability/tests/outbox/worker.ts';
const outboxFile = 'packages/durability/src/outbox/index.ts';
const schedulerFile = 'packages/durability/src/scheduler/index.ts';

const outboxObject = sourceExcerpt(
  worker,
  workerFile,
  'outbox-object',
  'OutboxObject Durable Object',
  'export class OutboxObject extends DurableObject {',
  '    return this.scheduler.alarm(info);\n  }'
);
const config = sourceExcerpt(
  outbox,
  outboxFile,
  'config',
  'The publish contract',
  'export type DurabilityOutboxConfig<Value> = SchedulerAttachment & {',
  '  onLifecycleEvent?: LifecycleHook;\n};'
);
const construct = sourceExcerpt(
  outbox,
  outboxFile,
  'construct',
  'Attach to the object storage',
  '    this.#engine = engineFor(config);',
  '    this.#attach();\n  }'
);
const stage = sourceExcerpt(
  outbox,
  outboxFile,
  'stage',
  'Replace the key’s pending row',
  '  #stageIn(sql: SqlStorage, key: string, value: Value): OutboxRow {',
  '    return staged;\n  }'
);
const registerChannel = sourceExcerpt(
  scheduler,
  schedulerFile,
  'register-channel',
  'Run attached channels, retain the rest',
  '  registerChannel(participant: ChannelParticipant): void {',
  '          now\n        );\n      }\n    });\n  }'
);
const runDue = sourceExcerpt(
  outbox,
  outboxFile,
  'run-due',
  'One publish run per channel',
  '  async #runDue(): Promise<void> {',
  '      release();\n    }\n  }'
);
const listDue = sourceExcerpt(
  outbox,
  outboxFile,
  'list-due',
  'Select a channel’s due rows',
  'const listDueForChannel = (',
  '      .toArray()\n  );'
);
const runBatch = sourceExcerpt(
  outbox,
  outboxFile,
  'run-batch',
  'Claim a batch with a deadline',
  '  async #runBatch(key?: string): Promise<void> {',
  '      await this.#publishBatch(claims);\n    }\n  }'
);
const publishBatch = sourceExcerpt(
  outbox,
  outboxFile,
  'publish-batch',
  'Publish, then acknowledge or retry',
  '  async #publishBatch(claims: OutboxRow[]): Promise<void> {',
  '          retried.push({ row, nextAttemptAt });\n        }\n      }\n    });'
);
const retryDelay = sourceExcerpt(
  outbox,
  outboxFile,
  'retry-delay',
  'Never strand an entry',
  '  #retryDelay(attempt: number): number {',
  '    return infrastructureRetryMs;\n  }'
);
const deadline = sourceExcerpt(
  outbox,
  outboxFile,
  'deadline',
  'Time out without cancelling',
  '  async #deadline(run: () => unknown): Promise<void> {',
  '        clearTimeout(timer);\n      }\n    }\n  }'
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

export const walkthrough = validateWalkthrough({
  id: 'outbox',
  title: 'How DurabilityOutbox uses your Durable Object',
  summary:
    'The outbox keeps the newest version of each key in the object’s SQLite storage, staged in the same transaction as the state it describes, and the shared scheduler’s alarm republishes it until publish acknowledges it. Step through a stage, an eviction mid-publish, a restage during a publish, and a failed publish.',
  diagram: {
    canvas: { width: 1000, height: 900 },
    direction: 'down',
    routing: 'auto',
    flows: {
      register: { label: 'stage a value', color: 'blue' },
      publish: { label: 'publish a batch', color: 'orange' },
      recover: { label: 'recover from the alarm', color: 'green' },
    },
    nodes: {
      caller: {
        rank: 0,
        row: 1,
        label: 'Worker',
        sublabel: 'RPC caller',
        icon: 'workers',
        tone: 'external',
      },
      object: {
        rank: 1,
        row: 1,
        label: 'OutboxObject',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      counters: {
        rank: 2,
        row: 2,
        label: 'counters',
        sublabel: 'your table',
        icon: 'database',
      },
      outbox: {
        rank: 2,
        row: 1,
        label: 'DurabilityOutbox',
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
        label: 'durability_outbox',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      publish: {
        rank: 3,
        row: 2,
        label: 'publish()',
        sublabel: 'your callback',
        icon: 'workers',
      },
      sink: {
        rank: 4,
        row: 2,
        label: 'Sink',
        sublabel: 'keeps highest version',
        icon: 'kv',
        tone: 'external',
      },
    },
    edges: [
      { from: 'caller', to: 'object', label: 'set()', flow: 'register' },
      { from: 'object', to: 'counters', label: 'INSERT', flow: 'register' },
      { from: 'object', to: 'outbox', label: 'stage()', flow: 'register' },
      { from: 'outbox', to: 'sqlite', label: 'rows', flow: 'register' },
      { from: 'outbox', to: 'alarm', label: 'setAlarm', flow: 'register' },
      { from: 'outbox', to: 'publish', label: 'entries', flow: 'publish' },
      {
        from: 'publish',
        to: 'sink',
        label: 'key, version',
        flow: 'publish',
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
        contains: [
          'object',
          'counters',
          'outbox',
          'alarm',
          'sqlite',
          'publish',
        ],
      },
    ],
  },
  details: {
    caller: {
      description:
        'Any caller with a stub to the object. It calls set() over RPC; only the object can stage values for its keys.',
      href: '/primitives/outbox/',
      source: 'outbox-object',
    },
    object: {
      description:
        'Your class. The scheduler and the outbox are fields, so both are rebuilt whenever the runtime creates a new instance. set() wraps its own write and stage() in ctx.storage.transaction(), and alarm() must delegate to scheduler.alarm().',
      href: '/primitives/outbox/',
      source: 'outbox-object',
    },
    counters: {
      description:
        'The application state the outbox describes, in the same SQLite database. Because both writes run inside one ctx.storage.transaction(), a counter and its staged version commit or roll back together.',
      href: '/primitives/outbox/',
      source: 'outbox-object',
    },
    outbox: {
      description:
        'Owns one channel and its publish callback, and attaches that channel to the scheduler the same way every other helper attaches its channels. Only this instance holds the channel’s running batch, the retry() marks of a publish in flight, and its timeout. Permits and the in-memory timer belong to the shared scheduler. Two outboxes with one channel on one scheduler throw.',
      href: '/primitives/outbox/',
      source: 'construct',
    },
    alarm: {
      description:
        'The object’s single alarm, owned by the shared scheduler. Every outbox transaction reconciles it with the earliest pending row on the scheduler: it deletes the alarm when nothing is pending, keeps an existing alarm between that time and max(that time, now + alarmMinDelayMs), and otherwise sets it to that maximum. Unacknowledged rows therefore bring the object back after eviction.',
      href: '/primitives/scheduler/',
      source: 'reconcile',
    },
    sqlite: {
      description:
        'One row per channel and key with the newest version, payload, generation, attempt, and next attempt time. durability_outbox_seq allocates versions across the whole object and keeps counting after acknowledged rows are deleted.',
      href: '/reference/storage/',
      source: 'stage',
    },
    publish: {
      description:
        'Your callback. It runs outside any storage transaction with up to maxBatchSize entries. Returning acknowledges every entry not marked with retry(); throwing or exceeding attemptTimeoutMs retries the whole batch. The test worker writes to a local table.',
      href: '/primitives/outbox/',
      source: 'config',
    },
    sink: {
      description:
        'Where publish writes: KV, another Durable Object, or an API. A batch can be published again after an eviction, and an old timed-out write can land late, so the sink must ignore a (key, version) it has seen and keep the highest version.',
      href: '/reference/guarantees/',
      source: 'config',
    },
  },
  excerpts: [
    outboxObject,
    config,
    construct,
    registerChannel,
    stage,
    transaction,
    reconcile,
    runDue,
    listDue,
    runBatch,
    publishBatch,
    retryDelay,
    deadline,
  ],
  scenarios: [
    {
      id: 'publish',
      title: 'Stage a value and publish it',
      description:
        'Follow one set() from the RPC call through a staged row to an acknowledged publication.',
      steps: [
        {
          id: 'field',
          title: 'The outbox belongs to the object instance',
          description:
            'The scheduler is built from this.ctx, and the outbox attaches to it on the default channel with its publish callback. It reads and writes only this object’s storage.',
          stage: ['object', 'outbox', 'durable-object', 'focus:outbox'],
          source: sourceFocus(
            outboxObject,
            'private readonly scheduler = new DurabilityScheduler({ context: this.ctx });',
            'publish: (entries) => {'
          ),
          durable:
            'No value is staged yet. Constructing the outbox runs its migrations, shown next.',
          volatile:
            'The scheduler, the outbox, and the publish callback exist for this instance only.',
          status: 'normal',
        },
        {
          id: 'migrate',
          title: 'Create tables in the object’s SQLite',
          description:
            'The constructor applies the outbox migrations through ctx.storage.sql, then attaches its channel with the scheduler’s registerChannel. The first channel attached for durability_outbox registers the table with the scheduler, so every alarm pass runs the due rows of each attached channel.',
          stage: ['sqlite', 'focus:sqlite'],
          source: sourceFocus(
            construct,
            "this.#engine.migrateSchema('outbox', durabilityOutboxMigrations);",
            'this.#attach();'
          ),
          durable:
            'durability_outbox and durability_outbox_seq exist in this object’s storage.',
          volatile:
            'The channel’s registration with the scheduler repeats on each construction.',
          status: 'commit',
        },
        {
          id: 'rpc',
          title: 'A Worker calls set()',
          description:
            'set() opens ctx.storage.transaction() and writes the counter, the application state the outbox will describe.',
          stage: ['caller', 'counters', 'flow:register'],
          source: sourceFocus(
            outboxObject,
            'async set(key: string, value: number, fail = false): Promise<boolean> {',
            "'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',"
          ),
          durable: 'Nothing until the transaction commits.',
          volatile: 'The RPC call waits on the transaction.',
          status: 'normal',
        },
        {
          id: 'stage',
          title: 'Stage the newest version of the key',
          description:
            'Inside the same transaction, stage() takes the next version from durability_outbox_seq and replaces the key’s row: new payload, generation equal to the version, attempt 0, due now.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            stage,
            'const version = nextVersion(sql);',
            "VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)`,"
          ),
          durable:
            'The row is written but commits only with set()’s transaction.',
          volatile: 'The serialized payload, until the write.',
          status: 'commit',
        },
        {
          id: 'alarm',
          title: 'Reconcile the alarm, then commit with the counter',
          description:
            'stage() writes through the scheduler’s transaction, which reconciles the object alarm before it returns: an existing alarm is kept if it already falls between the earliest pending row and max(that row, now + alarmMinDelayMs); otherwise the alarm is set to that maximum. If set() throws after stage(), the counter and the outbox row roll back together.',
          stage: ['alarm', '-alarm->object', 'focus:alarm'],
          source: sourceFocus(
            transaction,
            'const result = await this.storage.transaction(async (transaction) => {',
            'nextPendingAt = await this.reconcile(transaction);'
          ),
          durable:
            'The counter, the outbox row, and its version commit together.',
          volatile:
            'An in-memory timer for a row due before the alarm, set once stage() returns.',
          status: 'commit',
        },
        {
          id: 'claim',
          title: 'A pass claims the batch',
          description:
            'The timer or the alarm runs the channel’s pass, which takes a scheduler permit. One transaction selects up to maxBatchSize due rows, increments each attempt, and moves its next attempt time to the publish deadline.',
          stage: ['focus:outbox'],
          source: sourceFocus(
            runBatch,
            'const deadline = Date.now() + this.#attemptTimeoutMs;',
            'deadline\n        );'
          ),
          durable:
            'Attempt 1 and the deadline are stored before publish starts.',
          volatile: 'The permit and the channel’s running batch.',
          status: 'commit',
        },
        {
          id: 'publish',
          title: 'Publish outside the transaction',
          description:
            'publish receives the newest version of each claimed key with its value and attempt, raced against attemptTimeoutMs. The test worker’s callback writes to a local table; a real sink is KV, another object, or an API.',
          stage: ['publish', 'sink', 'flow:publish'],
          source: sourceFocus(
            publishBatch,
            'let failure: SerializedError | undefined;',
            'await this.#deadline(() => this.#publish(entries));'
          ),
          durable: 'The row stays pending while publish runs.',
          volatile: 'The publish call, its timeout, and any retry() marks.',
          status: 'normal',
        },
        {
          id: 'ack',
          title: 'Acknowledge by deleting the matching row',
          description:
            'Returning acknowledges every entry not marked with retry(). The delete matches the claimed generation and attempt, so it removes the row only if no newer stage replaced it.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            publishBatch,
            'if (failure === undefined && !retries.has(row.id)) {',
            'acknowledged.push(row);'
          ),
          durable:
            'The row is deleted; durability_outbox_seq keeps its next version.',
          volatile: 'The permit is released and the running batch cleared.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Evict the object mid-publish',
      description:
        'An illustrative eviction while publish is in flight, not execution of the test worker.',
      steps: [
        {
          id: 'evicted',
          title: 'The object is evicted during publish',
          description:
            'Assume the sink accepted the write, but the runtime evicts the object before publish returns. The claim already moved the row’s next attempt to the deadline, attemptTimeoutMs (60 seconds by default) later, and set the alarm for it.',
          stage: ['*', 'flow:publish'],
          source: sourceFocus(
            runBatch,
            '// A crash mid-publication leaves the claim due again at the deadline.',
            'deadline\n        );'
          ),
          durable:
            'The row, pending with attempt 1 and due at the deadline, and the alarm.',
          volatile:
            'The publish call, the running batch, the permit, and the timers.',
          status: 'failure',
        },
        {
          id: 'wake',
          title: 'The alarm starts a new instance',
          description:
            'At the deadline the runtime creates a new instance, whose fields build a new scheduler and outbox, and calls alarm(). Delegating to scheduler.alarm() runs every helper attached to it; without it the row would never be published again.',
          stage: ['flow:recover'],
          source: sourceFocus(
            outboxObject,
            'override alarm(info?: AlarmInvocationInfo) {',
            'return this.scheduler.alarm(info);'
          ),
          durable: 'The alarm, the row, and its attempt count.',
          volatile: 'A fresh scheduler with every permit free.',
          status: 'recovery',
        },
        {
          id: 'pass',
          title: 'The pass runs every attached channel',
          description:
            'The scheduler’s pass for durability_outbox first postpones the due rows of each channel no outbox attaches by 60 seconds, with a durability.channel_missing report, so they keep their data without firing the alarm every pass. It then runs the pass of each attached channel, here the default one.',
          stage: ['focus:outbox'],
          source: sourceFocus(
            registerChannel,
            'runDue: async (now, info) => {',
            '[...created.values()].map((attached) => attached.runDue(now, info))'
          ),
          durable:
            'Due rows of unattached channels move 60 seconds later; nothing is deleted.',
          volatile: 'The pass and its permit.',
          status: 'recovery',
        },
        {
          id: 'reclaim',
          title: 'Claim attempt 2 of the same version',
          description:
            'The row’s deadline has passed, so it is selected and claimed again. Outbox claims pass Number.MAX_SAFE_INTEGER as the attempt limit: publication is retried until acknowledged.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            runBatch,
            'const attempt = claimAttempt(',
            'Number.MAX_SAFE_INTEGER,'
          ),
          durable: 'The stored attempt count becomes 2, with a new deadline.',
          volatile: 'Nothing from the first attempt survived.',
          status: 'recovery',
        },
        {
          id: 'republish',
          title: 'Publish the same entry again',
          description:
            'The new publish call gets the same key, version, value, and stagedAt as the lost one, with attempt 2.',
          stage: ['flow:publish'],
          source: sourceFocus(
            publishBatch,
            'const entries = claims.map(',
            'stagedAt: row.created_at,'
          ),
          durable: 'The row stays pending until this call is acknowledged.',
          volatile: 'The new publish call.',
          status: 'recovery',
        },
        {
          id: 'receiver',
          title: 'The sink must deduplicate',
          description:
            'The sink already applied this version. Only its own check on (key, version) prevents a second effect; nothing in the object can prove what the sink committed.',
          stage: ['focus:sink'],
          source: sourceFocus(
            config,
            'Sinks must be idempotent on `(key, version)` and keep the highest version.',
            'publish(entries: OutboxEntry<Value>[]): unknown | Promise<unknown>;'
          ),
          durable: 'Deduplication needs the sink’s own record of versions.',
          volatile: 'No in-memory state from the first attempt survived.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'restage',
      title: 'Restage a key during a publish',
      description:
        'A newer value for the same key arrives while the older version is being published.',
      steps: [
        {
          id: 'inflight',
          title: 'Version 1 is being published',
          description:
            'A pass has claimed the key at version 1 and its publish call is running.',
          stage: ['*', 'flow:publish'],
          source: sourceFocus(
            publishBatch,
            'await this.#deadline(() => this.#publish(entries));'
          ),
          durable: 'The row: version 1, generation 1, attempt 1.',
          volatile: 'The publish call and the channel’s running batch.',
          status: 'normal',
        },
        {
          id: 'restage',
          title: 'Stage version 2 over it',
          description:
            'set() stages a new value for the same key. INSERT OR REPLACE swaps the row: version 2, generation 2, attempt 0, due now. Version 1’s value is no longer in storage.',
          stage: ['flow:register'],
          source: sourceFocus(
            stage,
            '// Replacing the generation fences any in-flight publication of an older',
            '`INSERT OR REPLACE INTO durability_outbox'
          ),
          durable: 'The row now holds only version 2.',
          volatile: 'Version 1’s entry, inside the running publish call.',
          status: 'commit',
        },
        {
          id: 'one-run',
          title: 'One tracked batch per channel',
          description:
            'A timer or alarm pass that arrives now waits on the running batch instead of starting another. The run ends when publish returns, throws, or times out, and a timeout does not cancel the callback, so a later batch can overlap a timed-out one.',
          stage: ['focus:outbox'],
          source: sourceFocus(
            runDue,
            'async #runDue(): Promise<void> {',
            'return this.#running;'
          ),
          durable: 'Unchanged.',
          volatile: 'The running batch that later passes wait on.',
          status: 'normal',
        },
        {
          id: 'miss',
          title: 'Version 1’s outcome misses the row',
          description:
            'Version 1’s publish returns. The delete and the retry update both match its generation and attempt, which the row no longer has, so neither changes it. Version 2 stays pending either way.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            publishBatch,
            'const ref = {',
            'if (deleteAttempt(sql, outboxTable, ref)) {'
          ),
          durable: 'Version 2’s row, untouched.',
          volatile: 'Version 1’s settlement, which changed nothing.',
          status: 'normal',
        },
        {
          id: 'newer',
          title: 'The next pass publishes version 2',
          description:
            'The next pass selects due rows of the channel, oldest first. The row holds only version 2, so version 1 is never sent again.',
          stage: ['flow:publish'],
          source: sourceFocus(
            listDue,
            "WHERE channel = ? AND status = 'pending' AND next_attempt_at <= ?",
            'ORDER BY next_attempt_at ASC, version ASC'
          ),
          durable: 'Version 2’s row until it is acknowledged.',
          volatile: 'The new publish call.',
          status: 'normal',
        },
        {
          id: 'late',
          title: 'A timed-out write can land late',
          description:
            'Had version 1’s publish exceeded attemptTimeoutMs, the race would reject without cancelling it, and its write could reach the sink after version 2’s. Only a sink that compares versions keeps version 2; an unconditional KV put does not.',
          stage: ['focus:sink'],
          source: sourceFocus(
            deadline,
            'await Promise.race([',
            'reject(new OutboxTimeoutError(this.#attemptTimeoutMs)),'
          ),
          durable: 'Whatever the sink keeps.',
          volatile: 'The abandoned write, beyond the object’s reach.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'retry',
      title: 'Retry a failed publish',
      description:
        'What the outbox stores when publish throws or marks entries for retry.',
      steps: [
        {
          id: 'throw',
          title: 'publish throws or times out',
          description:
            'Either way the whole batch is retried; no entry in it is acknowledged.',
          stage: ['*', 'flow:publish'],
          source: sourceFocus(
            publishBatch,
            '} catch (error) {',
            'failure = serializeError(error);'
          ),
          durable: 'Every claimed row is still pending.',
          volatile: 'The serialized error.',
          status: 'failure',
        },
        {
          id: 'mark',
          title: 'Or retry only some entries',
          description:
            'publish can call entry.retry(delayMs) and return; the unmarked entries are acknowledged. retry() throws once publish has returned, thrown, or timed out, even if a timed-out callback is still running.',
          stage: ['focus:publish'],
          source: sourceFocus(
            publishBatch,
            'retry: (delayMs) => {',
            'retries.set(row.id, delayMs);'
          ),
          durable: 'Nothing until settlement.',
          volatile: 'The marks, for the duration of the publish call.',
          status: 'normal',
        },
        {
          id: 'persist',
          title: 'Store the next attempt time',
          description:
            'Each retried row gets its next attempt time and last error, matched on generation and attempt, in one scheduler transaction.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            publishBatch,
            'const nextAttemptAt =',
            'retried.push({ row, nextAttemptAt });'
          ),
          durable: 'next_attempt_at, last_error, and last_error_name.',
          volatile: 'Nothing that recovery depends on.',
          status: 'commit',
        },
        {
          id: 'policy',
          title: 'Retries never give up',
          description:
            'The delay comes from retries.delay, jittered exponential up to 5 minutes by default. A policy that throws or returns an invalid delay falls back to 60 seconds. There is no attempt limit and no dead-letter queue.',
          stage: ['focus:outbox'],
          source: sourceFocus(
            retryDelay,
            'const delay = Math.round(this.#delay(attempt));',
            'return infrastructureRetryMs;'
          ),
          durable: 'The next attempt time chosen here.',
          volatile: 'Nothing.',
          status: 'recovery',
        },
        {
          id: 'wait',
          title: 'The alarm waits for the retry',
          description:
            'The settlement transaction reconciles the object alarm: the target is the earliest pending row on the scheduler, no sooner than alarmMinDelayMs from now. An existing alarm between that row’s time and the target is kept; otherwise the alarm is set to the target. A retry due sooner runs from the in-memory timer while the instance lives; after eviction it waits for the alarm.',
          stage: ['focus:alarm'],
          source: sourceFocus(
            reconcile,
            'const target = Math.max(physicalNextAt, Date.now() + this.alarmMinDelayMs);',
            'await physicalAlarm.setAlarm(target);'
          ),
          durable:
            'The alarm, reconciled in the transaction that stores the retried rows.',
          volatile: 'The in-memory timer.',
          status: 'recovery',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
