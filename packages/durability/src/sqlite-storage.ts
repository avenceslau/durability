import { z } from 'zod';
import {
  alarmRowSchema,
  callRowSchema,
  deliveryRowSchema,
  fanoutMessageRowSchema,
  logCursorRowSchema,
  logRecordRowSchema,
  type AlarmRow,
  type CallRow,
  type ColumnValue,
  type DeliveryRow,
  type DeliveryStore,
  type DurabilityStorage,
  type DurabilityStorageTransaction,
  type DurableRecord,
  type FanoutMessageRow,
  type LogBounds,
  type LogCursorRow,
  type LogRecordRow,
  type LogStore,
  type PhysicalAlarm,
  type RecordPatch,
  type RecordStore,
} from './storage.js';

type TableSpec<Row extends DurableRecord> = {
  table: string;
  key: string;
  schema: z.ZodType<Row>;
  columns: readonly string[];
  /** ORDER BY clause for due work. Defaults to next_attempt_at only. */
  dueOrder?: string;
};

type SqliteAtomically = <T>(
  callback: (sql: SqlStorage) => T | Promise<T>
) => Promise<T>;

const callTable: TableSpec<CallRow> = {
  table: 'durability_calls',
  key: 'id',
  schema: callRowSchema,
  columns: callRowSchema.keyof().options,
};

const alarmTable: TableSpec<AlarmRow> = {
  table: 'durability_alarms',
  key: 'name',
  schema: alarmRowSchema,
  columns: alarmRowSchema.keyof().options,
};

const deliveryTable: TableSpec<DeliveryRow> = {
  table: 'durability_fanout_deliveries',
  key: 'id',
  schema: deliveryRowSchema,
  columns: deliveryRowSchema.keyof().options,
  dueOrder: 'attempt ASC, seq ASC',
};

const attemptRowSchema = z.object({
  attempt: z.number().int().nonnegative(),
});
const countRowSchema = z.object({ count: z.number().int().nonnegative() });
const messageKeyRowSchema = z.object({ message_key: z.string() });
const messageCountRowSchema = z.object({
  message_key: z.string(),
  count: z.number().int().positive(),
});
const seqRowSchema = z.object({ seq: z.number().int().nonnegative() });
const offsetRowSchema = z.object({ offset: z.number().int().nonnegative() });
const boundsRowSchema = z.object({
  oldest: z.number().int().nonnegative().nullable(),
  next_offset: z.number().int().nonnegative(),
});

const definedEntries = (
  patch: Record<string, ColumnValue | undefined>
): Array<[string, ColumnValue]> =>
  Object.entries(patch).filter(
    (entry): entry is [string, ColumnValue] => entry[1] !== undefined
  );

class SqliteTable<Row extends DurableRecord> implements RecordStore<Row> {
  constructor(
    protected readonly sql: SqlStorage,
    protected readonly spec: TableSpec<Row>,
    protected readonly atomically: SqliteAtomically
  ) {}

  async get(key: string): Promise<Row | undefined> {
    return this.rows(
      `SELECT * FROM ${this.spec.table} WHERE ${this.spec.key} = ? LIMIT 1`,
      key
    )[0];
  }

  async listDue(now: number, limit: number): Promise<Row[]> {
    return this.rows(
      `SELECT * FROM ${this.spec.table}
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY ${this.spec.dueOrder ?? 'next_attempt_at ASC'}
       LIMIT ?`,
      now,
      limit
    );
  }

  async nextPendingAt(): Promise<number | undefined> {
    return this.rows(
      `SELECT * FROM ${this.spec.table}
       WHERE status = 'pending'
       ORDER BY next_attempt_at ASC
       LIMIT 1`
    )[0]?.next_attempt_at;
  }

  async insert(row: Row): Promise<boolean> {
    const { table, key, columns } = this.spec;
    return this.changed(
      `INSERT INTO ${table} (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})
       ON CONFLICT(${key}) DO NOTHING
       RETURNING ${key}`,
      ...this.values(row)
    );
  }

  async upsert(row: Row): Promise<void> {
    const { table, key, columns } = this.spec;
    const replacements = columns
      .filter((column) => column !== key)
      .map((column) => `${column} = excluded.${column}`);
    this.sql.exec(
      `INSERT INTO ${table} (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})
       ON CONFLICT(${key}) DO UPDATE SET ${replacements.join(', ')}`,
      ...this.values(row)
    );
  }

