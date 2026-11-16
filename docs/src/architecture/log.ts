import example from '../../../examples/event-topics/worker.ts?raw';
import alarms from '../../../packages/durability/src/alarms/index.ts?raw';
import log from '../../../packages/durability/src/log/index.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/event-topics/worker.ts';
const logFile = 'packages/durability/src/log/index.ts';
const alarmsFile = 'packages/durability/src/alarms/index.ts';

const partition = sourceExcerpt(
  example,
  exampleFile,
  'partition',
  'Partition Durable Object',
  'export class Partition extends DurableObject<Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const fetchHandler = sourceExcerpt(
  example,
  exampleFile,
  'fetch',
  'Producer and poller',
  '  async fetch(request, env): Promise<Response> {',
  '    return Response.json(pages);'
);
const construct = sourceExcerpt(
  log,
  logFile,
  'construct',
  'Attach to the object storage',
  '  constructor(config: DurabilityLogConfig<Body>) {',
  "      'DurabilityLog'\n    );\n  }"
);
const appendRecords = sourceExcerpt(
  log,
  logFile,
  'append-records',
  'Allocate offsets',
  'const appendRecords = (',
  '  return records.map((record) => assigned.get(record.dedup_key)!);\n};'
);
const append = sourceExcerpt(
  log,
  logFile,
  'append',
  'Append a batch',
  '  async append(',
  '    } finally {\n      finish();\n    }\n  }'
);
const read = sourceExcerpt(
  log,
  logFile,
  'read',
  'Read forward from an offset',
  '  async read(options: LogReadOptions): Promise<LogPage<Body>> {',
  '      lag: Math.max(0, bounds.nextOffset - nextOffset),\n    };\n  }'
);
const rehydrate = sourceExcerpt(
  log,
  logFile,
  'rehydrate',
  'Read a flushed segment back',
  '  async #rehydrate(',
  '      .slice(0, limit);\n  }'
);
const commitCursor = sourceExcerpt(
  log,
  logFile,
  'commit-cursor',
  'Advance a cursor, never rewind it',
  'const commitCursor = (',
  '    committedAt\n  );\n};'
);
const trim = sourceExcerpt(
  log,
  logFile,
  'trim',
  'Flush or delete the oldest records',
  '  async trim(): Promise<number> {',
  '        (cutoff !== undefined && row.appended_at < cutoff)\n      );\n    });\n  }'
);
const claimExpired = sourceExcerpt(
  log,
  logFile,
  'claim-expired',
  'Redeliver an expired range',
  'const claimExpired = (',
  '        now\n      )\n      .toArray()[0]\n  );'
);
const lease = sourceExcerpt(
  log,
  logFile,
  'lease',
  'Record a range before returning it',
  '  async lease(',
  '    return undefined;\n  }'
);
const settle = sourceExcerpt(
  log,
  logFile,
  'settle',
  'Settle a range by batch ID',
  '  async ack(consumer: string, batchId: string): Promise<void> {',
  '    throw new LogLeaseError(batchId);\n  }'
);
const schedule = sourceExcerpt(
  alarms,
  alarmsFile,
  'schedule',
  'Schedule the named alarm',
  '  async #schedule(name: string, scheduledTime: number): Promise<void> {',
  '      deleteMemos(sql, this.#table, key);\n    });'
);

