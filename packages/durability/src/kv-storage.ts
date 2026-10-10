import { z } from 'zod';
import {
  alarmRowSchema,
  callRowSchema,
  deliveryRowSchema,
  fanoutMessageRowSchema,
  logCursorRowSchema,
  logRecordRowSchema,
  logSegmentRowSchema,
  logLeaseRowSchema,
  type AlarmRow,
  type CallRow,
  type DeliveryRow,
  type DeliveryStore,
  type DurabilityStorage,
  type DurabilityStorageTransaction,
  type DurableRecord,
  type FanoutMessageRow,
  type LogBounds,
  type LogCursorRow,
  type LogRecordRow,
  type LogSegmentRow,
  type LogLeaseRow,
  type LogLeaseState,
  type LogStore,
  type RecordPatch,
  type RecordStore,
} from './storage.js';

type KvStorage = Pick<
  DurableObjectTransaction,
  'get' | 'list' | 'put' | 'delete' | 'getAlarm' | 'setAlarm' | 'deleteAlarm'
>;

type TableSpec<Row extends DurableRecord> = {
  name: string;
  keyOf: (row: Row) => string;
  schema: z.ZodType<Row>;
};

const callTable: TableSpec<CallRow> = {
  name: 'call',
  keyOf: (row) => row.id,
  schema: callRowSchema,
};

const alarmTable: TableSpec<AlarmRow> = {
  name: 'alarm',
  keyOf: (row) => row.name,
  schema: alarmRowSchema,
};

const deliveryTable: TableSpec<DeliveryRow> = {
  name: 'fanout-delivery',
  keyOf: (row) => row.id,
  schema: deliveryRowSchema,
};

const keyPrefix = '__durability:kv:v1:';
const timestampWidth = 16;
const timestampKey = (timestamp: number): string =>
  timestamp.toString().padStart(timestampWidth, '0');
