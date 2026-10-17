import { z } from 'zod';

export const callRowSchema = z.object({
  id: z.string(),
  operation: z.string(),
  payload: z.string(),
  status: z.enum(['pending', 'completed', 'failed']),
  result: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  next_attempt_at: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  last_error_name: z.string().nullable(),
  completed_at: z.number().int().nonnegative().nullable(),
  created_at: z.number().int().nonnegative(),
  generation_id: z.string(),
});

export type CallRow = z.infer<typeof callRowSchema>;

export const alarmRowSchema = z.object({
  name: z.string(),
  generation_id: z.string(),
  status: z.enum(['pending', 'failed']),
  scheduled_at: z.number().int().nonnegative(),
  next_attempt_at: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  last_error_name: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
});

export type AlarmRow = z.infer<typeof alarmRowSchema>;

export const fanoutMessageRowSchema = z.object({
  key: z.string(),
  id: z.string(),
  payload: z.string(),
  targets: z.string(),
  remaining: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  generation_id: z.string(),
});

export type FanoutMessageRow = z.infer<typeof fanoutMessageRowSchema>;

export const deliveryRowSchema = z.object({
  id: z.string(),
  message_key: z.string(),
  target_id: z.string(),
  seq: z.number().int().nonnegative(),
  status: z.literal('pending'),
  phase: z.enum(['delivery', 'dead_letter']),
  attempt: z.number().int().nonnegative(),
  next_attempt_at: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  last_error_name: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
  generation_id: z.string(),
  dead_lettered_at: z.number().int().nonnegative().nullable(),
  dead_letter_reason: z.enum(['explicit', 'exhausted']).nullable(),
});

export type DeliveryRow = z.infer<typeof deliveryRowSchema>;

export type ColumnValue = string | number | null;

export type DurableRecord = Record<string, ColumnValue> & {
  generation_id: string;
  status: string;
  attempt: number;
  next_attempt_at: number;
  created_at: number;
};

/** Failure columns shared by every record kind, so generic code can settle without knowing the row. */
export type FailurePatch = {
  status: 'pending' | 'failed';
  next_attempt_at?: number;
  last_error: string;
  last_error_name: string;
};

/** Columns a settlement may change; identity, generation, attempt, and creation time are fixed. */
export type RecordPatch<Row extends DurableRecord> =
  | FailurePatch
  | Partial<
      Omit<Row, 'id' | 'name' | 'generation_id' | 'attempt' | 'created_at'>
    >;

export type PhysicalAlarm = Pick<
  DurableObjectTransaction,
  'getAlarm' | 'setAlarm' | 'deleteAlarm'
>;

type TableSpec<Row extends DurableRecord> = {
  table: string;
  key: string;
  schema: z.ZodType<Row>;
  columns: readonly string[];
  /** ORDER BY clause for due work. Defaults to next_attempt_at only. */
  dueOrder?: string;
};

