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

export const logRecordRowSchema = z.object({
  offset: z.number().int().nonnegative(),
  dedup_key: z.string(),
  payload: z.string(),
  bytes: z.number().int().nonnegative(),
  appended_at: z.number().int().nonnegative(),
});

export type LogRecordRow = z.infer<typeof logRecordRowSchema>;

export const logCursorRowSchema = z.object({
  consumer: z.string(),
  offset: z.number().int().nonnegative(),
  committed_at: z.number().int().nonnegative(),
});

export type LogCursorRow = z.infer<typeof logCursorRowSchema>;

/** One contiguous run of records moved out of the object into cold storage. */
export const logSegmentRowSchema = z.object({
  first_offset: z.number().int().nonnegative(),
  last_offset: z.number().int().nonnegative(),
  locator: z.string(),
  bytes: z.number().int().nonnegative(),
  flushed_at: z.number().int().nonnegative(),
});

export type LogSegmentRow = z.infer<typeof logSegmentRowSchema>;

/**
 * One in-flight or settled range of offsets held by a consumer. A range is
 * redelivered under a fresh `batch_id`, so an ack from a previous holder is
 * rejected rather than advancing a range someone else now owns.
 */
export const logLeaseRowSchema = z.object({
  batch_id: z.string(),
  consumer: z.string(),
  first_offset: z.number().int().nonnegative(),
  last_offset: z.number().int().nonnegative(),
  state: z.enum(['active', 'pending', 'acked', 'skipped']),
  attempt: z.number().int().positive(),
  expires_at: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
});

export type LogLeaseRow = z.infer<typeof logLeaseRowSchema>;

export type LogLeaseState = LogLeaseRow['state'];

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
 * A retained, offset-addressed record sequence. Unlike a `RecordStore` its
 * records carry no attempt state: consumers track progress with cursors and
 * records leave the object only through retention, either deleted or flushed
 * to cold storage.
 */
export interface LogStore {
  /**
   * Appends the batch atomically and returns each record's offset in input
   * order. A record whose deduplication key is already present keeps its
   * original offset and consumes no new one, so a repeated append is
   * idempotent while that record is still held in the object.
   */
  append(
    records: readonly Pick<LogRecordRow, 'dedup_key' | 'payload' | 'bytes'>[],
    appendedAt: number
  ): Promise<number[]>;
  read(from: number, limit: number): Promise<LogRecordRow[]>;
  bounds(): Promise<LogBounds>;
  count(): Promise<number>;
  /** Bytes of record payloads held in the object, excluding flushed segments. */
  totalBytes(): Promise<number>;
  /** Oldest retained records in offset order, for flush-or-delete decisions. */
  listOldest(limit: number): Promise<LogRecordRow[]>;
  /**
   * Deletes at most `limit` records below `through`, oldest first, and returns
   * how many were removed. Callers loop until zero.
   */
  trimThrough(through: number, limit: number): Promise<number>;
  /** Records where a flushed run now lives, so a read can rehydrate it. */
  insertSegment(row: LogSegmentRow): Promise<void>;
  /** The segment holding an offset, if that offset was flushed. */
  findSegment(offset: number): Promise<LogSegmentRow | undefined>;
  /** Forgets segments ending below an offset, matching external expiry. */
  deleteSegmentsBefore(offset: number): Promise<number>;
  cursor(consumer: string): Promise<number | undefined>;
  /** Advances a cursor, ignoring regressions so a late commit cannot rewind it. */
  commit(consumer: string, offset: number, committedAt: number): Promise<void>;
  cursors(): Promise<LogCursorRow[]>;
  /** Highest offset handed to a lease, which runs ahead of the commit. */
  allocation(consumer: string): Promise<number | undefined>;
  setAllocation(consumer: string, offset: number): Promise<void>;
  insertLease(row: LogLeaseRow): Promise<void>;
  getLease(batchId: string): Promise<LogLeaseRow | undefined>;
  /**
   * Oldest range owed redelivery: explicitly nacked, or held past its
   * expiry. Claiming rewrites its `batch_id`, fencing the previous holder.
   */
  claimExpired(
    consumer: string,
    now: number,
    batchId: string,
    expiresAt: number
  ): Promise<LogLeaseRow | undefined>;
  /** Ranges still held, so parallelism can be bounded per consumer. */
  countHeld(consumer: string, now: number): Promise<number>;
  /** Settles one range, failing when the batch was fenced or already settled. */
  settleLease(
    batchId: string,
    state: LogLeaseState,
    expiresAt: number
  ): Promise<boolean>;
  /**
   * Settled ranges forming an unbroken run from `from`, so a commit advances
   * only over offsets nobody is still working on.
   */
  settledPrefix(
    consumer: string,
    from: number,
    limit: number
  ): Promise<LogLeaseRow[]>;
  deleteLeases(batchIds: readonly string[]): Promise<number>;
  leases(consumer: string): Promise<LogLeaseRow[]>;
}

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

/**
 * Compare-and-set access to one kind of durable record.
 *
 * Every mutation is conditional on the record's generation and attempt so a
 * stale execution can never overwrite a replacement or a later attempt.
 */
export interface RecordStore<Row extends DurableRecord> {
  get(key: string): Promise<Row | undefined>;
  listDue(now: number, limit: number): Promise<Row[]>;
  nextPendingAt(): Promise<number | undefined>;
  insert(row: Row): Promise<boolean>;
  upsert(row: Row): Promise<void>;
  claimAttempt(
    key: string,
    generation: string,
    maxAttempts: number
  ): Promise<number | undefined>;
  settle(
    key: string,
    generation: string,
    attempt: number,
    patch: RecordPatch<Row>
  ): Promise<boolean>;
  exhaust(
    key: string,
    generation: string,
    maxAttempts: number,
    patch: RecordPatch<Row>
  ): Promise<boolean>;
  remove(key: string, generation: string, attempt: number): Promise<boolean>;
  /**
   * Deletes records created before the timestamp and returns how many were
   * removed. Backends may delete a bounded batch; callers loop until zero.
   */
  deleteCreatedBefore(before: number): Promise<number>;
}

export type PhysicalAlarm = Pick<
  DurableObjectTransaction,
  'getAlarm' | 'setAlarm' | 'deleteAlarm'
>;

export interface DeliveryStore extends RecordStore<DeliveryRow> {
  /** Allocates a sequence number from a durable counter, including an empty queue. */
  nextSeq(): Promise<number>;
  getMessage(key: string): Promise<FanoutMessageRow | undefined>;
  insertMessage(row: FanoutMessageRow): Promise<boolean>;
  /** Returns targets represented by persisted delivery rows. */
  listTargets(): Promise<string[]>;
  listDueForTarget(
    target: string,
    now: number,
    limit: number
  ): Promise<DeliveryRow[]>;
  /** Returns the exact number of active delivery children. */
  pendingCount(): Promise<number>;
}

export type RecordStores = {
  calls: RecordStore<CallRow>;
  alarms: RecordStore<AlarmRow>;
  deliveries: DeliveryStore;
};

/** Kinds the shared physical alarm can be reconciled against. */
export type RecordKind = keyof RecordStores;

/** Kept out of `RecordStores` because log records schedule no attempts. */
export type LogStores = { log: LogStore };

export type DurabilityStorageTransaction = RecordStores &
  LogStores & {
    physicalAlarm: PhysicalAlarm;
  };

export type DurabilityStorage = RecordStores &
  LogStores & {
    transaction<T>(
      callback: (transaction: DurabilityStorageTransaction) => Promise<T>
    ): Promise<T>;
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