const indexTimestampSchema = z
  .string()
  .regex(/^\d{16}$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const keySchema = z.string().array();
const counterSchema = z.number().int().nonnegative().optional();

/** Deleting more keys than this in one KV call exceeds the Durable Object limit. */
const purgeBatchSize = 20;

const logRecordPrefix = `${keyPrefix}log-record:`;
const logKeyIndexPrefix = `${keyPrefix}log-key:`;
const logCursorPrefix = `${keyPrefix}log-cursor:`;
const logSegmentPrefix = `${keyPrefix}log-segment:`;
const logSegmentIndexKey = `${keyPrefix}log-segment-index`;
const logNextOffsetKey = `${keyPrefix}log-next-offset`;
const logTotalBytesKey = `${keyPrefix}log-total-bytes`;
const logAllocationPrefix = `${keyPrefix}log-allocation:`;
const logLeasePrefix = `${keyPrefix}log-lease:`;
const logLeaseIndexPrefix = `${keyPrefix}log-lease-index:`;

/**
 * Segment bounds live in one index value so a lookup or expiry scan never
 * batch-reads segment rows, which would exceed the KV multi-get limit.
 */
const logSegmentIndexSchema = z
  .object({
    first: z.number().int().nonnegative(),
    last: z.number().int().nonnegative(),
  })
  .array();

const encodeIndexPart = (value: string): string => encodeURIComponent(value);

const deliveryAttemptClass = (row: DeliveryRow): number =>
  row.attempt === 0 ? 0 : 1;

type Atomically<Row extends DurableRecord> = <T>(
  callback: (table: KvTable<Row>) => Promise<T>
) => Promise<T>;

type LogAtomically = <T>(
  callback: (table: KvLogTable) => Promise<T>
) => Promise<T>;

/**
 * One record kind stored as a primary row plus two ordered index keys:
 * `pending-<name>:<next_attempt_at>:<key>` for due work and
 * `created-<name>:<created_at>:<key>` for retention purges.
 */
class KvTable<Row extends DurableRecord> implements RecordStore<Row> {
  protected readonly rowPrefix: string;
  protected readonly pendingPrefix: string;
  protected readonly createdPrefix: string;

  constructor(
    protected readonly kv: KvStorage,
    private readonly spec: TableSpec<Row>,
    protected readonly atomically: Atomically<Row>
  ) {
    this.rowPrefix = `${keyPrefix}${spec.name}:`;
    this.pendingPrefix = `${keyPrefix}pending-${spec.name}:`;
    this.createdPrefix = `${keyPrefix}created-${spec.name}:`;
  }

  async get(key: string): Promise<Row | undefined> {
    return this.spec.schema
      .optional()
      .parse(await this.kv.get(this.rowKey(key)));
  }

  async listDue(now: number, limit: number): Promise<Row[]> {
    const index = await this.kv.list({
      prefix: this.pendingPrefix,
      end: `${this.pendingPrefix}${timestampKey(now)};`,
      limit,
    });
    return this.rows(keySchema.parse([...index.values()]));
  }

  async nextPendingAt(): Promise<number | undefined> {
    const index = await this.kv.list({ prefix: this.pendingPrefix, limit: 1 });
    const first = index.keys().next().value;
    if (typeof first !== 'string') {
      return undefined;
    }
    return indexTimestampSchema.parse(
      first.slice(
        this.pendingPrefix.length,
        this.pendingPrefix.length + timestampWidth
      )
    );
  }

  insert(row: Row): Promise<boolean> {
    return this.atomically(async (table) => {
      if ((await table.get(this.spec.keyOf(row))) !== undefined) {
        return false;
      }
      await table.write(undefined, row);
      return true;
    });
  }

  upsert(row: Row): Promise<void> {
    return this.atomically(async (table) => {
      await table.write(await table.get(this.spec.keyOf(row)), row);
    });
  }

  claimAttempt(
    key: string,
    generation: string,
    maxAttempts: number
  ): Promise<number | undefined> {
    return this.atomically(async (table) => {
      const row = await table.pending(key, generation);
      if (!row || row.attempt >= maxAttempts) {
        return undefined;
      }
      const attempt = row.attempt + 1;
      await table.write(row, { ...row, attempt });
      return attempt;
    });
  }

  settle(
    key: string,
    generation: string,
    attempt: number,
    patch: RecordPatch<Row>
  ): Promise<boolean> {
    return this.atomically(async (table) => {
      const row = await table.pending(key, generation);
      if (!row || row.attempt !== attempt) {
        return false;
      }
      await table.write(row, { ...row, ...patch });
      return true;
    });
  }

  exhaust(
    key: string,
    generation: string,
    maxAttempts: number,
    patch: RecordPatch<Row>
  ): Promise<boolean> {
    return this.atomically(async (table) => {
      const row = await table.pending(key, generation);
      if (!row || row.attempt < maxAttempts) {
        return false;
      }
      await table.write(row, { ...row, ...patch });
      return true;
    });
  }

  remove(key: string, generation: string, attempt: number): Promise<boolean> {
    return this.atomically(async (table) => {
      const row = await table.pending(key, generation);
      if (!row || row.attempt !== attempt) {
        return false;
      }
      await table.kv.delete([table.rowKey(key), ...table.indexKeys(row)]);
      return true;
    });
  }

  /** Deletes one bounded batch so a purge never exceeds the KV delete limit. */
  async deleteCreatedBefore(before: number): Promise<number> {
    const index = await this.kv.list({
      prefix: this.createdPrefix,
      end: `${this.createdPrefix}${timestampKey(before)}:`,
      limit: purgeBatchSize,
    });
    const rows = await this.rows(keySchema.parse([...index.values()]));
    if (rows.length === 0) {
      return 0;
    }
    await this.kv.delete(
      rows.flatMap((row) => [
        this.rowKey(this.spec.keyOf(row)),
        ...this.indexKeys(row),
      ])
    );
    return rows.length;
  }

  private async pending(
    key: string,
    generation: string
  ): Promise<Row | undefined> {
    const row = await this.get(key);
    if (row?.generation_id !== generation || row.status !== 'pending') {
      return undefined;
    }
    return row;
  }

  protected async rows(keys: string[]): Promise<Row[]> {
    if (keys.length === 0) {
      return [];
    }
    const found = await this.kv.get<unknown>(
      keys.map((key) => this.rowKey(key))
    );
    // The batch result is keyed, not ordered; keep the index order.
    return this.spec.schema
      .array()
      .parse(keys.map((key) => found.get(this.rowKey(key))));
  }

  protected async write(previous: Row | undefined, next: Row): Promise<void> {
    const key = this.spec.keyOf(next);
    const previousIndexes = previous ? this.indexKeys(previous) : [];
    const nextIndexes = this.indexKeys(next);

    const stale = previousIndexes.filter(
      (index) => !nextIndexes.includes(index)
    );
    if (stale.length > 0) {
      await this.kv.delete(stale);
    }

    const entries: Record<string, Row | string> = { [this.rowKey(key)]: next };
    for (const index of nextIndexes) {
      if (!previousIndexes.includes(index)) {
        entries[index] = key;
      }
    }
    await this.kv.put(entries);
  }

  protected rowKey(key: string): string {
    return `${this.rowPrefix}${key}`;
  }

  protected indexKeys(row: Row): string[] {
    const key = this.spec.keyOf(row);
    const created = `${this.createdPrefix}${timestampKey(row.created_at)}:${key}`;
    if (row.status !== 'pending') {
      return [created];
    }
    return [
      created,
      `${this.pendingPrefix}${timestampKey(row.next_attempt_at)}:${key}`,
    ];
  }
}

const fanoutMessagePrefix = `${keyPrefix}fanout-message:`;
const fanoutSeqCounterKey = `${keyPrefix}fanout-seq`;
const fanoutPendingCounterKey = `${keyPrefix}fanout-pending-count`;
const fanoutTargetPrefix = `${keyPrefix}fanout-target:`;
const fanoutTargetIndexPrefix = `${keyPrefix}fanout-target-index:`;
const fanoutTargetPendingPrefix = `${keyPrefix}pending-fanout-target:`;

class KvDeliveryTable extends KvTable<DeliveryRow> implements DeliveryStore {
  private readonly globalPendingPrefix: string;

  constructor(kv: KvStorage, atomically: Atomically<DeliveryRow>) {
    super(kv, deliveryTable, atomically);
    this.globalPendingPrefix = this.pendingPrefix;
  }

  nextSeq(): Promise<number> {
    return this.atomically(async (raw) => {
      const table = raw as KvDeliveryTable;
      const seq =
        counterSchema.parse(await table.kv.get(fanoutSeqCounterKey)) ?? 0;
      if (!Number.isSafeInteger(seq + 1)) {
        throw new RangeError('Fanout sequence exhausted');
      }
      await table.kv.put(fanoutSeqCounterKey, seq + 1);
      return seq;
    });
  }

  protected override indexKeys(row: DeliveryRow): string[] {
    const created = `${this.createdPrefix}${timestampKey(row.created_at)}:${row.id}`;
    const attemptClass = deliveryAttemptClass(row);
    const sequence = timestampKey(row.seq);
    const target = encodeIndexPart(row.target_id);
    const id = encodeIndexPart(row.id);
    return [
      created,
      `${this.globalPendingPrefix}${attemptClass}:${timestampKey(row.next_attempt_at)}:${sequence}:${target}:${id}`,
      `${fanoutTargetPendingPrefix}${target}:${attemptClass}:${timestampKey(row.next_attempt_at)}:${sequence}:${id}`,
    ];
  }

  async getMessage(key: string): Promise<FanoutMessageRow | undefined> {
    return fanoutMessageRowSchema
      .optional()
      .parse(await this.kv.get(this.messageKey(key)));
  }

  insertMessage(row: FanoutMessageRow): Promise<boolean> {
    return this.atomically(async (raw) => {
      const table = raw as KvDeliveryTable;
      if ((await table.getMessage(row.key)) !== undefined) {
        return false;
      }
      await table.kv.put(table.messageKey(row.key), row);
      return true;
    });
  }

  async listTargets(): Promise<string[]> {
    const targets: string[] = [];
    let startAfter: string | undefined;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const page = await this.kv.list<string>({
        prefix: fanoutTargetIndexPrefix,
        limit: 128,
        ...(startAfter === undefined ? {} : { startAfter }),
      });
      targets.push(...page.values());
      if (page.size < 128) {
        return targets;
      }
      startAfter = [...page.keys()][page.size - 1];
    }
  }

  async listDueForTarget(
    target: string,
    now: number,
    limit: number
  ): Promise<DeliveryRow[]> {
    const firstPrefix = `${fanoutTargetPendingPrefix}${encodeIndexPart(target)}:0:`;
    const first = await this.dueIndex(firstPrefix, now, limit);
    if (first.length >= limit) {
      return first;
    }

    const retryPrefix = `${fanoutTargetPendingPrefix}${encodeIndexPart(target)}:1:`;
    const retries = await this.dueIndex(retryPrefix, now, limit - first.length);
    return [...first, ...retries];
  }

  async pendingCount(): Promise<number> {
    return counterSchema.parse(await this.kv.get(fanoutPendingCounterKey)) ?? 0;
  }

  override async listDue(now: number, limit: number): Promise<DeliveryRow[]> {
    const firstPrefix = `${this.globalPendingPrefix}0:`;
    const first = await this.dueIndex(firstPrefix, now, limit);
    if (first.length >= limit) {
      return first;
    }

    const retryPrefix = `${this.globalPendingPrefix}1:`;
    const retries = await this.dueIndex(retryPrefix, now, limit - first.length);
    return [...first, ...retries];
  }

  override async nextPendingAt(): Promise<number | undefined> {
    const values = await Promise.all(
      [0, 1].map(async (attemptClass) => {
        const prefix = `${this.globalPendingPrefix}${attemptClass}:`;
        const index = await this.kv.list({ prefix, limit: 1 });
        const first = index.keys().next().value;
        if (typeof first !== 'string') {
          return undefined;
        }
        const offset = prefix.length;
        return indexTimestampSchema.parse(
          first.slice(offset, offset + timestampWidth)
        );
      })
    );
    const pending = values.filter(
      (value): value is number => value !== undefined
    );
    return pending.length === 0 ? undefined : Math.min(...pending);
  }

  override remove(
    key: string,
    generation: string,
    attempt: number
  ): Promise<boolean> {
    return this.atomically(async (raw) => {
      const table = raw as KvDeliveryTable;
      const row = await table.get(key);
      if (
        row?.generation_id !== generation ||
        row.status !== 'pending' ||
        row.attempt !== attempt
      ) {
        return false;
      }
      await table.kv.delete([table.rowKey(key), ...table.indexKeys(row)]);
      await table.adjustTargetCount(row.target_id, -1);
      await table.adjustPendingCount(-1);
      await table.decrementManifest(row.message_key);
      return true;
    });
  }

  override deleteCreatedBefore(before: number): Promise<number> {
    return this.atomically(async (raw) => {
      const table = raw as KvDeliveryTable;
      const index = await table.kv.list({
        prefix: table.createdPrefix,
        end: `${table.createdPrefix}${timestampKey(before)}:`,
        limit: purgeBatchSize,
      });
      const rows = await table.rows(keySchema.parse([...index.values()]));
      for (const row of rows) {
        // Already the transaction's table; remove cannot nest a transaction.
        // eslint-disable-next-line no-await-in-loop
        await table.remove(row.id, row.generation_id, row.attempt);
      }
      return rows.length;
    });
  }

  protected override async write(
    previous: DeliveryRow | undefined,
    next: DeliveryRow
  ): Promise<void> {
    await super.write(previous, next);
    if (previous === undefined) {
      await this.adjustTargetCount(next.target_id, 1);
      await this.adjustPendingCount(1);
      return;
    }

    if (previous.target_id !== next.target_id) {
      await this.adjustTargetCount(previous.target_id, -1);
      await this.adjustTargetCount(next.target_id, 1);
    }
  }

  private async dueIndex(
    prefix: string,
    now: number,
    limit: number
  ): Promise<DeliveryRow[]> {
    if (limit <= 0) {
      return [];
    }

    const rows: DeliveryRow[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const pageSize = Math.min(128, limit - rows.length);
      // eslint-disable-next-line no-await-in-loop
      const index = await this.kv.list({
        prefix,
        end: `${prefix}${timestampKey(now)};`,
        limit: pageSize,
        ...(startAfter === undefined ? {} : { startAfter }),
      });
      // eslint-disable-next-line no-await-in-loop
      rows.push(...(await this.rows(keySchema.parse([...index.values()]))));
      if (index.size < pageSize || rows.length >= limit) {
        return rows.sort((left, right) => left.seq - right.seq);
      }
      startAfter = [...index.keys()][index.size - 1];
    }
  }

  private messageKey(key: string): string {
    return `${fanoutMessagePrefix}${key}`;
  }

  private targetCountKey(target: string): string {
    return `${fanoutTargetPrefix}${encodeIndexPart(target)}`;
  }

  private targetIndexKey(target: string): string {
    return `${fanoutTargetIndexPrefix}${encodeIndexPart(target)}`;
  }

  private async adjustTargetCount(
    target: string,
    delta: number
  ): Promise<void> {
    const count =
      counterSchema.parse(await this.kv.get(this.targetCountKey(target))) ?? 0;
    const next = count + delta;
    if (next <= 0) {
      await this.kv.delete([
        this.targetCountKey(target),
        this.targetIndexKey(target),
      ]);
      return;
    }
    await this.kv.put({
      [this.targetCountKey(target)]: next,
      [this.targetIndexKey(target)]: target,
    });
  }

  private async adjustPendingCount(delta: number): Promise<void> {
    const count =
      counterSchema.parse(await this.kv.get(fanoutPendingCounterKey)) ?? 0;
    await this.kv.put(fanoutPendingCounterKey, count + delta);
  }

  private async decrementManifest(
    messageKey: string,
    amount = 1
  ): Promise<void> {
    const manifest = fanoutMessageRowSchema
      .optional()
      .parse(await this.kv.get(this.messageKey(messageKey)));
    if (manifest === undefined || manifest.remaining <= amount) {
      await this.kv.delete(this.messageKey(messageKey));
      return;
    }
    await this.kv.put(this.messageKey(messageKey), {
      ...manifest,
      remaining: manifest.remaining - amount,
    });
  }
}

