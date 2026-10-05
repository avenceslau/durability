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

export type RecordKind = keyof RecordStores;

export type DurabilityStorageTransaction = RecordStores & {
  physicalAlarm: PhysicalAlarm;
};

export type DurabilityStorage = RecordStores & {
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
