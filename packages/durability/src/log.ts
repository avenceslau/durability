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
  /** Appending the same key twice returns the first offset instead of a second record. */
  key?: string;
};

export type LogRecord<Body = unknown> = {
  offset: number;
  key: string;
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

/** Receives records leaving the retained window, oldest first, before deletion. */
export type LogArchive<Body = unknown> = (
  records: LogRecord<Body>[]
) => Promise<void>;

export type LogRetention = {
  maxAgeMs?: number;
  maxRecords?: number;
};

export type DurabilityLogConfig<Body = unknown> = SchedulerAttachment & {
  /** Without retention the log grows until the object's storage limit. */
  retention?: LogRetention;
  archive?: LogArchive<Body>;
  routing?: RoutingLoad;
  maxBatchSize?: number;
};

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
  readonly #archive: LogArchive<Body> | undefined;
  readonly #maxBatchSize: number;

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
    this.#engine = engineFor(config);
    this.#routing = config.routing ?? new RoutingLoad();
    this.#retention = config.retention;
    this.#archive = config.archive;
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
      let rows: Array<{ key: string; payload: string }>;
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
          if (input.key !== undefined && input.key === '') {
            throw new LogAppendError('Append keys must be non-empty');
          }
          return {
            key: input.key ?? crypto.randomUUID(),
            payload: serialize(input.body),
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

  /** Reads forward from an offset. Consumers own their position; see `cursor`. */
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
    const rows = await this.#engine.storage.log.read(
      options.from,
      Math.min(limit, this.#maxBatchSize)
    );
    const records = rows.map((row) => ({
      offset: row.offset,
      key: row.key,
      body: deserialize(row.payload) as Body,
      appendedAt: row.appended_at,
    }));
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
   * Enforces retention, archiving records before deleting them. An archive
   * failure propagates with the records still retained, so configured cold
   * storage cannot be skipped. Retention ignores cursors: a consumer slower
   * than the window loses records and learns through `LogTruncatedError`.
   */
  async trim(): Promise<number> {
    if (!this.#retention) {
      return 0;
    }
    const { maxAgeMs, maxRecords } = this.#retention;
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
      const expiring = takeWhile(oldest, (row, index) => {
        const overCount = index < excess;
        const tooOld = cutoff !== undefined && row.appended_at < cutoff;
        return overCount || tooOld;
      });
      if (expiring.length === 0) {
        return removed;
      }
      if (this.#archive) {
        // eslint-disable-next-line no-await-in-loop
        await this.#archive(
          expiring.map((row) => ({
            offset: row.offset,
            key: row.key,
            body: deserialize(row.payload) as Body,
            appendedAt: row.appended_at,
          }))
        );
      }
      // eslint-disable-next-line no-await-in-loop
      const deleted = await this.#engine.storage.log.trimThrough(
        expiring[expiring.length - 1]!.offset + 1,
        expiring.length
      );
      removed += deleted;
      // Records are archived before deletion, so stopping on partial progress
      // keeps the next pass from archiving the remainder a second time.
      if (deleted < expiring.length) {
        return removed;
      }
    }
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