class KvLogTable implements LogStore {
  constructor(
    private readonly kv: KvStorage,
    private readonly atomically: LogAtomically
  ) {}

  async append(
    records: readonly Pick<LogRecordRow, 'dedup_key' | 'payload' | 'bytes'>[],
    appendedAt: number
  ): Promise<number[]> {
    if (records.length === 0) {
      return [];
    }

    return this.atomically(async (table) => {
      const payloads = new Map(
        records.map((record) => [record.dedup_key, record])
      );
      const keys = [...payloads.keys()];
      const indexes = await table.kv.get<unknown>(
        keys.map((key) => table.keyIndex(key))
      );
      const assigned = new Map<string, number>();
      for (const key of keys) {
        const offset = counterSchema.parse(indexes.get(table.keyIndex(key)));
        if (offset !== undefined) {
          assigned.set(key, offset);
        }
      }

      const fresh = keys.filter((key) => !assigned.has(key));
      if (fresh.length > 0) {
        const first =
          counterSchema.parse(await table.kv.get(logNextOffsetKey)) ?? 0;
        const next = first + fresh.length;
        if (!Number.isSafeInteger(next)) {
          throw new RangeError('Log offset exhausted');
        }
        const added = fresh.reduce(
          (total, key) => total + payloads.get(key)!.bytes,
          0
        );
        const total =
          counterSchema.parse(await table.kv.get(logTotalBytesKey)) ?? 0;

        const entries: Record<string, unknown> = {
          [logNextOffsetKey]: next,
          [logTotalBytesKey]: total + added,
        };
        fresh.forEach((key, index) => {
          const offset = first + index;
          assigned.set(key, offset);
          const record = payloads.get(key)!;
          entries[table.recordKey(offset)] = {
            offset,
            dedup_key: key,
            payload: record.payload,
            bytes: record.bytes,
            appended_at: appendedAt,
          };
          entries[table.keyIndex(key)] = offset;
        });
        await table.kv.put(entries);
      }

      return records.map(({ dedup_key }) => assigned.get(dedup_key)!);
    });
  }