type Atomically = <T>(
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

/**
 * In-memory pending-delivery count. Counting the table on every enqueue costs
 * O(backlog), which made a shard that fell behind fall further behind. The
 * count is hydrated once per object lifetime and kept exact by insert/remove;
 * anything that could leave it wrong (a failed transaction, a bulk purge)
 * invalidates it so the next read recounts.
 */
class PendingCounter {
  #value: number | undefined;

  get(count: () => number): number {
    this.#value ??= count();
    return this.#value;
  }

  add(delta: number): void {
    if (this.#value !== undefined) {
      this.#value += delta;
    }
  }

  invalidate(): void {
    this.#value = undefined;
  }
}
const messageKeyRowSchema = z.object({ message_key: z.string() });
const messageCountRowSchema = z.object({
  message_key: z.string(),
  count: z.number().int().positive(),
});
const seqRowSchema = z.object({ seq: z.number().int().nonnegative() });

const definedEntries = (
  patch: Record<string, ColumnValue | undefined>
): Array<[string, ColumnValue]> =>
  Object.entries(patch).filter(
    (entry): entry is [string, ColumnValue] => entry[1] !== undefined
  );

/**
 * Compare-and-set access to one kind of durable record.
 *
 * Every mutation is conditional on the record's generation and attempt so a
 * stale execution can never overwrite a replacement or a later attempt.
 */
export class RecordTable<Row extends DurableRecord> {
  constructor(
    protected readonly sql: SqlStorage,
    protected readonly spec: TableSpec<Row>,
    protected readonly atomically: Atomically
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

  /** Deletes records created strictly before the timestamp and returns how many were removed. */
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

export class DeliveryTable extends RecordTable<DeliveryRow> {
  constructor(
    sql: SqlStorage,
    atomically: Atomically,
    private readonly pending: PendingCounter
  ) {
    super(sql, deliveryTable, atomically);
  }

  override async insert(row: DeliveryRow): Promise<boolean> {
    const inserted = await super.insert(row);
    if (inserted) {
      this.pending.add(1);
    }
    return inserted;
  }

  /** Allocates a sequence number from a durable counter, including an empty queue. */
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
    // Two indexed queries instead of one sort over every pending row: first
    // deliveries (attempt = 0) in sequence, then retries.
    const first = await this.rows(
      `SELECT * FROM durability_fanout_deliveries
       WHERE target_id = ? AND phase = 'delivery' AND status = 'pending'
         AND attempt = 0 AND next_attempt_at <= ?
       ORDER BY seq ASC
       LIMIT ?`,
      target,
      now,
      limit
    );
    if (first.length >= limit) {
      return first;
    }

    const retries = await this.rows(
      `SELECT * FROM durability_fanout_deliveries
       WHERE target_id = ? AND status = 'pending'
         AND attempt > 0 AND next_attempt_at <= ?
       ORDER BY seq ASC
       LIMIT ?`,
      target,
      now,
      limit - first.length
    );
    return [...first, ...retries];
  }

  /** Returns the exact number of active delivery children. */
  async pendingCount(): Promise<number> {
    return this.pending.get(
      () =>
        countRowSchema.parse(
          this.sql
            .exec(
              `SELECT COUNT(*) AS count FROM durability_fanout_deliveries
               WHERE status = 'pending'`
            )
            .toArray()[0]
        ).count
    );
  }

  override async listDue(now: number, limit: number): Promise<DeliveryRow[]> {
    const first = await this.rows(
      `SELECT * FROM durability_fanout_deliveries
       WHERE status = 'pending' AND attempt = 0 AND next_attempt_at <= ?
       ORDER BY seq ASC
       LIMIT ?`,
      now,
      limit
    );
    if (first.length >= limit) {
      return first;
    }

    const retries = await this.rows(
      `SELECT * FROM durability_fanout_deliveries
       WHERE status = 'pending' AND attempt > 0 AND next_attempt_at <= ?
       ORDER BY seq ASC
       LIMIT ?`,
      now,
      limit - first.length
    );
    return [...first, ...retries];
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
      this.pending.add(-1);

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
    this.pending.invalidate();
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

export class DurabilityStorageTransaction {
  readonly calls: RecordTable<CallRow>;
  readonly alarms: RecordTable<AlarmRow>;
  readonly deliveries: DeliveryTable;

  constructor(
    sql: SqlStorage,
    readonly physicalAlarm: PhysicalAlarm,
    atomically: Atomically,
    pending: PendingCounter
  ) {
    this.calls = new RecordTable(sql, callTable, atomically);
    this.alarms = new RecordTable(sql, alarmTable, atomically);
    this.deliveries = new DeliveryTable(sql, atomically, pending);
  }
}

export type RecordKind = 'calls' | 'alarms' | 'deliveries';

export type DurabilityStorage = Pick<
  DurabilityStorageTransaction,
  RecordKind
> & {
  transaction<T>(
    callback: (transaction: DurabilityStorageTransaction) => Promise<T>
  ): Promise<T>;
};

export const createDurabilityStorage = (
  storage: DurableObjectStorage
): DurabilityStorage => {
  const pending = new PendingCounter();
  // A rolled-back transaction may have adjusted the count; recount next time.
  const guarded = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      pending.invalidate();
      throw error;
    }
  };
  const transaction = <T>(
    callback: (transaction: DurabilityStorageTransaction) => Promise<T>
  ): Promise<T> =>
    guarded(() =>
      storage.transaction((durableTransaction) =>
        callback(
          new DurabilityStorageTransaction(
            storage.sql,
            durableTransaction,
            (run) => Promise.resolve(run(storage.sql)),
            pending
          )
        )
      )
    );
  const session = new DurabilityStorageTransaction(
    storage.sql,
    storage,
    (run) =>
      guarded(() =>
        storage.transaction(() => Promise.resolve(run(storage.sql)))
      ),
    pending
  );

  return {
    calls: session.calls,
    alarms: session.alarms,
    deliveries: session.deliveries,
    transaction,
  };
};

/** Returns the earliest pending time and maintains its bounded physical fallback. */
export const reconcilePhysicalAlarm = async (
  transaction: DurabilityStorageTransaction,
  kinds: readonly RecordKind[],
  minimumDelayMs: number
): Promise<number | undefined> => {
  const candidates = await Promise.all(
    kinds.map((kind) => transaction[kind].nextPendingAt())
  );
  const scheduled = candidates.filter(
    (value): value is number => value !== undefined
  );
  const nextAlarmAt =
    scheduled.length === 0 ? undefined : Math.min(...scheduled);
  const currentAlarm = await transaction.physicalAlarm.getAlarm();
  if (nextAlarmAt === undefined) {
    if (currentAlarm !== null) {
      await transaction.physicalAlarm.deleteAlarm();
    }
    return undefined;
  }

  const target = Math.max(nextAlarmAt, Date.now() + minimumDelayMs);
  // Preserve a fallback inside this range so frequent reconciliation cannot push it later.
  if (
    currentAlarm === null ||
    currentAlarm < nextAlarmAt ||
    currentAlarm > target
  ) {
    await transaction.physicalAlarm.setAlarm(target);
  }
  return nextAlarmAt;
};
