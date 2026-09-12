import { z } from 'zod';
import {
  alarmRowSchema,
  callRowSchema,
  type AlarmRow,
  type CallRow,
  type ColumnValue,
  type DurabilityStorage,
  type DurabilityStorageTransaction,
  type DurableRecord,
  type PhysicalAlarm,
  type RecordPatch,
  type RecordStore,
} from './storage.js';

type TableSpec<Row extends DurableRecord> = {
  table: string;
  key: string;
  schema: z.ZodType<Row>;
  columns: readonly string[];
};

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

const attemptRowSchema = z.object({
  attempt: z.number().int().nonnegative(),
});
const countRowSchema = z.object({ count: z.number().int().nonnegative() });

const definedEntries = (
  patch: Record<string, ColumnValue | undefined>
): Array<[string, ColumnValue]> =>
  Object.entries(patch).filter(
    (entry): entry is [string, ColumnValue] => entry[1] !== undefined
  );

class SqliteTable<Row extends DurableRecord> implements RecordStore<Row> {
  constructor(
    private readonly sql: SqlStorage,
    private readonly spec: TableSpec<Row>
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
       ORDER BY next_attempt_at ASC
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
    const { count } = countRowSchema.parse(
      this.sql
        .exec(
          `SELECT COUNT(*) AS count FROM ${this.spec.table} WHERE created_at < ?`,
          before
        )
        .toArray()[0]
    );
    this.sql.exec(
      `DELETE FROM ${this.spec.table} WHERE created_at < ?`,
      before
    );
    return count;
  }

  private update(
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

  private values(row: Row): ColumnValue[] {
    // Rows are schema-validated, so every column is present; `?? null` only satisfies the index type.
    return this.spec.columns.map((column) => row[column] ?? null);
  }

  private rows(query: string, ...bindings: SqlStorageValue[]): Row[] {
    return this.spec.schema
      .array()
      .parse(this.sql.exec(query, ...bindings).toArray());
  }

  private changed(query: string, ...bindings: SqlStorageValue[]): boolean {
    return this.sql.exec(query, ...bindings).toArray().length > 0;
  }
}

class SqliteSession implements DurabilityStorageTransaction {
  readonly calls: SqliteTable<CallRow>;
  readonly alarms: SqliteTable<AlarmRow>;

  constructor(
    sql: SqlStorage,
    readonly physicalAlarm: PhysicalAlarm
  ) {
    this.calls = new SqliteTable(sql, callTable);
    this.alarms = new SqliteTable(sql, alarmTable);
  }
}

export const createSqliteDurabilityStorage = (
  storage: DurableObjectStorage
): DurabilityStorage => {
  const session = new SqliteSession(storage.sql, storage);
  return {
    calls: session.calls,
    alarms: session.alarms,
    transaction: (callback) =>
      storage.transaction((durableTransaction) =>
        callback(new SqliteSession(storage.sql, durableTransaction))
      ),
  };
};