  async read(from: number, limit: number): Promise<LogRecordRow[]> {
    if (limit <= 0) {
      return [];
    }
    const index = await this.kv.list({
      prefix: logRecordPrefix,
      start: this.recordKey(from),
      limit,
    });
    return logRecordRowSchema.array().parse([...index.values()]);
  }

  async bounds(): Promise<LogBounds> {
    const nextOffset =
      counterSchema.parse(await this.kv.get(logNextOffsetKey)) ?? 0;
    const hotIndex = await this.kv.list({
      prefix: logRecordPrefix,
      limit: 1,
    });
    const first = hotIndex.keys().next().value;
    const hotOffset =
      typeof first === 'string'
        ? indexTimestampSchema.parse(
            first.slice(
              logRecordPrefix.length,
              logRecordPrefix.length + timestampWidth
            )
          )
        : nextOffset;
    const segmentIndex =
      logSegmentIndexSchema
        .optional()
        .parse(await this.kv.get(logSegmentIndexKey)) ?? [];
    const coldOffset = segmentIndex[0]?.first;

    return {
      oldestOffset: Math.min(coldOffset ?? hotOffset, hotOffset),
      hotOffset,
      nextOffset,
    };
  }

  async count(): Promise<number> {
    let count = 0;
    let startAfter: string | undefined;
    for (;;) {
      // Each page starts after the previous one, so it cannot be parallel.
      // eslint-disable-next-line no-await-in-loop
      const page = await this.kv.list({
        prefix: logRecordPrefix,
        limit: 128,
        ...(startAfter === undefined ? {} : { startAfter }),
      });
      count += page.size;
      if (page.size < 128) {
        return count;
      }
      startAfter = [...page.keys()][page.size - 1];
    }
  }

