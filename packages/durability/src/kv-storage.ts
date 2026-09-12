import { z } from 'zod';
import {
  alarmRowSchema,
  callRowSchema,
  type AlarmRow,
  type CallRow,
  type DurabilityStorage,
  type DurabilityStorageTransaction,
  type DurableRecord,
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

/** Deleting more keys than this in one KV call exceeds the Durable Object limit. */
const purgeBatchSize = 20;

type Atomically<Row extends DurableRecord> = <T>(
  callback: (table: KvTable<Row>) => Promise<T>
) => Promise<T>;

/**
 * One record kind stored as a primary row plus two ordered index keys:
 * `pending-<name>:<next_attempt_at>:<key>` for due work and
 * `created-<name>:<created_at>:<key>` for retention purges.
 */
class KvTable<Row extends DurableRecord> implements RecordStore<Row> {
  private readonly rowPrefix: string;
  private readonly pendingPrefix: string;
  private readonly createdPrefix: string;

  constructor(
    private readonly kv: KvStorage,
    private readonly spec: TableSpec<Row>,
    private readonly atomically: Atomically<Row>
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

  private async rows(keys: string[]): Promise<Row[]> {
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

  private async write(previous: Row | undefined, next: Row): Promise<void> {
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

  private rowKey(key: string): string {
    return `${this.rowPrefix}${key}`;
  }

  private indexKeys(row: Row): string[] {
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

class KvSession implements DurabilityStorageTransaction {
  readonly calls: KvTable<CallRow>;
  readonly alarms: KvTable<AlarmRow>;

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
    transaction,
  };
};
