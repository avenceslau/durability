import { z } from 'zod';
import {
  alarmRowSchema,
  callRowSchema,
  deliveryRowSchema,
  fanoutMessageRowSchema,
  type AlarmRow,
  type CallRow,
  type DeliveryRow,
  type DeliveryStore,
  type DurabilityStorage,
  type DurabilityStorageTransaction,
  type DurableRecord,
  type FanoutMessageRow,
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

const encodeIndexPart = (value: string): string => encodeURIComponent(value);

const deliveryAttemptClass = (row: DeliveryRow): number =>
  row.attempt === 0 ? 0 : 1;

type Atomically<Row extends DurableRecord> = <T>(
  callback: (table: KvTable<Row>) => Promise<T>
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

class KvSession implements DurabilityStorageTransaction {
  readonly calls: KvTable<CallRow>;
  readonly alarms: KvTable<AlarmRow>;
  readonly deliveries: KvDeliveryTable;

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
    transaction,
  };
};