  async totalBytes(): Promise<number> {
    return counterSchema.parse(await this.kv.get(logTotalBytesKey)) ?? 0;
  }

  async listOldest(limit: number): Promise<LogRecordRow[]> {
    if (limit <= 0) {
      return [];
    }
    const index = await this.kv.list({ prefix: logRecordPrefix, limit });
    return logRecordRowSchema.array().parse([...index.values()]);
  }

  async trimThrough(through: number, limit: number): Promise<number> {
    if (limit <= 0) {
      return 0;
    }
    return this.atomically(async (table) => {
      const index = await table.kv.list({
        prefix: logRecordPrefix,
        end: table.recordKey(through),
        limit,
      });
      const rows = logRecordRowSchema.array().parse([...index.values()]);
      if (rows.length === 0) {
        return 0;
      }

      const primaryKeys = [...index.keys()];
      const doomed = rows.flatMap((row, position) => [
        primaryKeys[position]!,
        table.keyIndex(row.dedup_key),
      ]);
      for (let start = 0; start < doomed.length; start += purgeBatchSize) {
        // eslint-disable-next-line no-await-in-loop
        await table.kv.delete(doomed.slice(start, start + purgeBatchSize));
      }
      const total =
        counterSchema.parse(await table.kv.get(logTotalBytesKey)) ?? 0;
      const removedBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
      await table.kv.put(logTotalBytesKey, Math.max(0, total - removedBytes));
      return rows.length;
    });
  }

