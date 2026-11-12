import * as v from 'valibot';
import { traceMethods } from '../dev.js';
import {
  LogAppendError,
  LogLeaseError,
  LogTruncatedError,
  reportFailure,
  serializeError,
} from '../errors.js';
import {
  RoutingLoad,
  type EnqueueResult,
  type LoadSnapshot,
} from '../routing/load.js';
import {
  durabilityLogLeaseMigrations,
  durabilityLogMigrations,
} from './migrations.js';
import { migrateCapability } from '../migrations.js';
import { assertPositiveInteger } from '../policy.js';
import {
  assertChannel,
  defaultChannel,
  engineFor,
  type Engine,
  type SchedulerAttachment,
} from '../scheduler/index.js';
import { deserialize, serialize } from '../serialization.js';

const logRecordRowSchema = v.object({
  offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  dedup_key: v.string(),
  payload: v.string(),
  bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  appended_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

type LogRecordRow = v.InferOutput<typeof logRecordRowSchema>;

const logCursorRowSchema = v.object({
  consumer: v.string(),
  offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  committed_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

/** One contiguous run of records moved out of the object into cold storage. */
const logSegmentRowSchema = v.object({
  first_offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  last_offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  locator: v.string(),
  bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  flushed_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

type LogSegmentRow = v.InferOutput<typeof logSegmentRowSchema>;

/** A range of records committed to a cold write that has not been indexed. */
const pendingFlushRowSchema = v.object({
  first_offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  last_offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

type PendingFlushRow = v.InferOutput<typeof pendingFlushRowSchema>;

/**
 * One in-flight or settled range of offsets held by a consumer. A range is
 * redelivered under a fresh `batch_id`, so an ack from a previous holder is
 * rejected rather than advancing a range someone else now owns.
 */
const logLeaseRowSchema = v.object({
  batch_id: v.string(),
  consumer: v.string(),
  first_offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  last_offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  state: v.picklist(['active', 'pending', 'acked', 'skipped']),
  attempt: v.pipe(v.number(), v.safeInteger(), v.gtValue(0)),
  expires_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  created_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export type LogLeaseRow = v.InferOutput<typeof logLeaseRowSchema>;

type LogLeaseState = LogLeaseRow['state'];

const allocationRowSchema = v.object({
  allocated_offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

const offsetRowSchema = v.object({
  offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
const seqRowSchema = v.object({
  seq: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
const countRowSchema = v.object({
  count: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
const totalBytesRowSchema = v.object({
  total_bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
const boundsRowSchema = v.object({
  hot: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  cold: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  next_offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export type LogBounds = {
  /**
   * Lowest readable offset, counting flushed segments that can be rehydrated.
   * Equals `nextOffset` once nothing is readable.
   */
  oldestOffset: number;
  /** Lowest offset still held in the object rather than cold storage. */
  hotOffset: number;
  /** Offset the next appended record receives. */
  nextOffset: number;
};

/**
 * Inserts the batch and returns each record's offset in input order. A record
 * whose deduplication key is already present keeps its original offset and
 * consumes no new one, so a repeated append is idempotent while that record is
 * still held in the object. Runs inside the caller's transaction.
 */
const appendRecords = (
  sql: SqlStorage,
  channel: string,
  records: readonly Pick<LogRecordRow, 'dedup_key' | 'payload' | 'bytes'>[],
  appendedAt: number
): number[] => {
  const assigned = new Map<string, number>();
  for (const record of records) {
    const existing = v.parse(
      v.optional(offsetRowSchema),
      sql
        .exec(
          `SELECT "offset" FROM durability_log_records
           WHERE channel = ? AND dedup_key = ? LIMIT 1`,
          channel,
          record.dedup_key
        )
        .toArray()[0]
    );
    if (existing !== undefined) {
      assigned.set(record.dedup_key, existing.offset);
    }
  }

  const fresh = records.filter((record) => !assigned.has(record.dedup_key));
  const distinct = [...new Map(fresh.map((row) => [row.dedup_key, row]))];
  if (distinct.length === 0) {
    return records.map((record) => assigned.get(record.dedup_key)!);
  }

  // A channel's counter row is created by its first append.
  const first = v.parse(
    seqRowSchema,
    sql
      .exec(
        `INSERT INTO durability_log_seq (channel, next_offset, total_bytes)
         VALUES (?, ?, 0)
         ON CONFLICT(channel) DO UPDATE
           SET next_offset = durability_log_seq.next_offset + excluded.next_offset
         RETURNING next_offset - ? AS seq`,
        channel,
        distinct.length,
        distinct.length
      )
      .toArray()[0]
  ).seq;
  let added = 0;
  distinct.forEach(([dedupKey, row], index) => {
    const offset = first + index;
    assigned.set(dedupKey, offset);
    added += row.bytes;
    sql.exec(
      `INSERT INTO durability_log_records
         (channel, "offset", dedup_key, payload, bytes, appended_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, dedup_key) DO NOTHING`,
      channel,
      offset,
      dedupKey,
      row.payload,
      row.bytes,
      appendedAt
    );
  });
  sql.exec(
    `UPDATE durability_log_seq SET total_bytes = total_bytes + ?
     WHERE channel = ?`,
    added,
    channel
  );

  return records.map((record) => assigned.get(record.dedup_key)!);
};

const readRecords = (
  sql: SqlStorage,
  channel: string,
  from: number,
  limit: number
): LogRecordRow[] =>
  v.parse(
    v.array(logRecordRowSchema),
    sql
      .exec(
        `SELECT * FROM durability_log_records
         WHERE channel = ? AND "offset" >= ?
         ORDER BY "offset" ASC
         LIMIT ?`,
        channel,
        from,
        limit
      )
      .toArray()
  );

const readBounds = (sql: SqlStorage, channel: string): LogBounds => {
  const row = v.parse(
    boundsRowSchema,
    sql
      .exec(
        `SELECT
           (SELECT MIN("offset") FROM durability_log_records
            WHERE channel = ?1) AS hot,
           (SELECT MIN(first_offset) FROM durability_log_segments
            WHERE channel = ?1) AS cold,
           COALESCE(
             (SELECT next_offset FROM durability_log_seq WHERE channel = ?1),
             0
           ) AS next_offset`,
        channel
      )
      .toArray()[0]
  );
  const hotOffset = row.hot ?? row.next_offset;
  return {
    oldestOffset: Math.min(row.cold ?? hotOffset, hotOffset),
    hotOffset,
    nextOffset: row.next_offset,
  };
};

const countRecords = (sql: SqlStorage, channel: string): number =>
  v.parse(
    countRowSchema,
    sql
      .exec(
        'SELECT COUNT(*) AS count FROM durability_log_records WHERE channel = ?',
        channel
      )
      .toArray()[0]
  ).count;

/** Bytes of record payloads held in the object, excluding flushed segments. */
const totalBytes = (sql: SqlStorage, channel: string): number =>
  v.parse(
    totalBytesRowSchema,
    sql
      .exec(
        `SELECT COALESCE(
           (SELECT total_bytes FROM durability_log_seq WHERE channel = ?),
           0
         ) AS total_bytes`,
        channel
      )
      .toArray()[0]
  ).total_bytes;

/** Oldest retained records in offset order, for flush-or-delete decisions. */
const listOldest = (
  sql: SqlStorage,
  channel: string,
  limit: number
): LogRecordRow[] =>
  v.parse(
    v.array(logRecordRowSchema),
    sql
      .exec(
        `SELECT * FROM durability_log_records
         WHERE channel = ?
         ORDER BY "offset" ASC
         LIMIT ?`,
        channel,
        limit
      )
      .toArray()
  );

/**
 * Deletes at most `limit` records below `through`, oldest first, and returns
 * how many were removed. Runs inside the caller's transaction.
 */
const trimThrough = (
  sql: SqlStorage,
  channel: string,
  through: number,
  limit: number
): number => {
  const removed = v.parse(
    v.array(logRecordRowSchema),
    sql
      .exec(
        `DELETE FROM durability_log_records
         WHERE channel = ?1 AND "offset" IN (
           SELECT "offset" FROM durability_log_records
           WHERE channel = ?1 AND "offset" < ?2
           ORDER BY "offset" ASC
           LIMIT ?3
         )
         RETURNING *`,
        channel,
        through,
        limit
      )
      .toArray()
  );
  if (removed.length === 0) {
    return 0;
  }
  sql.exec(
    `UPDATE durability_log_seq SET total_bytes = MAX(0, total_bytes - ?)
     WHERE channel = ?`,
    removed.reduce((total, row) => total + row.bytes, 0),
    channel
  );
  return removed.length;
};

/** Records where a flushed run now lives, so a read can rehydrate it. */
const insertSegment = (
  sql: SqlStorage,
  channel: string,
  row: LogSegmentRow
): void => {
  sql.exec(
    `INSERT INTO durability_log_segments
       (channel, first_offset, last_offset, locator, bytes, flushed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel, first_offset) DO UPDATE SET
       last_offset = excluded.last_offset,
       locator = excluded.locator,
       bytes = excluded.bytes,
       flushed_at = excluded.flushed_at`,
    channel,
    row.first_offset,
    row.last_offset,
    row.locator,
    row.bytes,
    row.flushed_at
  );
};

const readPendingFlush = (
  sql: SqlStorage,
  channel: string
): PendingFlushRow | undefined =>
  v.parse(
    v.optional(pendingFlushRowSchema),
    sql
      .exec(
        `SELECT first_offset, last_offset FROM durability_log_pending_flushes
         WHERE channel = ?`,
        channel
      )
      .toArray()[0]
  );

const setPendingFlush = (
  sql: SqlStorage,
  channel: string,
  row: PendingFlushRow
): void => {
  sql.exec(
    `INSERT INTO durability_log_pending_flushes
       (channel, first_offset, last_offset)
     VALUES (?, ?, ?)
     ON CONFLICT(channel) DO UPDATE SET
       first_offset = excluded.first_offset,
       last_offset = excluded.last_offset`,
    channel,
    row.first_offset,
    row.last_offset
  );
};

/** The segment holding an offset, if that offset was flushed. */
const findSegment = (
  sql: SqlStorage,
  channel: string,
  offset: number
): LogSegmentRow | undefined =>
  v.parse(
    v.optional(logSegmentRowSchema),
    sql
      .exec(
        `SELECT * FROM durability_log_segments
         WHERE channel = ?1 AND first_offset <= ?2 AND last_offset >= ?2
         LIMIT 1`,
        channel,
        offset
      )
      .toArray()[0]
  );

const readCursors = (sql: SqlStorage, channel: string) =>
  v.parse(
    v.array(logCursorRowSchema),
    sql
      .exec(
        `SELECT * FROM durability_log_cursors
         WHERE channel = ?
         ORDER BY consumer`,
        channel
      )
      .toArray()
  );

const readCursor = (
  sql: SqlStorage,
  channel: string,
  consumer: string
): number | undefined =>
  v.parse(
    v.optional(offsetRowSchema),
    sql
      .exec(
        `SELECT "offset" FROM durability_log_cursors
           WHERE channel = ? AND consumer = ? LIMIT 1`,
        channel,
        consumer
      )
      .toArray()[0]
  )?.offset;

/** Advances a cursor, ignoring regressions so a late commit cannot rewind it. */
const commitCursor = (
  sql: SqlStorage,
  channel: string,
  consumer: string,
  offset: number,
  committedAt: number
): void => {
  sql.exec(
    `INSERT INTO durability_log_cursors
       (channel, consumer, "offset", committed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel, consumer) DO UPDATE
       SET "offset" = excluded."offset", committed_at = excluded.committed_at
       WHERE excluded."offset" > durability_log_cursors."offset"`,
    channel,
    consumer,
    offset,
    committedAt
  );
};

/** Highest offset handed to a lease, which runs ahead of the commit. */
const readAllocation = (
  sql: SqlStorage,
  channel: string,
  consumer: string
): number | undefined =>
  v.parse(
    v.optional(allocationRowSchema),
    sql
      .exec(
        `SELECT allocated_offset FROM durability_log_allocations
           WHERE channel = ? AND consumer = ? LIMIT 1`,
        channel,
        consumer
      )
      .toArray()[0]
  )?.allocated_offset;

const setAllocation = (
  sql: SqlStorage,
  channel: string,
  consumer: string,
  offset: number
): void => {
  sql.exec(
    `INSERT INTO durability_log_allocations
       (channel, consumer, allocated_offset)
     VALUES (?, ?, ?)
     ON CONFLICT(channel, consumer) DO UPDATE
       SET allocated_offset = excluded.allocated_offset`,
    channel,
    consumer,
    offset
  );
};

const insertLease = (
  sql: SqlStorage,
  channel: string,
  row: LogLeaseRow
): void => {
  sql.exec(
    `INSERT INTO durability_log_leases
       (channel, batch_id, consumer, first_offset, last_offset, state, attempt,
        expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    channel,
    row.batch_id,
    row.consumer,
    row.first_offset,
    row.last_offset,
    row.state,
    row.attempt,
    row.expires_at,
    row.created_at
  );
};

/**
 * Oldest range owed redelivery: explicitly nacked, or held past its expiry.
 * Claiming rewrites its `batch_id`, fencing the previous holder.
 */
const claimExpired = (
  sql: SqlStorage,
  channel: string,
  consumer: string,
  now: number,
  batchId: string,
  expiresAt: number
): LogLeaseRow | undefined =>
  v.parse(
    v.optional(logLeaseRowSchema),
    sql
      .exec(
        `UPDATE durability_log_leases
         SET batch_id = ?1, state = 'active', attempt = attempt + 1,
             expires_at = ?2
         WHERE channel = ?3 AND batch_id = (
           SELECT batch_id FROM durability_log_leases
           WHERE channel = ?3
             AND consumer = ?4
             AND (state = 'pending'
                  OR (state = 'active' AND expires_at <= ?5))
           ORDER BY first_offset ASC
           LIMIT 1
         )
         RETURNING *`,
        batchId,
        expiresAt,
        channel,
        consumer,
        now
      )
      .toArray()[0]
  );

/** Ranges still held, so parallelism can be bounded per consumer. */
const countHeld = (
  sql: SqlStorage,
  channel: string,
  consumer: string,
  now: number
): number =>
  v.parse(
    countRowSchema,
    sql
      .exec(
        `SELECT COUNT(*) AS count FROM durability_log_leases
         WHERE channel = ?
           AND consumer = ?
           AND (state = 'pending' OR (state = 'active' AND expires_at > ?))`,
        channel,
        consumer,
        now
      )
      .toArray()[0]
  ).count;

/** Settles one range, failing when the batch was fenced or already settled. */
const settleLease = (
  sql: SqlStorage,
  channel: string,
  batchId: string,
  state: LogLeaseState,
  expiresAt: number
): boolean =>
  sql
    .exec(
      `UPDATE durability_log_leases
       SET state = ?, expires_at = ?
       WHERE channel = ? AND batch_id = ? AND state = 'active'
       RETURNING batch_id`,
      state,
      expiresAt,
      channel,
      batchId
    )
    .toArray().length > 0;

/**
 * Ranges from `from` in offset order, so a commit can advance over the
 * unbroken run of settled ones and no further.
 */
const leasesFrom = (
  sql: SqlStorage,
  channel: string,
  consumer: string,
  from: number,
  limit: number
): LogLeaseRow[] =>
  v.parse(
    v.array(logLeaseRowSchema),
    sql
      .exec(
        `SELECT * FROM durability_log_leases
         WHERE channel = ? AND consumer = ? AND last_offset >= ?
         ORDER BY first_offset ASC
         LIMIT ?`,
        channel,
        consumer,
        from,
        limit
      )
      .toArray()
  );

const deleteLeases = (
  sql: SqlStorage,
  channel: string,
  batchIds: readonly string[]
): void => {
  if (batchIds.length === 0) {
    return;
  }
  sql.exec(
    `DELETE FROM durability_log_leases
     WHERE channel = ?
       AND batch_id IN (${batchIds.map(() => '?').join(', ')})`,
    channel,
    ...batchIds
  );
};

export type LogAppendInput<Body = unknown> = {
  body: Body;
  /**
   * Appending the same key twice returns the first offset instead of a second
   * record. Deduplication lasts only while the original record is retained.
   */
  deduplicationKey?: string;
};

export type LogRecord<Body = unknown> = {
  offset: number;
  deduplicationKey: string;
  body: Body;
  appendedAt: number;
};

export type LogPage<Body = unknown> = {
  records: LogRecord<Body>[];
  /** Offset to read from next; commit this to acknowledge the page. */
  nextOffset: number;
  /** Records appended beyond this page. */
  lag: number;
};

export type LogReadOptions = {
  from: number;
  limit?: number;
};

/** One contiguous run of records leaving the object, oldest first. */
export type LogSegment<Body = unknown> = {
  /**
   * The log always supplies its channel. Optional for legacy callers that
   * construct segments themselves; omitted means `default`. Shared external
   * storage must include the channel in the location it writes to.
   */
  channel?: string;
  firstOffset: number;
  lastOffset: number;
  records: LogRecord<Body>[];
};

/**
 * Somewhere records live once they leave the object, usually R2. `write`
 * returns a locator the log stores, and `read` hands the segment back so a
 * lagging consumer can keep reading flushed offsets. Returning undefined from
 * `read` means the segment is gone for good, which surfaces as truncation.
 */
export type LogColdStorage<Body = unknown> = {
  write(segment: LogSegment<Body>): Promise<string>;
  read(locator: string): Promise<LogRecord<Body>[] | undefined>;
};

/** A claimed range of offsets, held until acked, nacked, or expired. */
export type LogLease<Body = unknown> = {
  /** Identifies this delivery. A redelivery of the same range gets a new one. */
  batchId: string;
  consumer: string;
  records: LogRecord<Body>[];
  firstOffset: number;
  lastOffset: number;
  /** One-based delivery attempt for this range. */
  attempt: number;
  expiresAt: number;
};

export type LogLeaseOptions = {
  /** Ranges one consumer may hold at once. Defaults to 1. */
  maxParallelism?: number;
  /** How long a claim is held before another worker may take it. */
  leaseMs?: number;
  /**
   * Attempts before a range is skipped instead of redelivered forever. Only
   * honoured together with `onPoison`: without somewhere to send the records,
   * blocking the consumer beats silently dropping them.
   */
  maxAttempts?: number;
  onPoison?: (lease: LogLease) => Promise<void>;
};

export type LogRetention = {
  maxAgeMs?: number;
  maxRecords?: number;
  /**
   * Payload bytes held in the object. Reaching it flushes the oldest records
   * to cold storage, or deletes them when no cold storage is configured.
   */
  maxBytes?: number;
};

export type DurabilityLogConfig<Body = unknown> = SchedulerAttachment & {
  /**
   * Partitions records, offsets, cursors, cold segments, and leases, so
   * several logs share one object without seeing each other. Defaults to
   * `default`; one instance per channel may attach to a scheduler.
   */
  channel?: string;
  /** Without retention the log grows until the object's storage limit. */
  retention?: LogRetention;
  cold?: LogColdStorage<Body>;
  /** Enables `lease`/`ack`/`nack`; plain `read`/`commit` needs no leases. */
  leases?: LogLeaseOptions;
  routing?: RoutingLoad;
  maxBatchSize?: number;
};

/**
 * A single object holds a hot window, not an unbounded log, so the byte
 * budget is capped well below the platform's per-object limit.
 */
export const maxLogBytes = 1_073_741_824;

/**
 * A composable DO capability: an append-only record log addressed by offset,
 * read by pulling consumers that own their cursors. Share a scheduler with
 * operations, alarms, and fanout on the same object.
 *
 * Unlike fanout, records are retained rather than deleted on acknowledgement,
 * so a consumer can rewind or a new one can start from the beginning. Records
 * leave only through `trim`, and a consumer that falls behind retention reads a
 * `LogTruncatedError` rather than silently skipping records.
 */
export class DurabilityLog<Body = unknown> {
  readonly #engine: Engine;
  readonly #channel: string;
  readonly #routing: RoutingLoad;
  readonly #retention: LogRetention | undefined;
  readonly #cold: LogColdStorage<Body> | undefined;
  readonly #leases: LogLeaseOptions | undefined;
  #maxParallelism = 1;
  #leaseMs = 30_000;
  readonly #maxBatchSize: number;
  readonly #encoder = new TextEncoder();

  constructor(config: DurabilityLogConfig<Body>) {
    this.#channel = assertChannel(
      'DurabilityLog',
      config.channel ?? defaultChannel
    );
    this.#maxBatchSize = config.maxBatchSize ?? 100;
    assertPositiveInteger('maxBatchSize', this.#maxBatchSize);
    if (config.retention?.maxAgeMs !== undefined) {
      assertPositiveInteger('retention.maxAgeMs', config.retention.maxAgeMs);
    }
    if (config.retention?.maxRecords !== undefined) {
      assertPositiveInteger(
        'retention.maxRecords',
        config.retention.maxRecords
      );
    }
    if (config.retention?.maxBytes !== undefined) {
      assertPositiveInteger('retention.maxBytes', config.retention.maxBytes);
      if (config.retention.maxBytes > maxLogBytes) {
        throw new RangeError(
          `retention.maxBytes must not exceed ${maxLogBytes} bytes`
        );
      }
    }
    this.#routing = config.routing ?? new RoutingLoad();
    this.#retention = config.retention;
    this.#cold = config.cold;
    this.#leases = config.leases;
    if (this.#leases) {
      this.#maxParallelism = this.#leases.maxParallelism ?? 1;
      assertPositiveInteger('leases.maxParallelism', this.#maxParallelism);
      this.#leaseMs = this.#leases.leaseMs ?? 30_000;
      assertPositiveInteger('leases.leaseMs', this.#leaseMs);
      if (this.#leases.maxAttempts !== undefined) {
        assertPositiveInteger('leases.maxAttempts', this.#leases.maxAttempts);
      }
    }

    this.#engine = engineFor(config);
    this.#engine.migrateSchema('log', durabilityLogMigrations);
    if (this.#leases) {
      this.#engine.migrateSchema('logLeases', durabilityLogLeaseMigrations);
    }
    this.#engine.claimChannel(
      'durability_log_records',
      this.#channel,
      'DurabilityLog'
    );
  }

  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ) {
    return migrateCapability(
      context.storage,
      'log',
      durabilityLogMigrations,
      target
    );
  }

  /**
   * Appends the batch atomically. Definite input rejections return
   * success:false; storage and commit uncertainty throws, so a caller never
   * reads a transport failure as a definite rejection.
   */
  async append(
    records: LogAppendInput<Body> | LogAppendInput<Body>[]
  ): Promise<EnqueueResult<number[]>> {
    const finish = this.#routing.begin('inbound');
    try {
      const inputs = Array.isArray(records) ? records : [records];
      let rows: Array<{ dedup_key: string; payload: string; bytes: number }>;
      try {
        if (inputs.length === 0) {
          throw new LogAppendError('Append requires at least one record');
        }
        if (inputs.length > this.#maxBatchSize) {
          throw new LogAppendError(
            `Append of ${inputs.length} records exceeds maxBatchSize ${this.#maxBatchSize}`
          );
        }
        rows = inputs.map((input) => {
          if (input.deduplicationKey === '') {
            throw new LogAppendError(
              'Append deduplication keys must be non-empty'
            );
          }
          const payload = serialize(input.body);
          return {
            dedup_key: input.deduplicationKey ?? crypto.randomUUID(),
            payload,
            bytes: this.#encoder.encode(payload).byteLength,
          };
        });
      } catch (error) {
        if (!(error instanceof LogAppendError)) {
          throw error;
        }
        return {
          success: false,
          error: serializeError(error),
          load: await this.load(),
        };
      }

      const appendedAt = Date.now();
      const offsets = this.#engine.transactionSync((sql) =>
        appendRecords(sql, this.#channel, rows, appendedAt)
      );
      return { success: true, value: offsets, load: await this.load() };
    } finally {
      finish();
    }
  }

  /**
   * Reads forward from an offset. Offsets already flushed are rehydrated from
   * cold storage, so a lagging consumer keeps reading instead of failing; only
   * offsets below everything readable raise `LogTruncatedError`.
   */
  async read(options: LogReadOptions): Promise<LogPage<Body>> {
    const limit = options.limit ?? this.#maxBatchSize;
    assertPositiveInteger('limit', limit);
    if (!Number.isInteger(options.from) || options.from < 0) {
      throw new LogAppendError('Read offset must be a non-negative integer');
    }
    const bounds = readBounds(this.#engine.sql, this.#channel);
    if (options.from < bounds.oldestOffset) {
      throw new LogTruncatedError(options.from, bounds.oldestOffset);
    }
    const capped = Math.min(limit, this.#maxBatchSize);
    const records =
      options.from < bounds.hotOffset
        ? await this.#rehydrate(options.from, capped, bounds)
        : readRecords(
            this.#engine.sql,
            this.#channel,
            options.from,
            capped
          ).map((row) => this.#record(row));
    const nextOffset =
      records.length === 0
        ? Math.max(options.from, bounds.nextOffset)
        : records[records.length - 1]!.offset + 1;
    return {
      records,
      nextOffset,
      lag: Math.max(0, bounds.nextOffset - nextOffset),
    };
  }

  /**
   * Cold reads cost a round trip to external storage and open input gates, so
   * they serve only consumers that fell behind the hot window.
   */
  async #rehydrate(
    from: number,
    limit: number,
    bounds: LogBounds
  ): Promise<LogRecord<Body>[]> {
    const segment = findSegment(this.#engine.sql, this.#channel, from);
    const records = segment
      ? await this.#cold?.read(segment.locator)
      : undefined;
    if (!records) {
      // The index outlived the data, so the offset is unreadable after all.
      throw new LogTruncatedError(from, Math.max(from + 1, bounds.hotOffset));
    }
    return records
      .filter((record) => record.offset >= from)
      .sort((left, right) => left.offset - right.offset)
      .slice(0, limit);
  }

  #record(row: LogRecordRow): LogRecord<Body> {
    return {
      offset: row.offset,
      deduplicationKey: row.dedup_key,
      body: deserialize(row.payload) as Body,
      appendedAt: row.appended_at,
    };
  }

  /** The retained window. `oldestOffset` equals `nextOffset` when empty. */
  async bounds(): Promise<LogBounds> {
    return readBounds(this.#engine.sql, this.#channel);
  }

  /** Undefined until the consumer commits, so callers choose their own start. */
  async cursor(consumer: string): Promise<number | undefined> {
    return readCursor(this.#engine.sql, this.#channel, consumer);
  }

  /** Records progress. Regressions are ignored, so a late commit cannot rewind. */
  async commit(consumer: string, offset: number): Promise<void> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new LogAppendError('Commit offset must be a non-negative integer');
    }
    commitCursor(this.#engine.sql, this.#channel, consumer, offset, Date.now());
  }

  async cursors(): Promise<Record<string, number>> {
    return Object.fromEntries(
      readCursors(this.#engine.sql, this.#channel).map((row) => [
        row.consumer,
        row.offset,
      ])
    );
  }

  /**
   * Enforces retention on the oldest records: with cold storage they are
   * flushed and stay readable through rehydration, without it they are
   * deleted. A cold write failure propagates with the records still in the
   * object, so configured storage cannot be skipped.
   *
   * Retention ignores cursors, as a log should: a consumer slower than
   * everything readable learns through `LogTruncatedError`.
   */
  async trim(): Promise<number> {
    if (!this.#retention) {
      return 0;
    }
    if (!this.#cold) {
      return this.#deleteExpired(this.#retention);
    }
    return this.#flushExpired(this.#retention, this.#cold);
  }

  #deleteExpired(retention: LogRetention): number {
    let removed = 0;
    for (;;) {
      const oldest = listOldest(
        this.#engine.sql,
        this.#channel,
        this.#maxBatchSize
      );
      const expiring = this.#expiring(retention, oldest);
      if (expiring.length === 0) {
        return removed;
      }
      const last = expiring[expiring.length - 1]!;
      const deleted = this.#engine.transactionSync((sql) =>
        trimThrough(sql, this.#channel, last.offset + 1, expiring.length)
      );
      removed += deleted;
      if (deleted < expiring.length) {
        return removed;
      }
    }
  }

  /**
   * Each flush records its range before the cold write, then indexes the
   * segment, deletes the records, and clears the range in one transaction. A
   * retried write for a first offset therefore carries the same records,
   * whether the earlier write failed, lost its response, or the object
   * restarted, and however many records were appended meanwhile.
   */
  async #flushExpired(
    retention: LogRetention,
    cold: LogColdStorage<Body>
  ): Promise<number> {
    let removed = 0;
    for (;;) {
      const sql = this.#engine.sql;
      const oldest = listOldest(sql, this.#channel, this.#maxBatchSize);
      if (oldest.length === 0) {
        return removed;
      }
      const hotOffset = oldest[0]!.offset;

      const flushed = findSegment(sql, this.#channel, hotOffset);
      if (flushed) {
        // Earlier versions indexed a segment outside the transaction that
        // deleted its records, so a crash in between left both. The records
        // are readable from cold storage; only the deletion is left.
        removed += this.#engine.transactionSync((transaction) =>
          trimThrough(
            transaction,
            this.#channel,
            flushed.last_offset + 1,
            flushed.last_offset - hotOffset + 1
          )
        );
        continue;
      }

      const pending = readPendingFlush(sql, this.#channel);
      // A pending range that no longer starts at the oldest record lost its
      // records to a trim while cold storage was not configured.
      let flush = pending?.first_offset === hotOffset ? pending : undefined;
      if (!flush) {
        const expiring = this.#expiring(retention, oldest);
        if (expiring.length === 0) {
          return removed;
        }
        flush = {
          first_offset: hotOffset,
          last_offset: expiring[expiring.length - 1]!.offset,
        };
        setPendingFlush(sql, this.#channel, flush);
      }
      const count = flush.last_offset - flush.first_offset + 1;
      const rows = readRecords(sql, this.#channel, flush.first_offset, count);

      // eslint-disable-next-line no-await-in-loop
      const locator = await cold.write({
        channel: this.#channel,
        firstOffset: flush.first_offset,
        lastOffset: flush.last_offset,
        records: rows.map((row) => this.#record(row)),
      });
      if (typeof locator !== 'string' || locator.length === 0) {
        throw new TypeError('Cold storage must return a non-empty locator');
      }

      const deleted = this.#engine.transactionSync((transaction) => {
        const current = readPendingFlush(transaction, this.#channel);
        const finishedByAnotherTrim =
          current === undefined ||
          current.first_offset !== flush.first_offset ||
          current.last_offset !== flush.last_offset;
        // The overlapping call continues past this range, so this one stops.
        if (finishedByAnotherTrim) {
          return 0;
        }
        insertSegment(transaction, this.#channel, {
          first_offset: flush.first_offset,
          last_offset: flush.last_offset,
          locator,
          bytes: rows.reduce((total, row) => total + row.bytes, 0),
          flushed_at: Date.now(),
        });
        transaction.exec(
          'DELETE FROM durability_log_pending_flushes WHERE channel = ?',
          this.#channel
        );
        return trimThrough(
          transaction,
          this.#channel,
          flush.last_offset + 1,
          count
        );
      });
      removed += deleted;
      if (deleted < count) {
        return removed;
      }
    }
  }

  /** The oldest records retention expires now, in offset order. */
  #expiring(
    retention: LogRetention,
    oldest: readonly LogRecordRow[]
  ): LogRecordRow[] {
    const { maxAgeMs, maxRecords, maxBytes } = retention;
    const cutoff = maxAgeMs === undefined ? undefined : Date.now() - maxAgeMs;
    const excess =
      maxRecords === undefined
        ? 0
        : Math.max(
            0,
            countRecords(this.#engine.sql, this.#channel) - maxRecords
          );
    const heldBytes =
      maxBytes === undefined ? 0 : totalBytes(this.#engine.sql, this.#channel);
    let overBytes = Math.max(0, heldBytes - (maxBytes ?? 0));
    return takeWhile(oldest, (row, index) => {
      const reclaiming = overBytes > 0;
      overBytes -= row.bytes;
      return (
        index < excess ||
        reclaiming ||
        (cutoff !== undefined && row.appended_at < cutoff)
      );
    });
  }

  /**
   * Forgets flushed segments below an offset, matching whatever lifecycle rule
   * expires them externally. Reads below the new floor then truncate.
   */
  async forgetColdBefore(offset: number): Promise<number> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new LogAppendError('Offset must be a non-negative integer');
    }
    return this.#engine.sql
      .exec(
        `DELETE FROM durability_log_segments
         WHERE channel = ? AND last_offset < ?
         RETURNING first_offset`,
        this.#channel,
        offset
      )
      .toArray().length;
  }

  /**
   * Claims the next unleased range for a consumer, or redelivers one whose
   * holder nacked or let its lease expire. Returns undefined when nothing is
   * available, either because the consumer is at `maxParallelism` or because
   * the log has no unleased records.
   *
   * Two workers sharing a consumer name never receive the same offsets: the
   * range is recorded durably before the records are returned, and a
   * redelivery rewrites the batch id so the previous holder can no longer
   * settle it.
   */
  async lease(
    consumer: string,
    limit?: number
  ): Promise<LogLease<Body> | undefined> {
    const leases = this.#requireLeases();
    const size = Math.min(limit ?? this.#maxBatchSize, this.#maxBatchSize);
    assertPositiveInteger('limit', size);
    assertConsumer(consumer);
    const sql = this.#engine.sql;

    // A claim fails only when another call took the next range or a free slot
    // during the read, so after maxParallelism failures the consumer is full
    // unless a range settled meanwhile, and undefined is the same back-off
    // signal either way.
    for (let attempt = 0; attempt <= this.#maxParallelism; attempt += 1) {
      const now = Date.now();
      const reclaimed = claimExpired(
        sql,
        this.#channel,
        consumer,
        now,
        crypto.randomUUID(),
        now + this.#leaseMs
      );
      if (reclaimed) {
        return this.#redeliver(leases, consumer, reclaimed);
      }

      if (
        countHeld(sql, this.#channel, consumer, now) >= this.#maxParallelism
      ) {
        return undefined;
      }

      const bounds = readBounds(sql, this.#channel);
      const committed = readCursor(sql, this.#channel, consumer);
      const allocated = readAllocation(sql, this.#channel, consumer);
      const from = Math.max(
        bounds.oldestOffset,
        committed ?? 0,
        allocated ?? 0
      );
      // eslint-disable-next-line no-await-in-loop
      const records = await this.#readFrom(from, size, bounds);
      if (records.length === 0) {
        return undefined;
      }

      const first = records[0]!.offset;
      const last = records[records.length - 1]!.offset;
      const batchId = crypto.randomUUID();
      const expiresAt = now + this.#leaseMs;
      const claimed = this.#engine.transactionSync((transaction) => {
        // The read yields, so another call may have taken these offsets or
        // the last free slot meanwhile.
        const changed =
          readAllocation(transaction, this.#channel, consumer) !== allocated ||
          countHeld(transaction, this.#channel, consumer, now) >=
            this.#maxParallelism;
        if (changed) {
          return false;
        }
        insertLease(transaction, this.#channel, {
          batch_id: batchId,
          consumer,
          first_offset: first,
          last_offset: last,
          state: 'active',
          attempt: 1,
          expires_at: expiresAt,
          created_at: now,
        });
        setAllocation(transaction, this.#channel, consumer, last + 1);
        return true;
      });
      if (claimed) {
        return {
          batchId,
          consumer,
          records,
          firstOffset: first,
          lastOffset: last,
          attempt: 1,
          expiresAt,
        };
      }
    }
    return undefined;
  }

  /**
   * Hands a range back to the consumer after its holder nacked it or let it
   * expire. The claim already rewrote its batch id, so no other call can hold
   * it while the records are read.
   */
  async #redeliver(
    leases: LogLeaseOptions,
    consumer: string,
    reclaimed: LogLeaseRow
  ): Promise<LogLease<Body> | undefined> {
    const { oldestOffset } = readBounds(this.#engine.sql, this.#channel);
    if (reclaimed.first_offset < oldestOffset) {
      this.#dropTrimmed(consumer, reclaimed, oldestOffset);
      throw new LogTruncatedError(reclaimed.first_offset, oldestOffset);
    }
    const poisoned =
      leases.maxAttempts !== undefined &&
      leases.onPoison !== undefined &&
      reclaimed.attempt > leases.maxAttempts;
    const lease = {
      batchId: reclaimed.batch_id,
      consumer,
      records: await this.#between(
        reclaimed.first_offset,
        reclaimed.last_offset
      ),
      firstOffset: reclaimed.first_offset,
      lastOffset: reclaimed.last_offset,
      attempt: reclaimed.attempt,
      expiresAt: reclaimed.expires_at,
    };
    if (!poisoned) {
      return lease;
    }
    // Terminal intent is durable before the callback runs, so a failing
    // handler cannot resurrect a range that already exhausted its attempts.
    // A skipped range counts as settled, so the cursor moves past it as for an ack.
    this.#engine.transactionSync(() => {
      this.#settle(reclaimed.batch_id, 'skipped');
      this.#advance(consumer);
    });
    try {
      await leases.onPoison!(lease as LogLease);
    } catch (error) {
      reportFailure(
        'durability.log.poison_handler.failed',
        { channel: this.#channel, consumer },
        error
      );
    }
    return undefined;
  }

  /**
   * Accepts a leased range and advances the cursor over every settled range
   * that forms an unbroken run from it, so parallel consumers commit without
   * skipping offsets another worker is still holding.
   */
  async ack(consumer: string, batchId: string): Promise<void> {
    this.#requireLeases();
    this.#engine.transactionSync(() => {
      this.#settle(batchId, 'acked');
      this.#advance(consumer);
    });
  }

  /** Returns a leased range for redelivery under a fresh batch id. */
  async nack(consumer: string, batchId: string): Promise<void> {
    this.#requireLeases();
    this.#settle(batchId, 'pending');
  }

  /** In-flight and settled-but-uncommitted ranges, for operators and tests. */
  async leases(consumer: string): Promise<LogLeaseRow[]> {
    this.#requireLeases();
    return v.parse(
      v.array(logLeaseRowSchema),
      this.#engine.sql
        .exec(
          `SELECT * FROM durability_log_leases
           WHERE channel = ? AND consumer = ?
           ORDER BY first_offset ASC`,
          this.#channel,
          consumer
        )
        .toArray()
    );
  }

  #settle(batchId: string, state: 'acked' | 'pending' | 'skipped'): void {
    // Pending ranges are immediately claimable, so their expiry is in the past.
    const settled = settleLease(
      this.#engine.sql,
      this.#channel,
      batchId,
      state,
      state === 'pending' ? 0 : Date.now()
    );
    if (settled) {
      return;
    }
    // Either the batch never existed, was fenced by a redelivery, or was
    // already settled; all three are the caller holding a stale handle.
    throw new LogLeaseError(batchId);
  }

  /**
   * Retention trimmed some or all of a range before it was redelivered. Those
   * offsets are gone for every consumer, so they leave the range: a range
   * wholly below the window is deleted, one straddling it keeps its retained
   * tail and is pending again. The failed claim is not counted as a
   * delivery attempt.
   */
  #dropTrimmed(
    consumer: string,
    lease: LogLeaseRow,
    oldestOffset: number
  ): void {
    this.#engine.transactionSync((sql) => {
      if (lease.last_offset < oldestOffset) {
        deleteLeases(sql, this.#channel, [lease.batch_id]);
      } else {
        sql.exec(
          `UPDATE durability_log_leases
           SET first_offset = ?, state = 'pending', attempt = attempt - 1,
               expires_at = 0
           WHERE channel = ? AND batch_id = ?`,
          oldestOffset,
          this.#channel,
          lease.batch_id
        );
      }
      this.#advance(consumer);
    });
  }

  /** Commits the unbroken run of settled ranges starting at the cursor. */
  #advance(consumer: string): void {
    const sql = this.#engine.sql;
    // Offsets below the retained window are gone for everyone; a cursor
    // stranded there could never meet the ranges leased after them.
    const from = Math.max(
      readCursor(sql, this.#channel, consumer) ?? 0,
      readBounds(sql, this.#channel).oldestOffset
    );
    let cursor = from;
    const settled: string[] = [];
    // Ranges settled while an earlier one was outstanding wait behind it; when
    // it settles the cursor must pass all of them, however many pages that is.
    for (let page = true; page; ) {
      const candidates = leasesFrom(
        sql,
        this.#channel,
        consumer,
        cursor,
        this.#maxBatchSize
      );
      page = candidates.length === this.#maxBatchSize;
      for (const row of candidates) {
        const contiguous = row.first_offset <= cursor;
        const done = row.state === 'acked' || row.state === 'skipped';
        if (!contiguous || !done) {
          page = false;
          break;
        }
        cursor = Math.max(cursor, row.last_offset + 1);
        settled.push(row.batch_id);
      }
    }
    if (settled.length === 0) {
      return;
    }
    commitCursor(sql, this.#channel, consumer, cursor, Date.now());
    deleteLeases(sql, this.#channel, settled);
  }

  /** Reads a stored range, rehydrating it when retention already flushed it. */
  async #between(first: number, last: number): Promise<LogRecord<Body>[]> {
    const bounds = readBounds(this.#engine.sql, this.#channel);
    // One read stops at the end of a cold segment, and a range redelivered
    // after a flush can span several segments and the hot window.
    const records: LogRecord<Body>[] = [];
    let from = first;
    while (from <= last) {
      // eslint-disable-next-line no-await-in-loop
      const page = await this.#readFrom(from, last - from + 1, bounds);
      const inRange = page.filter((record) => record.offset <= last);
      if (inRange.length === 0) {
        break;
      }
      records.push(...inRange);
      from = inRange[inRange.length - 1]!.offset + 1;
    }
    return records;
  }

  async #readFrom(
    from: number,
    limit: number,
    bounds: LogBounds
  ): Promise<LogRecord<Body>[]> {
    if (from < bounds.hotOffset && from < bounds.nextOffset) {
      return this.#rehydrate(from, limit, bounds);
    }
    return readRecords(this.#engine.sql, this.#channel, from, limit).map(
      (row) => this.#record(row)
    );
  }

  #requireLeases(): LogLeaseOptions {
    if (!this.#leases) {
      throw new TypeError('Leases require the leases option');
    }
    return this.#leases;
  }

  /**
   * Backlog is the furthest-behind committed cursor, so routing can weigh
   * partitions by consumer lag. Without cursors there is no backlog to report.
   */
  async load(): Promise<LoadSnapshot> {
    const bounds = readBounds(this.#engine.sql, this.#channel);
    const slowest = readCursors(this.#engine.sql, this.#channel).reduce<
      number | undefined
    >(
      (lowest, row) =>
        lowest === undefined ? row.offset : Math.min(lowest, row.offset),
      undefined
    );
    return this.#routing.snapshot(
      slowest === undefined ? 0 : Math.max(0, bounds.nextOffset - slowest)
    );
  }
}

traceMethods(DurabilityLog.prototype, 'DurabilityLog');

const assertConsumer = (consumer: string): void => {
  if (typeof consumer !== 'string' || consumer.length === 0) {
    throw new LogAppendError('Consumer must be a non-empty string');
  }
};

const takeWhile = <T>(
  items: readonly T[],
  predicate: (item: T, index: number) => boolean
): T[] => {
  const taken: T[] = [];
  for (const [index, item] of items.entries()) {
    if (!predicate(item, index)) {
      break;
    }
    taken.push(item);
  }
  return taken;
};