  async claimAttempt(
    key: string,
    generation: string,
    maxAttempts: number
  ): Promise<number | undefined> {
    return attemptRowSchema.optional().parse(
      this.sql
        .exec(
          `UPDATE ${this.spec.table}
           SET attempt = attempt + 1
           WHERE ${this.spec.key} = ? AND generation_id = ?
             AND status = 'pending' AND attempt < ?
           RETURNING attempt`,
          key,
          generation,
          maxAttempts
        )
        .toArray()[0]
    )?.attempt;
  }

  async settle(
    key: string,
    generation: string,
    attempt: number,
    patch: RecordPatch<Row>
  ): Promise<boolean> {
    return this.update(key, generation, '=', attempt, patch);
  }

  async exhaust(
    key: string,
    generation: string,
    maxAttempts: number,
    patch: RecordPatch<Row>
  ): Promise<boolean> {
    return this.update(key, generation, '>=', maxAttempts, patch);
  }

  async remove(
    key: string,
    generation: string,
    attempt: number
  ): Promise<boolean> {
    return this.changed(
      `DELETE FROM ${this.spec.table}
       WHERE ${this.spec.key} = ? AND generation_id = ?
         AND status = 'pending' AND attempt = ?
       RETURNING ${this.spec.key}`,
      key,
      generation,
      attempt
    );
  }

  async deleteCreatedBefore(before: number): Promise<number> {
    return this.atomically((sql) => {
      const { count } = countRowSchema.parse(
        sql
          .exec(
            `SELECT COUNT(*) AS count FROM ${this.spec.table} WHERE created_at < ?`,
            before
          )
          .toArray()[0]
      );
      sql.exec(`DELETE FROM ${this.spec.table} WHERE created_at < ?`, before);
      return count;
    });
  }