  async insertSegment(row: LogSegmentRow): Promise<void> {
    await this.atomically(async (table) => {
      const current =
        logSegmentIndexSchema
          .optional()
          .parse(await table.kv.get(logSegmentIndexKey)) ?? [];
      const entry = { first: row.first_offset, last: row.last_offset };
      const next = [
        ...current.filter(({ first }) => first !== row.first_offset),
        entry,
      ].sort((left, right) => left.first - right.first);
      await table.kv.put({
        [table.segmentKey(row.first_offset)]: row,
        [logSegmentIndexKey]: next,
      });
    });
  }

  async findSegment(offset: number): Promise<LogSegmentRow | undefined> {
    const segments =
      logSegmentIndexSchema
        .optional()
        .parse(await this.kv.get(logSegmentIndexKey)) ?? [];
    let low = 0;
    let high = segments.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (segments[middle]!.first <= offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const candidate = segments[low - 1];
    if (candidate === undefined || candidate.last < offset) {
      return undefined;
    }
    return logSegmentRowSchema
      .optional()
      .parse(await this.kv.get(this.segmentKey(candidate.first)));
  }

  async deleteSegmentsBefore(offset: number): Promise<number> {
    return this.atomically(async (table) => {
      const segments =
        logSegmentIndexSchema
          .optional()
          .parse(await table.kv.get(logSegmentIndexKey)) ?? [];
      const doomed = segments.filter(({ last }) => last < offset);
      if (doomed.length === 0) {
        return 0;
      }

      const doomedKeys = doomed.map(({ first }) => table.segmentKey(first));
      for (let start = 0; start < doomedKeys.length; start += purgeBatchSize) {
        // eslint-disable-next-line no-await-in-loop
        await table.kv.delete(doomedKeys.slice(start, start + purgeBatchSize));
      }
      await table.kv.put(
        logSegmentIndexKey,
        segments.filter(({ last }) => last >= offset)
      );
      return doomed.length;
    });
  }

  async cursor(consumer: string): Promise<number | undefined> {
    return logCursorRowSchema
      .optional()
      .parse(await this.kv.get(this.cursorKey(consumer)))?.offset;
  }

  async commit(
    consumer: string,
    offset: number,
    committedAt: number
  ): Promise<void> {
    await this.atomically(async (table) => {
      const key = table.cursorKey(consumer);
      const current = logCursorRowSchema
        .optional()
        .parse(await table.kv.get(key));
      if (current !== undefined && offset <= current.offset) {
        return;
      }
      await table.kv.put(key, {
        consumer,
        offset,
        committed_at: committedAt,
      });
    });
  }

  async cursors(): Promise<LogCursorRow[]> {
    const rows: LogCursorRow[] = [];
    let startAfter: string | undefined;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const page = await this.kv.list({
        prefix: logCursorPrefix,
        limit: 128,
        ...(startAfter === undefined ? {} : { startAfter }),
      });
      rows.push(...logCursorRowSchema.array().parse([...page.values()]));
      if (page.size < 128) {
        return rows.sort((left, right) =>
          left.consumer < right.consumer
            ? -1
            : left.consumer > right.consumer
              ? 1
              : 0
        );
      }
      startAfter = [...page.keys()][page.size - 1];
    }
  }

  async allocation(consumer: string): Promise<number | undefined> {
    return counterSchema.parse(await this.kv.get(this.allocationKey(consumer)));
  }

  async setAllocation(consumer: string, offset: number): Promise<void> {
    await this.kv.put(this.allocationKey(consumer), offset);
  }

