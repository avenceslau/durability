import { LogAppendError, LogTruncatedError, serializeError } from './errors.js';
import { RoutingLoad, type EnqueueResult, type LoadSnapshot } from './load.js';
import { durabilityLogMigrations, migrate } from './migrations.js';
import { assertPositiveInteger } from './policy.js';
import {
  engineFor,
  type Engine,
  type SchedulerAttachment,
} from './scheduler.js';
import { deserialize, serialize } from './serialization.js';
import type { LogBounds } from './storage.js';

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
  /** Without retention the log grows until the object's storage limit. */
  retention?: LogRetention;
  cold?: LogColdStorage<Body>;
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
  readonly #routing: RoutingLoad;
  readonly #retention: LogRetention | undefined;
  readonly #cold: LogColdStorage<Body> | undefined;
  readonly #maxBatchSize: number;
  readonly #encoder = new TextEncoder();

  constructor(config: DurabilityLogConfig<Body>) {
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
    this.#engine = engineFor(config);
    this.#routing = config.routing ?? new RoutingLoad();
    this.#retention = config.retention;
    this.#cold = config.cold;
    this.#engine.migrateSchema('log', durabilityLogMigrations);
  }

  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ) {
    return migrate(context.storage, 'log', durabilityLogMigrations, target);
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

      const offsets = await this.#engine.storage.log.append(rows, Date.now());
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
    const bounds = await this.#engine.storage.log.bounds();
    if (options.from < bounds.oldestOffset) {
      throw new LogTruncatedError(options.from, bounds.oldestOffset);
    }
    const capped = Math.min(limit, this.#maxBatchSize);
    const records =
      options.from < bounds.hotOffset
        ? await this.#rehydrate(options.from, capped, bounds)
        : (await this.#engine.storage.log.read(options.from, capped)).map(
            (row) => this.#record(row)
          );
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
    const segment = await this.#engine.storage.log.findSegment(from);
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

  #record(row: {
    offset: number;
    dedup_key: string;
    payload: string;
    appended_at: number;
  }): LogRecord<Body> {
    return {
      offset: row.offset,
      deduplicationKey: row.dedup_key,
      body: deserialize(row.payload) as Body,
      appendedAt: row.appended_at,
    };
  }

  /** The retained window. `oldestOffset` equals `nextOffset` when empty. */
  bounds(): Promise<LogBounds> {
    return this.#engine.storage.log.bounds();
  }

  /** Undefined until the consumer commits, so callers choose their own start. */
  cursor(consumer: string): Promise<number | undefined> {
    return this.#engine.storage.log.cursor(consumer);
  }

  /** Records progress. Regressions are ignored, so a late commit cannot rewind. */
  commit(consumer: string, offset: number): Promise<void> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new LogAppendError('Commit offset must be a non-negative integer');
    }
    return this.#engine.storage.log.commit(consumer, offset, Date.now());
  }

  async cursors(): Promise<Record<string, number>> {
    const rows = await this.#engine.storage.log.cursors();
    return Object.fromEntries(rows.map((row) => [row.consumer, row.offset]));
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
    const { maxAgeMs, maxRecords, maxBytes } = this.#retention;
    const cutoff = maxAgeMs === undefined ? undefined : Date.now() - maxAgeMs;
    let removed = 0;
    for (;;) {
      // Each pass depends on the previous deletion, so it cannot be parallel.
      // eslint-disable-next-line no-await-in-loop
      const oldest = await this.#engine.storage.log.listOldest(
        this.#maxBatchSize
      );
      if (oldest.length === 0) {
        return removed;
      }
      const excess =
        maxRecords === undefined
          ? 0
          : // eslint-disable-next-line no-await-in-loop
            Math.max(0, (await this.#engine.storage.log.count()) - maxRecords);
      const heldBytes =
        maxBytes === undefined
          ? 0
          : // eslint-disable-next-line no-await-in-loop
            await this.#engine.storage.log.totalBytes();
      let overBytes = Math.max(0, heldBytes - (maxBytes ?? 0));
      const expiring = takeWhile(oldest, (row, index) => {
        const reclaiming = overBytes > 0;
        overBytes -= row.bytes;
        return (
          index < excess ||
          reclaiming ||
          (cutoff !== undefined && row.appended_at < cutoff)
        );
      });
      if (expiring.length === 0) {
        return removed;
      }
      const first = expiring[0]!;
      const last = expiring[expiring.length - 1]!;
      if (this.#cold) {
        const records = expiring.map((row) => this.#record(row));
        // eslint-disable-next-line no-await-in-loop
        const locator = await this.#cold.write({
          firstOffset: first.offset,
          lastOffset: last.offset,
          records,
        });
        if (typeof locator !== 'string' || locator.length === 0) {
          throw new TypeError('Cold storage must return a non-empty locator');
        }
        // Indexed before deletion: a crash in between leaves the segment
        // written and readable, never records that point nowhere.
        // eslint-disable-next-line no-await-in-loop
        await this.#engine.storage.log.insertSegment({
          first_offset: first.offset,
          last_offset: last.offset,
          locator,
          bytes: expiring.reduce((total, row) => total + row.bytes, 0),
          flushed_at: Date.now(),
        });
      }
      // eslint-disable-next-line no-await-in-loop
      const deleted = await this.#engine.storage.log.trimThrough(
        last.offset + 1,
        expiring.length
      );
      removed += deleted;
      // Records are flushed before deletion, so stopping on partial progress
      // keeps the next pass from writing the remainder a second time.
      if (deleted < expiring.length) {
        return removed;
      }
    }
  }

  /**
   * Forgets flushed segments below an offset, matching whatever lifecycle rule
   * expires them externally. Reads below the new floor then truncate.
   */
  forgetColdBefore(offset: number): Promise<number> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new LogAppendError('Offset must be a non-negative integer');
    }
    return this.#engine.storage.log.deleteSegmentsBefore(offset);
  }

  /**
   * Backlog is the furthest-behind committed cursor, so routing can weigh
   * partitions by consumer lag. Without cursors there is no backlog to report.
   */
  async load(): Promise<LoadSnapshot> {
    const [bounds, cursors] = await Promise.all([
      this.#engine.storage.log.bounds(),
      this.#engine.storage.log.cursors(),
    ]);
    const slowest = cursors.reduce<number | undefined>(
      (lowest, row) =>
        lowest === undefined ? row.offset : Math.min(lowest, row.offset),
      undefined
    );
    return this.#routing.snapshot(
      slowest === undefined ? 0 : Math.max(0, bounds.nextOffset - slowest)
    );
  }
}

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
