import { z } from 'zod';

/**
 * A table of durable records: a primary key column plus `generation_id`,
 * `status`, `attempt`, `next_attempt_at`, and `created_at`.
 */
export type DurableTable = {
  name: string;
  key: string;
};

/** One attempt of one record generation. */
export type AttemptRef = {
  key: string;
  generation: string;
  attempt: number;
};

const attemptRowSchema = z.object({
  attempt: z.number().int().nonnegative(),
});

// Every write is conditional on the record's generation and pending status, so a
// stale execution can never overwrite a replacement or a later attempt.
const pendingGeneration = (table: DurableTable): string =>
  `${table.key} = ? AND generation_id = ? AND status = 'pending'`;

/** Starts the next attempt and returns its number, unless the generation is gone or out of attempts. */
export const claimAttempt = (
  sql: SqlStorage,
  table: DurableTable,
  key: string,
  generation: string,
  maxAttempts: number
): number | undefined =>
  attemptRowSchema.optional().parse(
    sql
      .exec(
        `UPDATE ${table.name}
         SET attempt = attempt + 1
         WHERE ${pendingGeneration(table)} AND attempt < ?
         RETURNING attempt`,
        key,
        generation,
        maxAttempts
      )
      .toArray()[0]
  )?.attempt;

/**
 * Applies `assignments` (a SQL `SET` list) to the record if the attempt still
 * owns it, and reports whether it did.
 */
export const updateAttempt = (
  sql: SqlStorage,
  table: DurableTable,
  ref: AttemptRef,
  assignments: string,
  ...values: SqlStorageValue[]
): boolean =>
  sql
    .exec(
      `UPDATE ${table.name}
       SET ${assignments}
       WHERE ${pendingGeneration(table)} AND attempt = ?
       RETURNING ${table.key}`,
      ...values,
      ref.key,
      ref.generation,
      ref.attempt
    )
    .toArray().length > 0;

/** Deletes the record if the attempt still owns it, and reports whether it did. */
export const deleteAttempt = (
  sql: SqlStorage,
  table: DurableTable,
  ref: AttemptRef
): boolean =>
  sql
    .exec(
      `DELETE FROM ${table.name}
       WHERE ${pendingGeneration(table)} AND attempt = ?
       RETURNING ${table.key}`,
      ref.key,
      ref.generation,
      ref.attempt
    )
    .toArray().length > 0;

/** Fails a generation that has used every attempt and returns its attempt count. */
export const exhaustAttempts = (
  sql: SqlStorage,
  table: DurableTable,
  key: string,
  generation: string,
  maxAttempts: number,
  error: { name: string; message: string }
): number | undefined =>
  attemptRowSchema.optional().parse(
    sql
      .exec(
        `UPDATE ${table.name}
         SET status = 'failed', last_error = ?, last_error_name = ?
         WHERE ${pendingGeneration(table)} AND attempt >= ?
         RETURNING attempt`,
        error.message,
        error.name,
        key,
        generation,
        maxAttempts
      )
      .toArray()[0]
  )?.attempt;