  async insertLease(row: LogLeaseRow): Promise<void> {
    await this.atomically(async (table) => {
      if ((await table.getLease(row.batch_id)) !== undefined) {
        throw new Error(`Lease already exists: ${row.batch_id}`);
      }
      await table.kv.put({
        [table.leaseKey(row.batch_id)]: row,
        [table.leaseIndexKey(row)]: row.batch_id,
      });
    });
  }

  async getLease(batchId: string): Promise<LogLeaseRow | undefined> {
    return logLeaseRowSchema
      .optional()
      .parse(await this.kv.get(this.leaseKey(batchId)));
  }

  async claimExpired(
    consumer: string,
    now: number,
    batchId: string,
    expiresAt: number
  ): Promise<LogLeaseRow | undefined> {
    return this.atomically(async (table) => {
      const prefix = table.leaseIndexPrefix(consumer);
      let startAfter: string | undefined;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const page = await table.kv.list({
          prefix,
          limit: 128,
          ...(startAfter === undefined ? {} : { startAfter }),
        });
        // eslint-disable-next-line no-await-in-loop
        const rows = await table.leaseRows(keySchema.parse([...page.values()]));
        for (const row of rows) {
          if (
            row === undefined ||
            (row.state !== 'pending' &&
              !(row.state === 'active' && row.expires_at <= now))
          ) {
            continue;
          }
          const updated: LogLeaseRow = {
            ...row,
            batch_id: batchId,
            state: 'active',
            attempt: row.attempt + 1,
            expires_at: expiresAt,
          };
          // Rewrites the primary and index keys together, so the previous
          // batch id stops resolving the moment this claim commits.
          // eslint-disable-next-line no-await-in-loop
          await table.writeLease(row, updated);
          return updated;
        }
        if (page.size < 128) {
          return undefined;
        }
        const keys = [...page.keys()];
        startAfter = keys[keys.length - 1];
      }
    });
  }

  async countHeld(consumer: string, now: number): Promise<number> {
    const rows = await this.listLeaseRows(consumer);
    return rows.filter(
      (row) =>
        row.state === 'pending' ||
        (row.state === 'active' && row.expires_at > now)
    ).length;
  }

  async settleLease(
    batchId: string,
    state: LogLeaseState,
    expiresAt: number
  ): Promise<boolean> {
    return this.atomically(async (table) => {
      const row = await table.getLease(batchId);
      if (row === undefined || row.state !== 'active') {
        return false;
      }
      await table.kv.put(table.leaseKey(batchId), {
        ...row,
        state,
        expires_at: expiresAt,
      });
      return true;
    });
  }

  async settledPrefix(
    consumer: string,
    from: number,
    limit: number
  ): Promise<LogLeaseRow[]> {
    return this.listLeaseRows(
      consumer,
      `${this.leaseIndexPrefix(consumer)}${timestampKey(from)}`,
      limit
    );
  }

  async deleteLeases(batchIds: readonly string[]): Promise<number> {
    const uniqueBatchIds = [...new Set(batchIds)];
    if (uniqueBatchIds.length === 0) {
      return 0;
    }
    return this.atomically(async (table) => {
      const rows: LogLeaseRow[] = [];
      for (let start = 0; start < uniqueBatchIds.length; start += 128) {
        // eslint-disable-next-line no-await-in-loop
        const page = await table.leaseRows(
          uniqueBatchIds.slice(start, start + 128)
        );
        rows.push(
          ...page.filter((row): row is LogLeaseRow => row !== undefined)
        );
      }
      const doomed = rows.flatMap((row) => [
        table.leaseKey(row.batch_id),
        table.leaseIndexKey(row),
      ]);
      for (let start = 0; start < doomed.length; start += purgeBatchSize) {
        // eslint-disable-next-line no-await-in-loop
        await table.kv.delete(doomed.slice(start, start + purgeBatchSize));
      }
      return rows.length;
    });
  }

  async leases(consumer: string): Promise<LogLeaseRow[]> {
    return this.listLeaseRows(consumer);
  }

  private async listLeaseRows(
    consumer: string,
    start?: string,
    limit?: number
  ): Promise<LogLeaseRow[]> {
    if (limit !== undefined && limit <= 0) {
      return [];
    }
    const rows: LogLeaseRow[] = [];
    const prefix = this.leaseIndexPrefix(consumer);
    let startAfter: string | undefined;
    for (;;) {
      const pageLimit = Math.min(
        128,
        limit === undefined ? 128 : limit - rows.length
      );
      // eslint-disable-next-line no-await-in-loop
      const page = await this.kv.list({
        prefix,
        limit: pageLimit,
        ...(startAfter !== undefined
          ? { startAfter }
          : start === undefined
            ? {}
            : { start }),
      });
      // eslint-disable-next-line no-await-in-loop
      const pageRows = await this.leaseRows(
        keySchema.parse([...page.values()])
      );
      rows.push(
        ...pageRows.filter((row): row is LogLeaseRow => row !== undefined)
      );
      if (
        page.size < pageLimit ||
        (limit !== undefined && rows.length >= limit)
      ) {
        return limit === undefined ? rows : rows.slice(0, limit);
      }
      const keys = [...page.keys()];
      startAfter = keys[keys.length - 1];
    }
  }

  private async leaseRows(
    batchIds: readonly string[]
  ): Promise<Array<LogLeaseRow | undefined>> {
    if (batchIds.length === 0) {
      return [];
    }
    const found = await this.kv.get<unknown>(
      batchIds.map((batchId) => this.leaseKey(batchId))
    );
    return batchIds.map((batchId) =>
      logLeaseRowSchema.optional().parse(found.get(this.leaseKey(batchId)))
    );
  }

  private async writeLease(
    previous: LogLeaseRow,
    next: LogLeaseRow
  ): Promise<void> {
    const previousKeys = [
      this.leaseKey(previous.batch_id),
      this.leaseIndexKey(previous),
    ];
    const nextKeys = [this.leaseKey(next.batch_id), this.leaseIndexKey(next)];
    const stale = previousKeys.filter((key) => !nextKeys.includes(key));
    if (stale.length > 0) {
      await this.kv.delete(stale);
    }
    await this.kv.put({
      [this.leaseKey(next.batch_id)]: next,
      [this.leaseIndexKey(next)]: next.batch_id,
    });
  }

  private recordKey(offset: number): string {
    return `${logRecordPrefix}${timestampKey(offset)}`;
  }

  private segmentKey(firstOffset: number): string {
    return `${logSegmentPrefix}${timestampKey(firstOffset)}`;
  }

  private keyIndex(dedupKey: string): string {
    return `${logKeyIndexPrefix}${encodeIndexPart(dedupKey)}`;
  }

  private cursorKey(consumer: string): string {
    return `${logCursorPrefix}${encodeIndexPart(consumer)}`;
  }

  private allocationKey(consumer: string): string {
    return `${logAllocationPrefix}${encodeIndexPart(consumer)}`;
  }

  private leaseKey(batchId: string): string {
    return `${logLeasePrefix}${encodeIndexPart(batchId)}`;
  }

  private leaseIndexPrefix(consumer: string): string {
    return `${logLeaseIndexPrefix}${encodeIndexPart(consumer)}:`;
  }

  private leaseIndexKey(row: LogLeaseRow): string {
    return `${this.leaseIndexPrefix(row.consumer)}${timestampKey(row.first_offset)}:${encodeIndexPart(row.batch_id)}`;
  }
}

