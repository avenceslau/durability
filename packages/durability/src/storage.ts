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

/**
 * Fails a pending generation without starting an attempt and returns its
 * attempt count. Used for deterministic input errors that must not consume the
 * handler's retry budget.
 */
export const failPending = (
  sql: SqlStorage,
  table: DurableTable,
  key: string,
  generation: string,
  error: { name: string; message: string }
): number | undefined =>
  attemptRowSchema.optional().parse(
    sql
      .exec(
        `UPDATE ${table.name}
         SET status = 'failed', last_error = ?, last_error_name = ?
         WHERE ${pendingGeneration(table)}
         RETURNING attempt`,
        error.message,
        error.name,
        key,
        generation
      )
      .toArray()[0]
  )?.attempt;

export type CreatedQuery = {
  limit: number;
  /** Opaque position from a previous page's `next`. */
  after?: string | undefined;
  status?: string | undefined;
  name?: string | undefined;
};

export type CreatedPage = {
  rows: Record<string, SqlStorageValue>[];
  /** Present only when more records follow. */
  next?: string;
};

const createdCursorSchema = z.tuple([
  z.number().int().nonnegative(),
  z.string(),
]);

/**
 * Lists records in creation order, then by key, filtered by status and by the
 * value of `nameColumn`.
 */
export const listCreated = (
  sql: SqlStorage,
  table: DurableTable,
  nameColumn: string,
  query: CreatedQuery
): CreatedPage => {
  const [createdAt, key] =
    query.after === undefined
      ? [-1, '']
      : createdCursorSchema.parse(JSON.parse(query.after));
  const status = query.status ?? null;
  const name = query.name ?? null;
  const found = sql
    .exec(
      `SELECT * FROM ${table.name}
       WHERE (? IS NULL OR status = ?)
         AND (? IS NULL OR ${nameColumn} = ?)
         AND (created_at > ? OR (created_at = ? AND ${table.key} > ?))
       ORDER BY created_at ASC, ${table.key} ASC
       LIMIT ?`,
      status,
      status,
      name,
      name,
      createdAt,
      createdAt,
      key,
      query.limit + 1
    )
    .toArray();

  const rows = found.slice(0, query.limit);
  const last = rows[rows.length - 1];
  if (found.length <= query.limit || !last) {
    return { rows };
  }
  return {
    rows,
    next: JSON.stringify([last['created_at'], last[table.key]]),
  };
};
