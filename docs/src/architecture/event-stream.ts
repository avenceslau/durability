import example from '../../../examples/event-topics/worker.ts?raw';
import logSource from '../../../packages/durability/src/log.ts?raw';
import alarmsSource from '../../../packages/durability/src/durability-alarms.ts?raw';
import schedulerSource from '../../../packages/durability/src/scheduler.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/event-topics/worker.ts';
const logFile = 'packages/durability/src/log.ts';
const alarmsFile = 'packages/durability/src/durability-alarms.ts';
const schedulerFile = 'packages/durability/src/scheduler.ts';

const partition = sourceExcerpt(
  example,
  exampleFile,
  'partition',
  'Partition Durable Object',
  'export class Partition extends DurableObject<Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const topics = sourceExcerpt(
  example,
  exampleFile,
  'topics',
  'Route a batch to one partition',
  'const topics = DurabilityRouting.client({',
  '});'
);
const produce = sourceExcerpt(
  example,
  exampleFile,
  'produce',
  'Group events by partition and push',
  "    if (request.method === 'POST') {",
  '      });\n    }'
);
const poll = sourceExcerpt(
  example,
  exampleFile,
  'poll',
  'Read, handle, then commit',
  '    // Each partition is polled independently: a slow group never blocks others.',
  '    return Response.json(pages);'
);
const handle = sourceExcerpt(
  example,
  exampleFile,
  'handle',
  'Consumer work',
  'const handle = async (records: LogRecord<Event>[]): Promise<void> => {',
  '};'
);
const appendRecords = sourceExcerpt(
  logSource,
  logFile,
  'append-records',
  'Assign offsets and deduplicate',
  'const appendRecords = (',
  '  return records.map((record) => assigned.get(record.dedup_key)!);\n};'
);
const commitCursor = sourceExcerpt(
  logSource,
  logFile,
  'commit-cursor',
  'Store a group cursor',
  'const commitCursor = (',
  '  );\n};'
);
const append = sourceExcerpt(
  logSource,
  logFile,
  'append',
  'Append a batch',
  '  async append(\n    records: LogAppendInput<Body> | LogAppendInput<Body>[]',
  '      return { success: true, value: offsets, load: await this.load() };'
);
const read = sourceExcerpt(
  logSource,
  logFile,
  'read',
  'Read hot rows or a cold segment',
  '  async read(options: LogReadOptions): Promise<LogPage<Body>> {',
  '      .slice(0, limit);\n  }'
);
const trim = sourceExcerpt(
  logSource,
  logFile,
  'trim',
  'Flush the oldest records to cold storage',
  '  async trim(): Promise<number> {',
  '      if (deleted < expiring.length) {\n        return removed;\n      }\n    }\n  }'
);
const schedule = sourceExcerpt(
  alarmsSource,
  alarmsFile,
  'schedule',
  'Schedule or replace a named alarm',
  '  async #schedule(name: string, scheduledTime: number): Promise<void> {',
  '      scheduledTime,\n    });\n  }'
);
const execute = sourceExcerpt(
  alarmsSource,
  alarmsFile,
  'execute',
  'Run one named alarm attempt',
  '  #execute(\n    row: AlarmRow,',
  '        isErrorInstance(error, DurableAlarmTimeoutError) && !retryTimeouts,\n    });\n  }'
);
const decideRetry = sourceExcerpt(
  schedulerSource,
  schedulerFile,
  'decide-retry',
  'Decide whether a failure is final',
  'const decideRetry = (',
  '    return { error, terminal, timestamp, nextAttemptAt: timestamp };\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'event-stream',
  title: 'How the event stream uses its Durable Objects',
  summary:
    'Each topic:partition name is one Partition object. Its SQLite storage holds the hot log and every consumer group’s cursor; a named alarm on the object’s one alarm flushes old records to R2. Step through a producer append, a retention pass, a consumer poll, a crash before commit, and the naive design it replaces.',
  diagram: {
    canvas: { width: 1000, height: 900 },
    direction: 'down',
    routing: 'auto',
    flows: {
      append: { label: 'append events', color: 'blue' },
      retention: { label: 'enforce retention', color: 'orange' },
      consume: { label: 'read, handle, commit', color: 'purple' },
    },
    nodes: {
      producer: {
        rank: 0,
        row: 0,
        label: 'Producer',
        sublabel: 'fetch POST',
        icon: 'workers',
        tone: 'external',
      },
      poller: {
        rank: 0,
        row: 1,
        label: 'Poller',
        sublabel: 'fetch GET',
        icon: 'workers',
        tone: 'external',
      },
      alarm: {
        rank: 1,
        row: 0,
        label: 'Partition alarm',
        sublabel: 'one scheduler',
        icon: 'clock',
      },
      partition: {
        rank: 1,
        row: 1,
        label: 'Partition',
        sublabel: 'topic:partition',
        icon: 'durable-objects',
      },
      sweeping: {
        rank: 2,
        row: 2,
        label: 'sweeping',
        sublabel: 'ctx.storage key',
        icon: 'database',
      },
      retention: {
        rank: 2,
        row: 0,
        label: 'enforceRetention',
        sublabel: 'named alarm',
        size: [262, 72],
        icon: 'clock',
      },
      log: {
        rank: 2,
        row: 1,
        label: 'DurabilityLog',
        sublabel: 'hot window',
        icon: 'shield',
      },
      handler: {
        rank: 0,
        row: 2,
        label: 'handle()',
        sublabel: 'consumer work',
        size: [215, 72],
        icon: 'browser',
        tone: 'external',
      },
      r2: {
        rank: 4,
        row: 0,
        label: 'COLD',
        sublabel: 'R2 segments',
        icon: 'r2',
        tone: 'external',
      },
      storage: {
        rank: 3,
        row: 1,
        label: 'log + cursors',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
    },
    edges: [
      {
        from: 'producer',
        to: 'partition',
        label: 'append()',
        flow: 'append',
      },
      { from: 'partition', to: 'sweeping', label: 'put', flow: 'append' },
      {
        from: 'partition',
        to: 'retention',
        label: 'schedule',
        flow: 'append',
      },
      { from: 'retention', to: 'alarm', label: 'setAlarm', flow: 'append' },
      { from: 'partition', to: 'log', label: 'log calls', flow: 'append' },
      { from: 'log', to: 'storage', label: 'rows', flow: 'append' },
      {
        from: 'alarm',
        to: 'partition',
        label: 'alarm()',
        flow: 'retention',
        back: true,
      },
      { from: 'retention', to: 'log', label: 'trim()', flow: 'retention' },
      {
        from: 'log',
        to: 'r2',
        label: 'put · get',
        flow: 'retention',
        both: true,
      },
      {
        from: 'poller',
        to: 'partition',
        label: 'consume · commit',
        flow: 'consume',
      },
      {
        from: 'poller',
        to: 'handler',
        label: 'records',
        flow: 'consume',
      },
    ],
    groups: [
      {
        id: 'partition-object',
        label: 'Partition · one per topic:partition',
        contains: [
          'alarm',
          'partition',
          'sweeping',
          'retention',
          'log',
          'storage',
        ],
      },
    ],
  },
  details: {
    producer: {
      description:
        'The fetch handler’s POST path. It groups events by topic:partition name and makes one routed push per group with a five-second timeout. It answers 202 when every push succeeded and 409 when any was rejected; a thrown push fails the request with no definite outcome.',
      href: '/primitives/routing/',
      source: 'produce',
    },
    poller: {
      description:
        'The fetch handler’s GET path. For one consumer group it reaches all eight partition names with env.PARTITIONS.getByName and, for each, calls consume(group, 100), runs handle(), then commit().',
      href: '/primitives/log/',
      source: 'poll',
    },
    alarm: {
      description:
        'A Partition has one alarm. The log and the alarms helper share one DurabilityScheduler; the log registers no timed work, so the alarm is set only for the enforceRetention row.',
      href: '/primitives/scheduler/',
      source: 'partition',
    },
    partition: {
      description:
        'Your class, one object per topic:partition name. Writing to a name creates it; there is no partition registry. Its scheduler, log, alarms helper, and routing load observer are fields, rebuilt with every new instance; alarm() delegates to the scheduler.',
      href: '/primitives/log/',
      source: 'partition',
    },
    sweeping: {
      description:
        'A key written with ctx.storage.put when an append finds no sweep scheduled, and deleted when a sweep finds nothing hot. It is written separately from the named alarm row, not in one transaction with it.',
      href: '/primitives/alarms/',
      source: 'partition',
    },
    retention: {
      description:
        'A DurabilityAlarms handler with one row in durability_alarms. Scheduling the name again replaces its pending time. It has the default policy: five attempts and a five-minute attempt timeout that fails the alarm without a retry.',
      href: '/primitives/alarms/',
      source: 'schedule',
    },
    log: {
      description:
        'DurabilityLog appends, reads, commits, and trims. Only the routing load observer, which counts appends in flight, lives in memory; records, cursors, and segment locators are rows.',
      href: '/primitives/log/',
      source: 'append',
    },
    handler: {
      description:
        'Stands in for the consumer’s real work and only logs. Records arrive in offset order within a partition and may be delivered again after a failure, so real work must deduplicate, for example on topic, partition, and offset.',
      href: '/reference/guarantees/',
      source: 'handle',
    },
    r2: {
      description:
        'The COLD bucket. Flushed segments are stored at segments/<object id>/<firstOffset> with onlyIf etagDoesNotMatch: "*", so a repeated flush leaves the first object in place. Expiring objects is a bucket lifecycle rule, outside this code.',
      href: '/primitives/log/',
      source: 'partition',
    },
    storage: {
      description:
        'The Partition’s own SQLite: durability_log_records (the hot window, with deduplication keys), durability_log_seq (next offset and bytes held), durability_log_cursors (one row per consumer group), durability_log_segments (cold locators), and durability_alarms.',
      href: '/reference/storage/',
      source: 'append-records',
    },
  },
  excerpts: [
    partition,
    topics,
    produce,
    poll,
    handle,
    append,
    appendRecords,
    read,
    commitCursor,
    trim,
    schedule,
    execute,
    decideRetry,
  ],
  scenarios: [
    {
      id: 'append',
      title: 'Append a batch and schedule retention',
      description:
        'Follow one producer POST into one partition’s storage, and the first append that schedules a retention sweep.',
      steps: [
        {
          id: 'group',
          title: 'Group events by partition',
          description:
            'A topic has eight partitions. The Worker hashes each event’s partitionKey to one of them and groups the events by topic:partition name, because one push may carry events for one partition only.',
          stage: ['producer', 'focus:producer'],
          source: sourceFocus(
            produce,
            'const byPartition = new Map<string, LogAppendInput<Event>[]>();',
            'const shard = `${topic}:${partitionFor(event.partitionKey)}`;'
          ),
          durable: 'Nothing is written while grouping.',
          volatile: 'The byPartition Map exists only in this request.',
          status: 'normal',
        },
        {
          id: 'route',
          title: 'Address the partition by name',
          description:
            'The routing client names the shard from the first event only, then calls getByName(shard) on the Partition namespace, which the Vite plugin resolves from the Worker export. That is why the Worker groups first.',
          stage: ['partition', 'partition-object', 'flow:append'],
          source: sourceFocus(
            topics,
            'const first = input.events[0]?.body;',
            'const shard = `${first.topic}:${partitionFor(first.partitionKey)}`;'
          ),
          durable: 'The name is the partition: one object per topic:partition.',
          volatile:
            'The client keeps load observations per shard in the Worker’s memory; custom sharding ignores them here.',
          status: 'normal',
        },
        {
          id: 'append',
          title: 'Insert the batch in one transaction',
          description:
            'append() rejects an empty batch or one over maxBatchSize (100) with success: false before writing. Otherwise one synchronous transaction assigns consecutive offsets and inserts the rows.',
          stage: ['log', 'storage', 'focus:storage'],
          source: sourceFocus(
            append,
            'const offsets = this.#engine.transactionSync((sql) =>',
            'return { success: true, value: offsets, load: await this.load() };'
          ),
          durable:
            'The records and the advanced next offset commit together in this object’s SQLite.',
          volatile: 'The load snapshot returned with the result.',
          status: 'commit',
        },
        {
          id: 'dedup',
          title: 'Deduplicate only within the hot window',
          description:
            'The Worker passes a producer key as deduplicationKey. A key already in durability_log_records returns its original offset instead of a new record. Once trim removes that row, the same key appends again.',
          stage: ['focus:log'],
          source: sourceFocus(
            appendRecords,
            'WHERE dedup_key = ? LIMIT 1',
            'assigned.set(record.dedup_key, existing.offset);'
          ),
          durable: 'Deduplication keys live on the hot rows.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'guard',
          title: 'Schedule a sweep only if none is pending',
          description:
            'Scheduling a named alarm replaces its pending time, so arming it on every append would postpone retention for as long as traffic continues. The partition checks the sweeping key first and writes it before scheduling.',
          stage: ['sweeping', 'focus:sweeping'],
          source: sourceFocus(
            partition,
            "if (result.success && !(await this.ctx.storage.get<boolean>('sweeping'))) {",
            "await this.ctx.storage.put('sweeping', true);"
          ),
          durable: 'The sweeping key.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'schedule',
          title: 'Store the alarm row and set the object alarm',
          description:
            'enforceRetention(now + 60 s) upserts its durability_alarms row in a storage transaction that also sets the Partition’s one alarm to the earliest pending row.',
          stage: [
            'retention',
            'alarm',
            '-alarm->partition',
            '-retention->log',
            'focus:retention',
          ],
          source: sourceFocus(
            schedule,
            'await this.#engine.transaction((sql) => {',
            'ON CONFLICT(name) DO UPDATE SET'
          ),
          durable: 'The named alarm row and the object alarm commit together.',
          volatile:
            'The in-memory timer the scheduler sets after commit, which this instance only has.',
          status: 'commit',
        },
        {
          id: 'respond',
          title: 'Report acceptance per partition',
          description:
            'Each group was accepted or rejected on its own; a POST spanning partitions has no atomic outcome. A rejection is definite. A thrown or timed-out push is uncertain: the append may have committed, so a retry needs the same deduplication key.',
          stage: ['focus:producer'],
          source: sourceFocus(
            produce,
            'const accepted = await Promise.all(',
            'status: accepted.every((result) => result.success) ? 202 : 409,'
          ),
          durable: 'Records accepted by each partition.',
          volatile: 'Which pushes failed is known only to this request.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'retention',
      title: 'Flush the hot window to R2',
      description:
        'The object alarm runs enforceRetention, which moves records outside the hot bounds to R2 and re-arms while records remain hot.',
      steps: [
        {
          id: 'wake',
          title: 'The alarm starts the partition',
          description:
            'When the alarm fires, the runtime creates an instance if the partition was evicted, and alarm() hands the pass to the scheduler, which runs the due enforceRetention row.',
          stage: ['*', 'flow:retention'],
          source: sourceFocus(
            partition,
            'alarm(info?: AlarmInvocationInfo) {',
            'return this.scheduler.alarm(info);'
          ),
          durable: 'The alarm, the named alarm row, and the log rows.',
          volatile: 'A fresh helper set, if the object was evicted.',
          status: 'normal',
        },
        {
          id: 'trim',
          title: 'Select records outside the hot bounds',
          description:
            'trim() takes the oldest records, up to 100 at a time, while the log holds over 50,000 records or 256 MiB, or a record is older than seven days. The bounds are applied only when something calls trim().',
          stage: ['focus:log'],
          source: sourceFocus(
            trim,
            'const expiring = takeWhile(oldest, (row, index) => {',
            '(cutoff !== undefined && row.appended_at < cutoff)'
          ),
          durable: 'Rows are read, not changed.',
          volatile: 'The batch being moved.',
          status: 'normal',
        },
        {
          id: 'flush',
          title: 'Write the segment to R2 first',
          description:
            'The cold writer puts the batch at segments/<object id>/<firstOffset> unless an object already exists there. A failed write throws with the records still in the object.',
          stage: ['focus:r2'],
          source: sourceFocus(
            partition,
            'write: async ({ records, firstOffset }) => {',
            "onlyIf: { etagDoesNotMatch: '*' },"
          ),
          durable: 'The segment object in R2.',
          volatile: 'The serialized batch.',
          status: 'commit',
        },
        {
          id: 'index',
          title: 'Index the segment, then delete the hot rows',
          description:
            'The locator is stored in durability_log_segments before the rows are deleted, so a crash between them leaves the segment readable rather than records that point nowhere.',
          stage: ['focus:storage'],
          source: sourceFocus(
            trim,
            'insertSegment(this.#engine.sql, {',
            'trimThrough(sql, last.offset + 1, expiring.length)'
          ),
          durable:
            'The segment locator, then the deletion of the flushed rows.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'rearm',
          title: 'Re-arm while records remain hot',
          description:
            'The handler compares hotOffset with nextOffset; oldestOffset counts flushed segments and would stay low forever. Re-scheduling writes a new generation, so the completion of this run, which deletes only its own generation, leaves the new occurrence in place.',
          stage: ['focus:retention'],
          source: sourceFocus(
            partition,
            'const { hotOffset, nextOffset } = await this.log.bounds();',
            'await this.alarms.enforceRetention(Date.now() + retentionSweepMs);\n          return;'
          ),
          durable: 'The next occurrence 60 seconds out, and the object alarm.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'settle',
          title: 'Complete only this occurrence',
          description:
            'After the handler returns, the row is deleted only if it still has this run’s generation and attempt.',
          stage: ['focus:retention'],
          source: sourceFocus(
            execute,
            'complete: (_result, attempt) => {',
            'return removed ? timestamp : undefined;'
          ),
          durable: 'The finished occurrence is removed; a replacement stays.',
          volatile: 'The running entry for this name.',
          status: 'commit',
        },
        {
          id: 'stop',
          title: 'Stop sweeping when nothing is hot',
          description:
            'With no hot records left, the handler deletes the sweeping key that append() wrote and does not re-arm, so the partition can hibernate until the next append writes the key and schedules a sweep.',
          stage: ['focus:sweeping'],
          source: sourceFocus(
            partition,
            "await this.ctx.storage.delete('sweeping');"
          ),
          durable: 'No sweeping key and no pending retention row.',
          volatile: 'Nothing.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'retention-gaps',
      title: 'Where retention can stop',
      description:
        'States this example does not repair: retention stops until an application process notices and schedules a sweep.',
      steps: [
        {
          id: 'race',
          title: 'A crash between the key and the alarm',
          description:
            'The sweeping key and the named alarm row are written by two separate awaits. If the object is evicted after the put commits and before the alarm transaction, sweeping is set with no sweep pending, and every later append skips scheduling.',
          stage: ['*', 'focus:sweeping'],
          source: sourceFocus(
            partition,
            "await this.ctx.storage.put('sweeping', true);",
            'await this.alarms.enforceRetention(Date.now() + retentionSweepMs);\n    }'
          ),
          durable: 'The sweeping key, without a durability_alarms row.',
          volatile: 'The interrupted append and its planned schedule call.',
          status: 'gap',
        },
        {
          id: 'exhausted',
          title: 'A sweep that keeps failing',
          description:
            'If trim() keeps throwing, for example because R2 writes fail, the fifth failed attempt marks the row failed. A trim longer than the five-minute attempt timeout fails it at once. sweeping stays set, so appends do not schedule another sweep.',
          stage: ['focus:retention'],
          source: sourceFocus(
            decideRetry,
            'isNonRetryable(error) ||',
            'spec.isTerminal(error);'
          ),
          durable:
            'A failed durability_alarms row and the sweeping key; the hot window keeps growing.',
          volatile: 'Nothing.',
          status: 'gap',
        },
        {
          id: 'timeout',
          title: 'A timed-out attempt is final',
          description:
            'Named alarms treat their own attempt timeout as terminal unless retryTimeouts is set. This example sets neither, so an oversized trim pass is not retried.',
          stage: ['focus:retention'],
          source: sourceFocus(
            execute,
            'isTerminal: (error) =>',
            'isErrorInstance(error, DurableAlarmTimeoutError) && !retryTimeouts,'
          ),
          durable: 'The failed row.',
          volatile: 'The aborted attempt.',
          status: 'gap',
        },
        {
          id: 'expire',
          title: 'R2 expiry needs a matching forget',
          description:
            'R2 expires segment objects by its own lifecycle rule. expireCold(before) removes the matching locators; until then a read that reaches an expired segment throws LogTruncatedError. Forgetting too early makes retained data unreachable.',
          stage: ['focus:r2'],
          source: sourceFocus(
            partition,
            'expireCold(before: number) {',
            'return this.log.forgetColdBefore(before);'
          ),
          durable: 'Segment locators in this object and objects in R2.',
          volatile: 'Nothing.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'consume',
      title: 'Read, handle, commit',
      description:
        'A consumer group polls every partition independently and moves its cursor only after the work succeeds.',
      steps: [
        {
          id: 'poll',
          title: 'Poll each partition by name',
          description:
            'The Worker reaches all eight topic:partition objects through the PARTITIONS binding and polls them in parallel, so a slow partition does not hold up the others.',
          stage: ['poller', 'partition', 'partition-object', 'focus:poller'],
          source: sourceFocus(
            poll,
            'const partitions = [...Array(partitionCount).keys()].map((index) =>',
            'env.PARTITIONS.getByName(`${topic}:${index}`)'
          ),
          durable: 'Nothing changes by polling.',
          volatile: 'The eight stubs.',
          status: 'normal',
        },
        {
          id: 'cursor',
          title: 'Start from the group’s cursor',
          description:
            'consume() reads the group’s row in durability_log_cursors. A group that never committed starts at oldestOffset, which includes flushed segments.',
          stage: ['log', 'storage', 'focus:storage'],
          source: sourceFocus(
            partition,
            'const from =',
            '(await this.log.cursor(group)) ?? (await this.log.bounds()).oldestOffset;'
          ),
          durable: 'Each group’s cursor is its own row.',
          volatile: 'Nothing.',
          status: 'normal',
        },
        {
          id: 'read',
          title: 'Serve hot rows or a cold segment',
          description:
            'A cursor in the hot window reads rows from SQLite. A cursor below it reads the segment from R2, so a lagging group keeps reading flushed records; below everything readable, read() throws LogTruncatedError.',
          stage: ['r2', 'focus:log'],
          source: sourceFocus(
            read,
            'options.from < bounds.hotOffset',
            '? await this.#rehydrate(options.from, capped, bounds)'
          ),
          durable: 'The cursor is unchanged by reading.',
          volatile: 'The page of up to 100 records.',
          status: 'normal',
        },
        {
          id: 'handle',
          title: 'Do the work before committing',
          description:
            'The Worker hands the page to handle() first. The cursor still points at the start of the page.',
          stage: ['handler', 'flow:consume'],
          source: sourceFocus(poll, 'await handle(page.records);'),
          durable: 'No cursor movement yet.',
          volatile: 'The page and the handler’s progress.',
          status: 'normal',
        },
        {
          id: 'commit',
          title: 'Advance the cursor',
          description:
            'Only after handle() returns does the Worker commit page.nextOffset. The upsert ignores a lower offset, so a late commit cannot rewind the cursor.',
          stage: ['focus:storage'],
          source: sourceFocus(
            commitCursor,
            'ON CONFLICT(consumer) DO UPDATE',
            'WHERE excluded."offset" > durability_log_cursors."offset"`,'
          ),
          durable: 'The group’s cursor at page.nextOffset.',
          volatile: 'The response with nextOffset, lag, and handled count.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'crash-before-commit',
      title: 'Crash after work, before commit',
      description:
        'An illustrative failure after the handler’s side effect and before the cursor write. The page is delivered again; only the receiver can avoid a second effect.',
      steps: [
        {
          id: 'page',
          title: 'Read a page at the cursor',
          description:
            'Assume the group’s cursor is at 41 and consume() returns offsets 41 to 50.',
          stage: ['*', 'flow:consume'],
          source: sourceFocus(
            poll,
            'const page = await stub.consume(group, 100);'
          ),
          durable: 'The cursor is at 41.',
          volatile: 'The page, held by this request.',
          status: 'normal',
        },
        {
          id: 'effect',
          title: 'The work completes',
          description:
            'handle() performs its side effects for 41 to 50. In this example it only logs; a real handler would write somewhere outside the partition.',
          stage: ['focus:handler'],
          source: sourceFocus(
            handle,
            'for (const record of records) {',
            'console.log('
          ),
          durable: 'The receiver’s effects, outside this object.',
          volatile: 'The knowledge that the page was handled.',
          status: 'normal',
        },
        {
          id: 'crash',
          title: 'The request fails before commit',
          description:
            'The Worker request dies before commit() reaches the partition. Nothing in the partition records that the page was handled.',
          stage: ['focus:poller'],
          source: sourceFocus(
            poll,
            'await stub.commit(group, page.nextOffset);'
          ),
          durable: 'The cursor is still 41.',
          volatile: 'The page and the handled result are gone.',
          status: 'failure',
        },
        {
          id: 'replay',
          title: 'The next poll reads the same page',
          description:
            'The next poll starts from the unchanged cursor, so offsets 41 to 50 are delivered again rather than skipped.',
          stage: ['focus:storage'],
          source: sourceFocus(
            partition,
            'const from =',
            'return this.log.read({ from, limit });'
          ),
          durable: 'The same cursor selects the same records.',
          volatile: 'A new request holds the page.',
          status: 'recovery',
        },
        {
          id: 'receiver',
          title: 'The receiver must deduplicate',
          description:
            'handle() runs again for records it already applied. Only the receiver, keyed on topic, partition, and offset or an inbox record, can return without a second effect; this example has no such layer.',
          stage: ['focus:handler'],
          source: sourceFocus(
            handle,
            'const handle = async (records: LogRecord<Event>[]): Promise<void> => {'
          ),
          durable:
            'At-least-once delivery; exactly-once effects need the receiver’s own record.',
          volatile: 'Nothing from the first attempt survived.',
          status: 'gap',
        },
        {
          id: 'settle',
          title: 'Commit after the repeated work',
          description:
            'The cursor moves to 51. Two uncoordinated pollers for the same group could both read 41 to 50 before either commits; the cursor ignores regressions but does not fence them.',
          stage: ['flow:consume'],
          source: sourceFocus(
            poll,
            'await stub.commit(group, page.nextOffset);'
          ),
          durable: 'The cursor is at 51.',
          volatile: 'The response for this poll.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'naive',
      title: 'An in-memory queue that commits first',
      description:
        'A naive worker keeps events in memory and advances its offset before calling the downstream service. Each step shows where that design loses an event and the line here that prevents it; there is no naive source.',
      steps: [
        {
          id: 'memory',
          title: 'Naive: events wait in memory',
          description:
            'A naive queue holds event 41 in the worker’s memory, and a restart loses it. Here append() returns only after the records are inserted in the Partition’s SQLite.',
          stage: ['*', 'focus:storage'],
          source: sourceFocus(
            append,
            'const offsets = this.#engine.transactionSync((sql) =>'
          ),
          durable: 'The records, before the producer hears success.',
          volatile: 'A naive queue’s contents, lost on restart.',
          status: 'failure',
        },
        {
          id: 'commit-first',
          title: 'Naive: the offset moves before the work',
          description:
            'The naive consumer commits 42 and then crashes before handling 41, so the restart begins at 42 and 41 is never handled. Here the commit comes after handle(); a crash re-reads the page instead.',
          stage: ['flow:consume'],
          source: sourceFocus(
            poll,
            '// Commit only once the work succeeded. Committing first would make',
            'await stub.commit(group, page.nextOffset);'
          ),
          durable: 'The cursor moves only after the work.',
          volatile: 'A crashed request’s page.',
          status: 'recovery',
        },
        {
          id: 'separate',
          title: 'Reading never moves the cursor',
          description:
            'consume() reads from the cursor and writes nothing, so a read cannot acknowledge a record by itself. Only commit() writes the group’s row.',
          stage: ['focus:log'],
          source: sourceFocus(
            partition,
            '/** Acknowledging is separate from reading, so a crash re-reads the page. */',
            'return this.log.commit(group, offset);'
          ),
          durable: 'The cursor row.',
          volatile: 'Nothing.',
          status: 'recovery',
        },
        {
          id: 'retained',
          title: 'Naive: acknowledged events are gone',
          description:
            'A queue that deletes on acknowledgement cannot replay. Here records stay until trim(), and flushed ones stay readable from R2, so a group can lag or a new group can start from the oldest record.',
          stage: ['focus:r2'],
          source: sourceFocus(
            partition,
            'read: async (locator) => {',
            'return stored ? await stored.json<LogRecord<Event>[]>() : undefined;'
          ),
          durable: 'Hot rows and R2 segments.',
          volatile: 'Nothing.',
          status: 'recovery',
        },
        {
          id: 'duplicates',
          title: 'The cost is redelivery',
          description:
            'Commit-after-work turns a lost event into a repeated one. The receiver still has to deduplicate.',
          stage: ['focus:handler'],
          source: sourceFocus(
            poll,
            '// this at-most-once, silently skipping a page on a crash. Throwing',
            '// instead re-reads it, so processing must tolerate duplicates.'
          ),
          durable: 'At-least-once delivery.',
          volatile: 'Nothing.',
          status: 'gap',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