export const walkthrough = validateWalkthrough({
  id: 'log',
  title: 'How DurabilityLog uses your Durable Object',
  summary:
    'DurabilityLog keeps records, cursors, and the cold-segment index in the object’s SQLite storage, holds nothing that matters in memory, and never sets the alarm itself. Step through an append and a read, an eviction around an append, a retention sweep to R2, and leased consumers.',
  diagram: {
    canvas: { width: 1000, height: 900 },
    direction: 'down',
    routing: 'auto',
    flows: {
      append: { label: 'append and schedule', color: 'blue' },
      consume: { label: 'read and commit', color: 'purple' },
      retention: { label: 'enforce retention', color: 'orange' },
    },
    nodes: {
      producer: {
        rank: 0,
        row: 1,
        label: 'Producer',
        sublabel: 'Worker POST',
        icon: 'workers',
        tone: 'external',
      },
      poller: {
        rank: 0,
        row: 2,
        label: 'Poller',
        sublabel: 'Worker GET',
        icon: 'workers',
        tone: 'external',
      },
      object: {
        rank: 1,
        row: 1,
        label: 'Partition',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      alarms: {
        rank: 2,
        row: 0,
        label: 'Named alarm',
        sublabel: 'enforceRetention',
        icon: 'clock',
      },
      log: {
        rank: 2,
        row: 1,
        label: 'DurabilityLog',
        sublabel: 'holds config only',
        icon: 'shield',
      },
      alarm: {
        rank: 1,
        row: 0,
        label: 'Object alarm',
        sublabel: 'ctx.storage.setAlarm',
        icon: 'clock',
      },
      sqlite: {
        rank: 3,
        row: 1,
        label: 'Log tables',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      r2: {
        rank: 3,
        row: 2,
        label: 'R2 bucket',
        sublabel: 'env.COLD segments',
        icon: 'r2',
        tone: 'external',
      },
    },
    edges: [
      { from: 'producer', to: 'object', label: 'append()', flow: 'append' },
      {
        from: 'poller',
        to: 'object',
        label: 'consume, commit',
        flow: 'consume',
      },
      { from: 'object', to: 'log', label: 'log calls', flow: 'append' },
      { from: 'log', to: 'sqlite', label: 'rows', flow: 'append' },
      {
        from: 'object',
        to: 'alarms',
        label: 'schedule',
        flow: 'append',
      },
      { from: 'alarms', to: 'alarm', label: 'setAlarm', flow: 'append' },
      {
        from: 'alarm',
        to: 'object',
        label: 'alarm()',
        flow: 'retention',
        back: true,
      },
      { from: 'alarms', to: 'log', label: 'trim()', flow: 'retention' },
      { from: 'log', to: 'r2', label: 'segments', flow: 'retention' },
    ],
    groups: [
      {
        id: 'durable-object',
        label: 'One Durable Object',
        contains: ['object', 'alarms', 'log', 'alarm', 'sqlite'],
      },
    ],
  },
  details: {
    producer: {
      description:
        'The fetch handler groups events by partition and pushes each group through DurabilityRouting, which reaches the Partition named topic:partition and calls append().',
      href: '/primitives/routing/',
      source: 'fetch',
    },
    poller: {
      description:
        'Polls every partition of a topic for one consumer group, handles the page, and commits the next offset only after the work succeeds.',
      href: '/compositions/event-stream/',
      source: 'fetch',
    },
    object: {
      description:
        'Your class. The scheduler, the log, and the named alarms are fields, rebuilt whenever the runtime creates a new instance. Its alarm() delegates to scheduler.alarm() so the retention sweep runs.',
      href: '/primitives/log/',
      source: 'partition',
    },
    alarms: {
      description:
        'A DurabilityAlarms handler on the same scheduler. The log never schedules work itself, so this named alarm is what calls trim(). Its row lives in durability_alarms.',
      href: '/primitives/alarms/',
      source: 'schedule',
    },
    log: {
      description:
        'Holds its configuration, its channel, the cold-storage callbacks, and a text encoder. It claims its channel on the scheduler but registers no due work with it, and keeps no timers, permits, or running state, so eviction loses nothing it needs.',
      href: '/primitives/log/',
      source: 'construct',
    },
    alarm: {
      description:
        'The object’s single alarm, owned by the shared scheduler. Only the named alarm sets it; appends, reads, commits, and leases never touch it.',
      href: '/primitives/scheduler/',
      source: 'schedule',
    },
    sqlite: {
      description:
        'Every log table is keyed by channel first. durability_log_records holds the hot window by channel and offset, with a deduplication key unique per channel; durability_log_seq one row per channel with the next offset and byte count; durability_log_cursors one row per channel and consumer; durability_log_segments the cold index by channel and first offset; durability_log_pending_flushes the range of an unfinished cold flush, one row per channel. Leases add durability_log_leases and durability_log_allocations.',
      href: '/reference/storage/',
      source: 'construct',
    },
    r2: {
      description:
        'Cold storage for flushed segments, keyed by object ID and first offset, refusing to overwrite. The key leaves out the segment’s channel, which is safe only because the object has one log; logs on several channels flush overlapping offsets. The log stores the returned locator and reads it back for consumers behind the hot window.',
      href: '/primitives/log/#flushing-to-cold-storage-and-reading-it-back',
      source: 'partition',
    },
  },
  excerpts: [
    partition,
    fetchHandler,
    construct,
    append,
    appendRecords,
    read,
    rehydrate,
    commitCursor,
    trim,
    lease,
    claimExpired,
    settle,
    schedule,
  ],
  scenarios: [
    {
      id: 'append-read',
      title: 'Append, read, and commit',
      description:
        'Follow one batch of events into a partition and one consumer group reading it.',
      steps: [
        {
          id: 'field',
          title: 'The log belongs to the object instance',
          description:
            'Partition builds a scheduler from this.ctx and attaches the log to it. The log passes no channel, so its rows are on the default channel. It reads and writes only this object’s storage; another partition has its own records and cursors.',
          stage: ['object', 'log', 'durable-object', 'focus:log'],
          source: sourceFocus(
            partition,
            'private readonly scheduler = new DurabilityScheduler({ context: this.ctx });',
            'private readonly log = new DurabilityLog<Event>({'
          ),
          durable: 'Nothing is written yet.',
          volatile:
            'The helper holds only its configuration and is rebuilt with every new instance.',
          status: 'normal',
        },
        {
          id: 'migrate',
          title: 'Create tables, but no alarm work',
          description:
            'The constructor joins the object’s one scheduler through engineFor, applies the log migrations through ctx.storage.sql, plus the lease tables when leases are enabled, and claims its channel, so a second log on the same channel throws. Unlike fanout or Durability, it registers no due work with the scheduler, so no alarm pass ever runs log work.',
          stage: ['sqlite', 'focus:sqlite'],
          source: sourceFocus(
            construct,
            'this.#engine = engineFor(config);',
            "'DurabilityLog'\n    );"
          ),
          durable:
            'The records, cursors, segments, and sequence tables exist in this object.',
          volatile:
            'The record that migrations already ran and the claimed channel, kept by the scheduler.',
          status: 'commit',
        },
        {
          id: 'rpc',
          title: 'A producer appends through routing',
          description:
            'The fetch handler groups events by partition and pushes each group; routing calls append() on the Partition named topic:partition, which forwards the batch to log.append().',
          stage: ['producer', 'flow:append'],
          source: sourceFocus(
            fetchHandler,
            'const accepted = await Promise.all(',
            'topics.with(timeout, 5_000).push({ events: group })'
          ),
          durable: 'Nothing is written until the transaction commits.',
          volatile: 'The RPC call waits for the offsets.',
          status: 'normal',
        },
        {
          id: 'insert',
          title: 'Insert the batch in one transaction',
          description:
            'append() validates the whole batch, then writes it with transactionSync. That transaction does not touch the object alarm: a record is complete once it has its row and its offset.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            append,
            'const offsets = this.#engine.transactionSync((sql) =>',
            'return { success: true, value: offsets, load: await this.load() };'
          ),
          durable: 'Every record in the batch commits, or none does.',
          volatile: 'The serialized payloads, held only until the write.',
          status: 'commit',
        },
        {
          id: 'offsets',
          title: 'Allocate consecutive offsets',
          description:
            'New records take consecutive offsets from the channel’s row in durability_log_seq, which the channel’s first append creates and which also counts the payload bytes the channel holds in the object. A key already in the hot window keeps its first offset and consumes no new one.',
          stage: ['focus:log'],
          source: sourceFocus(
            appendRecords,
            'const first = v.parse(',
            'UPDATE durability_log_seq SET total_bytes = total_bytes + ?'
          ),
          durable:
            'next_offset and total_bytes advance with the inserted rows.',
          volatile: 'The map of assigned offsets returned to the caller.',
          status: 'commit',
        },
        {
          id: 'read',
          title: 'A poller reads from its cursor',
          description:
            'consume() starts at the group’s committed cursor, or at the oldest readable offset for a new group. Reading changes nothing: it is not an acknowledgement.',
          stage: ['poller', 'flow:consume'],
          source: sourceFocus(
            partition,
            'const from =',
            'return this.log.read({ from, limit });'
          ),
          durable: 'Nothing is written by a read.',
          volatile: 'The page travels back to the poller.',
          status: 'normal',
        },
        {
          id: 'hot',
          title: 'Serve the page from the hot window',
          description:
            'An offset still in the object is read from durability_log_records; only an offset below the hot window goes to cold storage. The page reports the next offset and the lag behind the newest record.',
          stage: ['focus:log'],
          source: sourceFocus(read, 'const records =', 'this.#record(row)'),
          durable: 'Rows are read, not changed.',
          volatile: 'The decoded records in this page.',
          status: 'normal',
        },
        {
          id: 'commit',
          title: 'Commit after the work, never backwards',
          description:
            'After handling the page, the poller commits nextOffset. The upsert only moves a cursor forward, so a late or repeated commit cannot rewind it.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            commitCursor,
            'ON CONFLICT(channel, consumer) DO UPDATE',
            'WHERE excluded."offset" > durability_log_cursors."offset"'
          ),
          durable: 'The group’s cursor row holds the committed offset.',
          volatile: 'Nothing: the next poll reads the cursor from storage.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Evict the object around an append',
      description:
        'An illustrative failure between the append committing and the producer hearing about it, not execution of the example code.',
      steps: [
        {
          id: 'lost-reply',
          title: 'The reply is lost after the commit',
          description:
            'Assume the append transaction commits, but the object is evicted or the RPC fails before the producer receives the offsets. The producer sees an error, which means uncertain, not rejected.',
          stage: ['*', 'flow:append'],
          source: sourceFocus(
            fetchHandler,
            '// A rejected push is definite; a thrown one is uncertain and may retry.'
          ),
          durable: 'The records are stored with their offsets.',
          volatile: 'The reply and routing’s in-flight counters are gone.',
          status: 'failure',
        },
        {
          id: 'rebuild',
          title: 'A new instance has nothing to restore',
          description:
            'The next request creates a new instance, which rebuilds the log helper from its configuration. The tables already exist, and there is no running work, timer, or scheduler participant to recover.',
          stage: ['focus:log'],
          source: sourceFocus(
            construct,
            'this.#routing = config.routing ?? new RoutingLoad();',
            'this.#leases = config.leases;'
          ),
          durable: 'Records, offsets, and cursors as committed.',
          volatile: 'A fresh helper with the same configuration.',
          status: 'recovery',
        },
        {
          id: 'retry',
          title: 'The producer retries with the same keys',
          description:
            'The example passes an event’s key as its deduplicationKey, so retrying the same push is safe for every event that has one.',
          stage: ['flow:append'],
          source: sourceFocus(
            fetchHandler,
            'event.key === undefined',
            ': { deduplicationKey: event.key, body },'
          ),
          durable: 'Nothing new yet.',
          volatile: 'The retried RPC call.',
          status: 'recovery',
        },
        {
          id: 'same-offset',
          title: 'Existing keys return their first offsets',
          description:
            'Inside the append transaction, each key is looked up first among the channel’s records. A key that is still retained returns its original offset and writes nothing.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            appendRecords,
            'const existing = v.parse(',
            'assigned.set(record.dedup_key, existing.offset);'
          ),
          durable: 'No duplicate rows and no offsets consumed.',
          volatile: 'The offsets returned to the producer.',
          status: 'recovery',
        },
        {
          id: 'gap',
          title: 'Keyless and trimmed records repeat',
          description:
            'An event without a key gets a random deduplication key, so the retry appends it again. A key also stops deduplicating once trim() flushes or deletes its record. Consumers must tolerate duplicates.',
          stage: ['focus:producer'],
          source: sourceFocus(
            append,
            'dedup_key: input.deduplicationKey ?? crypto.randomUUID(),'
          ),
          durable:
            'Deduplication lasts only while the original record is in the hot window.',
          volatile: 'Nothing records that the first reply was lost.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'retention',
      title: 'Trim to R2 and read it back',
      description:
        'How a named alarm gives retention a schedule, and how a lagging consumer reads flushed records.',
      steps: [
        {
          id: 'schedule',
          title: 'An append schedules a sweep',
          description:
            'The log never schedules work. After a successful append, Partition sets the sweeping key and schedules the enforceRetention alarm 60 seconds out, unless the key is already set: rescheduling on every append would postpone the sweep forever.',
          stage: ['*', 'focus:alarms'],
          source: sourceFocus(
            partition,
            "if (result.success && !(await this.ctx.storage.get<boolean>('sweeping'))) {",
            'await this.alarms.enforceRetention(Date.now() + retentionSweepMs);'
          ),
          durable: 'The sweeping key and the named alarm row.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'schedule-gap',
          title: 'The key and the alarm commit separately',
          description:
            'The append, the sweeping key, and the alarm are separate writes. If the object fails after sweeping commits but before the alarm does, no sweep is scheduled, and every later append skips scheduling because the key is set. Nothing in the example repairs this.',
          stage: ['focus:object'],
          source: sourceFocus(
            partition,
            "await this.ctx.storage.put('sweeping', true);",
            'await this.alarms.enforceRetention(Date.now() + retentionSweepMs);'
          ),
          durable: 'sweeping is true, with no named alarm row.',
          volatile: 'The interrupted append call.',
          status: 'gap',
        },
        {
          id: 'arm',
          title: 'The alarm row and the object alarm commit together',
          description:
            'DurabilityAlarms upserts its row with a new generation through the scheduler’s transaction, which sets the object’s one alarm before it commits.',
          stage: ['focus:alarm'],
          source: sourceFocus(
            schedule,
            'await this.#engine.transaction((sql) => {',
            'ON CONFLICT(channel, name) DO UPDATE SET'
          ),
          durable: 'durability_alarms and the object alarm.',
          volatile: 'Nothing the sweep depends on.',
          status: 'commit',
        },
        {
          id: 'wake',
          title: 'The alarm calls trim()',
          description:
            'When the alarm fires, possibly in a new instance, Partition’s alarm() delegates to the scheduler, which runs the due enforceRetention handler. The handler calls log.trim().',
          stage: ['flow:retention'],
          source: sourceFocus(
            partition,
            'enforceRetention: async () => {',
            'await this.log.trim();'
          ),
          durable: 'The named alarm’s attempt is claimed.',
          volatile: 'The running handler.',
          status: 'normal',
        },
        {
          id: 'select',
          title: 'Choose the oldest records past a limit',
          description:
            'trim() reads the oldest records and takes them while the log is over maxRecords, over maxBytes, or older than maxAgeMs. Retention ignores cursors: a slow consumer does not hold records back.',
          stage: ['focus:log'],
          source: sourceFocus(
            trim,
            'return takeWhile(oldest, (row, index) => {',
            '(cutoff !== undefined && row.appended_at < cutoff)'
          ),
          durable: 'Rows are read, not changed.',
          volatile: 'The run of records about to leave.',
          status: 'normal',
        },
        {
          id: 'record',
          title: 'Record the range before writing',
          description:
            'With cold storage, a range left by an unfinished flush is flushed again exactly as recorded. Otherwise the selected run’s first and last offsets go into durability_log_pending_flushes before anything is written, so a retry cannot widen the run.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            trim,
            'const pending = readPendingFlush(sql, this.#channel);',
            'setPendingFlush(sql, this.#channel, flush);'
          ),
          durable:
            'The range in durability_log_pending_flushes; the records are still hot.',
          volatile: 'The rows about to be written.',
          status: 'commit',
        },
        {
          id: 'write',
          title: 'Write the segment to R2 first',
          description:
            'The run goes to cold.write with the log’s channel and its first and last offsets. The example puts it under the object ID and first offset, refusing to overwrite. If the write fails, trim() throws with every record still in the object and the range still recorded, and the named alarm retries.',
          stage: ['focus:r2'],
          source: sourceFocus(
            trim,
            'const locator = await cold.write({',
            "throw new TypeError('Cold storage must return a non-empty locator');"
          ),
          durable: 'The R2 object; the records are still hot.',
          volatile: 'The locator returned by the write.',
          status: 'normal',
        },
        {
          id: 'index',
          title: 'Index, delete, and clear in one transaction',
          description:
            'The locator goes into durability_log_segments, the hot records are deleted, and the recorded range is cleared in one transaction, so a crash leaves either the records hot with their range recorded or a readable segment. If an overlapping trim() already finished the range, the transaction changes nothing.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            trim,
            'insertSegment(transaction, this.#channel, {',
            'return trimThrough('
          ),
          durable:
            'The segment row, fewer records, a smaller byte count, and no recorded range.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'retry',
          title: 'A retried flush carries the same records',
          description:
            'After a failed write, a lost response, or a crash before the transaction, the next sweep finds the recorded range and writes exactly those records again under the same first offset, however many records were appended meanwhile. R2 refuses the put and returns null, which the example ignores; that is safe because the stored object holds the same records.',
          stage: ['focus:r2'],
          source: sourceFocus(
            partition,
            'const locator = `${coldPrefix}',
            'return locator;'
          ),
          durable:
            'The R2 object, then the index row, the deleted hot rows, and the cleared range.',
          volatile: 'The null result of the refused put.',
          status: 'recovery',
        },
        {
          id: 'rehydrate',
          title: 'A lagging consumer reads from R2',
          description:
            'A cursor below the hot window no longer fails. read() finds the segment holding the offset and calls cold.read with its locator.',
          stage: ['focus:r2'],
          source: sourceFocus(
            rehydrate,
            'const segment = findSegment(this.#engine.sql, this.#channel, from);',
            '? await this.#cold?.read(segment.locator)'
          ),
          durable: 'Nothing is written by a cold read.',
          volatile: 'The segment fetched from R2.',
          status: 'recovery',
        },
        {
          id: 'truncated',
          title: 'Below everything readable, reads throw',
          description:
            'An offset below the oldest readable record raises LogTruncatedError instead of a silent gap.',
          stage: ['focus:poller'],
          source: sourceFocus(
            read,
            'if (options.from < bounds.oldestOffset) {',
            'throw new LogTruncatedError(options.from, bounds.oldestOffset);'
          ),
          durable: 'Lost history is reported, not reconstructed.',
          volatile: 'The error returned to the poller.',
          status: 'gap',
        },
        {
          id: 'missing-segment',
          title: 'An indexed segment R2 already expired',
          description:
            'If cold.read finds no object for an indexed segment, the read also throws LogTruncatedError. The example exposes expireCold(), which calls forgetColdBefore(), but nothing calls it; the application must, to match the bucket’s lifecycle rule. Until then bounds() still counts the expired segments as readable.',
          stage: ['focus:r2'],
          source: sourceFocus(
            rehydrate,
            'if (!records) {',
            'throw new LogTruncatedError(from, Math.max(from + 1, bounds.hotOffset));'
          ),
          durable: 'Index rows that point at deleted R2 objects.',
          volatile: 'The error returned to the poller.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'leases',
      title: 'Lease ranges to parallel pollers',
      description:
        'Illustrative: the example uses read and commit, and these steps assume the leases option is enabled.',
      steps: [
        {
          id: 'lease',
          title: 'Record the range before returning it',
          description:
            'lease() reads the consumer’s allocation and the records, then, in one transaction, checks that the allocation and the free slots are unchanged and writes an active lease row and the new allocation before returning them. The read yields, and a cold read awaits R2, so another call may lease those offsets meanwhile; the check catches that and the selection starts again from the new allocation.',
          stage: ['*', 'focus:sqlite'],
          source: sourceFocus(
            lease,
            'const allocated = readAllocation(sql, this.#channel, consumer);',
            'setAllocation(transaction, this.#channel, consumer, last + 1);'
          ),
          durable: 'The lease row with its batch ID and expiry.',
          volatile: 'The records on their way to the poller.',
          status: 'commit',
        },
        {
          id: 'lost',
          title: 'The holder disappears mid-range',
          description:
            'The poller crashes, or the object is evicted, while the range is held. Nothing in memory times the lease out: expiry is a timestamp checked when the next lease() call arrives, with no timer or alarm behind it.',
          stage: ['focus:poller'],
          source: sourceFocus(
            claimExpired,
            "AND (state = 'pending'",
            "OR (state = 'active' AND expires_at <= ?5))"
          ),
          durable: 'The lease row stays active until leaseMs passes.',
          volatile: 'The holder’s records and its batch ID.',
          status: 'failure',
        },
        {
          id: 'reclaim',
          title: 'Redeliver under a fresh batch ID',
          description:
            'After leaseMs, the next lease() for that consumer claims the expired range first, rewriting its batch ID and counting another attempt.',
          stage: ['focus:sqlite'],
          source: sourceFocus(
            claimExpired,
            "SET batch_id = ?1, state = 'active', attempt = attempt + 1,"
          ),
          durable: 'The same range, a new batch ID, attempt 2.',
          volatile: 'The records read again for the new holder.',
          status: 'recovery',
        },
        {
          id: 'ack',
          title: 'ack() advances over settled ranges only',
          description:
            'The new holder acks its batch. The cursor moves across the unbroken run of acked or skipped ranges from the cursor, never past a range still held.',
          stage: ['flow:consume'],
          source: sourceFocus(
            settle,
            "this.#settle(consumer, batchId, 'acked');",
            'this.#advance(consumer);'
          ),
          durable: 'The cursor advances and settled lease rows are deleted.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'fenced',
          title: 'The old holder is fenced, its effects are not',
          description:
            'If the first holder comes back and acks, its batch ID no longer matches an active lease, so ack() throws LogLeaseError. Whatever that holder already did downstream still happened; the work must be idempotent.',
          stage: ['focus:log'],
          source: sourceFocus(
            settle,
            'const settled = settleLease(',
            'throw new LogLeaseError(batchId);'
          ),
          durable: 'The cursor is unchanged by the stale ack.',
          volatile: 'The rejected call.',
          status: 'gap',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