  protected update(
    key: string,
    generation: string,
    attemptOperator: '=' | '>=',
    attemptBound: number,
    patch: RecordPatch<Row>
  ): boolean {
    const entries = definedEntries(patch);
    const unknown = entries
      .map(([column]) => column)
      .filter((column) => !this.spec.columns.includes(column));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown ${this.spec.table} columns: ${unknown.join(', ')}`
      );
    }

    return this.changed(
      `UPDATE ${this.spec.table}
       SET ${entries.map(([column]) => `${column} = ?`).join(', ')}
       WHERE ${this.spec.key} = ? AND generation_id = ?
         AND status = 'pending' AND attempt ${attemptOperator} ?
       RETURNING ${this.spec.key}`,
      ...entries.map(([, value]) => value),
      key,
      generation,
      attemptBound
    );
  }

  protected values(row: Row): ColumnValue[] {
    // Rows are schema-validated, so every column is present; `?? null` only satisfies the index type.
    return this.spec.columns.map((column) => row[column] ?? null);
  }

  protected rows(query: string, ...bindings: SqlStorageValue[]): Row[] {
    return this.spec.schema
      .array()
      .parse(this.sql.exec(query, ...bindings).toArray());
  }

  protected changed(query: string, ...bindings: SqlStorageValue[]): boolean {
    return this.sql.exec(query, ...bindings).toArray().length > 0;
  }
}

class SqliteDeliveryTable
  extends SqliteTable<DeliveryRow>
  implements DeliveryStore
{
  constructor(sql: SqlStorage, atomically: SqliteAtomically) {
    super(sql, deliveryTable, atomically);
  }

  async nextSeq(): Promise<number> {
    return this.atomically(
      (sql) =>
        seqRowSchema.parse(
          sql
            .exec(
              `UPDATE durability_fanout_seq
             SET next_seq = next_seq + 1
             WHERE id = 1
             RETURNING next_seq - 1 AS seq`
            )
            .toArray()[0]
        ).seq
    );
  }

  async getMessage(key: string): Promise<FanoutMessageRow | undefined> {
    return fanoutMessageRowSchema
      .optional()
      .parse(
        this.sql
          .exec(
            'SELECT * FROM durability_fanout_messages WHERE key = ? LIMIT 1',
            key
          )
          .toArray()[0]
      );
  }

  async insertMessage(row: FanoutMessageRow): Promise<boolean> {
    const columns = fanoutMessageRowSchema.keyof().options;
    return this.changed(
      `INSERT INTO durability_fanout_messages (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})
       ON CONFLICT(key) DO NOTHING
       RETURNING key`,
      row.key,
      row.id,
      row.payload,
      row.targets,
      row.remaining,
      row.seq,
      row.created_at,
      row.generation_id
    );
  }

  async listTargets(): Promise<string[]> {
    return z
      .string()
      .array()
      .parse(
        this.sql
          .exec(
            `SELECT DISTINCT target_id FROM durability_fanout_deliveries
           ORDER BY target_id`
          )
          .toArray()
          .map((row) => row['target_id'])
      );
  }

  async listDueForTarget(
    target: string,
    now: number,
    limit: number
  ): Promise<DeliveryRow[]> {
    return this.rows(
      `SELECT * FROM durability_fanout_deliveries
       WHERE target_id = ? AND status = 'pending'
         AND next_attempt_at <= ?
       ORDER BY CASE WHEN attempt = 0 THEN 0 ELSE 1 END ASC, seq ASC
       LIMIT ?`,
      target,
      now,
      limit
    );
  }

  async pendingCount(): Promise<number> {
    return countRowSchema.parse(
      this.sql
        .exec(
          `SELECT COUNT(*) AS count FROM durability_fanout_deliveries
           WHERE status = 'pending'`
        )
        .toArray()[0]
    ).count;
  }

  override async listDue(now: number, limit: number): Promise<DeliveryRow[]> {
    return this.rows(
      `SELECT * FROM durability_fanout_deliveries
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY CASE WHEN attempt = 0 THEN 0 ELSE 1 END ASC, seq ASC
       LIMIT ?`,
      now,
      limit
    );
  }

  override async nextPendingAt(): Promise<number | undefined> {
    return this.rows(
      `SELECT * FROM durability_fanout_deliveries
       WHERE status = 'pending'
       ORDER BY next_attempt_at ASC
       LIMIT 1`
    )[0]?.next_attempt_at;
  }

  override async remove(
    key: string,
    generation: string,
    attempt: number
  ): Promise<boolean> {
    return this.atomically((sql) => {
      const messageKey = messageKeyRowSchema.optional().parse(
        sql
          .exec(
            `DELETE FROM durability_fanout_deliveries
             WHERE id = ? AND generation_id = ?
               AND status = 'pending' AND attempt = ?
             RETURNING message_key`,
            key,
            generation,
            attempt
          )
          .toArray()[0]
      )?.message_key;
      if (messageKey === undefined) {
        return false;
      }

      sql.exec(
        `UPDATE durability_fanout_messages
         SET remaining = remaining - 1
         WHERE key = ?`,
        messageKey
      );
      sql.exec(
        `DELETE FROM durability_fanout_messages
         WHERE key = ? AND remaining = 0`,
        messageKey
      );
      return true;
    });
  }

  override async deleteCreatedBefore(before: number): Promise<number> {
    return this.atomically((sql) => {
      const messageCounts = messageCountRowSchema.array().parse(
        sql
          .exec(
            `SELECT message_key, COUNT(*) AS count
             FROM durability_fanout_deliveries
             WHERE created_at < ?
             GROUP BY message_key`,
            before
          )
          .toArray()
      );
      if (messageCounts.length === 0) {
        return 0;
      }

      const { count } = countRowSchema.parse(
        sql
          .exec(
            `SELECT COUNT(*) AS count FROM durability_fanout_deliveries
             WHERE created_at < ?`,
            before
          )
          .toArray()[0]
      );
      sql.exec(
        'DELETE FROM durability_fanout_deliveries WHERE created_at < ?',
        before
      );
      for (const { message_key: messageKey, count: removed } of messageCounts) {
        sql.exec(
          `UPDATE durability_fanout_messages
           SET remaining = remaining - ?
           WHERE key = ?`,
          removed,
          messageKey
        );
        sql.exec(
          `DELETE FROM durability_fanout_messages
           WHERE key = ? AND remaining = 0`,
          messageKey
        );
      }
      return count;
    });
  }
}

class SqliteLogTable implements LogStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly atomically: SqliteAtomically
  ) {}

  async append(
    records: readonly Pick<LogRecordRow, 'key' | 'payload'>[],
    appendedAt: number
  ): Promise<number[]> {
    if (records.length === 0) {
      return [];
    }
    return this.atomically((sql) => {
      const assigned = new Map<string, number>();
      for (const { key } of records) {
        const existing = offsetRowSchema
          .optional()
          .parse(
            sql
              .exec(
                'SELECT "offset" FROM durability_log_records WHERE key = ? LIMIT 1',
                key
              )
              .toArray()[0]
          );
        if (existing !== undefined) {
          assigned.set(key, existing.offset);
        }
      }
      const fresh = records.filter(({ key }) => !assigned.has(key));
      const distinct = [...new Set(fresh.map(({ key }) => key))];
      if (distinct.length > 0) {
        const first = seqRowSchema.parse(
          sql
            .exec(
              `UPDATE durability_log_seq
               SET next_offset = next_offset + ?
               WHERE id = 1
               RETURNING next_offset - ? AS seq`,
              distinct.length,
              distinct.length
            )
            .toArray()[0]
        ).seq;
        distinct.forEach((key, index) => assigned.set(key, first + index));
        for (const { key, payload } of fresh) {
          sql.exec(
            `INSERT INTO durability_log_records ("offset", key, payload, appended_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO NOTHING`,
            assigned.get(key)!,
            key,
            payload,
            appendedAt
          );
        }
      }
      return records.map(({ key }) => assigned.get(key)!);
    });
  }

  async read(from: number, limit: number): Promise<LogRecordRow[]> {
    return logRecordRowSchema.array().parse(
      this.sql
        .exec(
          `SELECT * FROM durability_log_records
           WHERE "offset" >= ?
           ORDER BY "offset" ASC
           LIMIT ?`,
          from,
          limit
        )
        .toArray()
    );
  }

  async bounds(): Promise<LogBounds> {
    const row = boundsRowSchema.parse(
      this.sql
        .exec(
          `SELECT
             (SELECT MIN("offset") FROM durability_log_records) AS oldest,
             next_offset
           FROM durability_log_seq WHERE id = 1`
        )
        .toArray()[0]
    );
    return {
      oldestOffset: row.oldest ?? row.next_offset,
      nextOffset: row.next_offset,
    };
  }

  async count(): Promise<number> {
    return countRowSchema.parse(
      this.sql
        .exec('SELECT COUNT(*) AS count FROM durability_log_records')
        .toArray()[0]
    ).count;
  }

  async listOldest(limit: number): Promise<LogRecordRow[]> {
    return logRecordRowSchema.array().parse(
      this.sql
        .exec(
          `SELECT * FROM durability_log_records
           ORDER BY "offset" ASC
           LIMIT ?`,
          limit
        )
        .toArray()
    );
  }

  async trimThrough(through: number, limit: number): Promise<number> {
    return this.sql
      .exec(
        `DELETE FROM durability_log_records
       WHERE "offset" IN (
         SELECT "offset" FROM durability_log_records
         WHERE "offset" < ?
         ORDER BY "offset" ASC
         LIMIT ?
       )
       RETURNING "offset"`,
        through,
        limit
      )
      .toArray().length;
  }

  async cursor(consumer: string): Promise<number | undefined> {
    return offsetRowSchema
      .optional()
      .parse(
        this.sql
          .exec(
            'SELECT "offset" FROM durability_log_cursors WHERE consumer = ? LIMIT 1',
            consumer
          )
          .toArray()[0]
      )?.offset;
  }

  async commit(
    consumer: string,
    offset: number,
    committedAt: number
  ): Promise<void> {
    this.sql.exec(
      `INSERT INTO durability_log_cursors (consumer, "offset", committed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(consumer) DO UPDATE
         SET "offset" = excluded."offset", committed_at = excluded.committed_at
         WHERE excluded."offset" > durability_log_cursors."offset"`,
      consumer,
      offset,
      committedAt
    );
  }

  async cursors(): Promise<LogCursorRow[]> {
    return logCursorRowSchema
      .array()
      .parse(
        this.sql
          .exec('SELECT * FROM durability_log_cursors ORDER BY consumer')
          .toArray()
      );
  }
}

class SqliteSession implements DurabilityStorageTransaction {
  readonly calls: SqliteTable<CallRow>;
  readonly alarms: SqliteTable<AlarmRow>;
  readonly deliveries: SqliteDeliveryTable;
  readonly log: SqliteLogTable;

  constructor(
    sql: SqlStorage,
    readonly physicalAlarm: PhysicalAlarm,
    atomically: SqliteAtomically
  ) {
    this.calls = new SqliteTable(sql, callTable, atomically);
    this.alarms = new SqliteTable(sql, alarmTable, atomically);
    this.deliveries = new SqliteDeliveryTable(sql, atomically);
    this.log = new SqliteLogTable(sql, atomically);
  }
}

export const createSqliteDurabilityStorage = (
  storage: DurableObjectStorage
): DurabilityStorage => {
  const transaction = <T>(
    callback: (transaction: DurabilityStorageTransaction) => Promise<T>
  ): Promise<T> =>
    storage.transaction((durableTransaction) =>
      callback(
        new SqliteSession(storage.sql, durableTransaction, (run) =>
          Promise.resolve(run(storage.sql))
        )
      )
    );
  const session = new SqliteSession(storage.sql, storage, (run) =>
    storage.transaction(() => Promise.resolve(run(storage.sql)))
  );

  return {
    calls: session.calls,
    alarms: session.alarms,
    deliveries: session.deliveries,
    log: session.log,
    transaction,
  };
};