class KvSession implements DurabilityStorageTransaction {
  readonly calls: KvTable<CallRow>;
  readonly alarms: KvTable<AlarmRow>;
  readonly deliveries: KvDeliveryTable;
  readonly log: KvLogTable;

  constructor(
    readonly physicalAlarm: KvStorage,
    atomically: <T>(callback: (session: KvSession) => Promise<T>) => Promise<T>
  ) {
    this.calls = new KvTable(physicalAlarm, callTable, (callback) =>
      atomically((session) => callback(session.calls))
    );
    this.alarms = new KvTable(physicalAlarm, alarmTable, (callback) =>
      atomically((session) => callback(session.alarms))
    );
    this.deliveries = new KvDeliveryTable(physicalAlarm, (callback) =>
      atomically((session) => callback(session.deliveries))
    );
    this.log = new KvLogTable(physicalAlarm, (callback) =>
      atomically((session) => callback(session.log))
    );
  }
}

const transactionalSession = (kv: KvStorage): KvSession => {
  const session: KvSession = new KvSession(kv, (callback) => callback(session));
  return session;
};

export const createKvDurabilityStorage = (
  storage: DurableObjectStorage
): DurabilityStorage => {
  const transaction = <T>(
    callback: (session: KvSession) => Promise<T>
  ): Promise<T> =>
    storage.transaction((durableTransaction) =>
      callback(transactionalSession(durableTransaction))
    );
  const session = new KvSession(storage, transaction);

  return {
    calls: session.calls,
    alarms: session.alarms,
    deliveries: session.deliveries,
    log: session.log,
    transaction,
  };
};
