import { z } from 'zod';
import { traceFunction } from './dev.js';
import {
  DurableMemoLimitError,
  DurableMemoSerializationError,
} from './errors.js';
import { deserialize, serialize } from './serialization.js';
import {
  pendingGeneration,
  type AttemptRef,
  type DurableTable,
} from './storage.js';

/**
 * Runs `callback` once per key for a durable operation or named alarm
 * occurrence and persists its result, so a retried attempt returns the result
 * instead of running the callback again. A callback that throws persists
 * nothing and runs again on the next call with that key.
 *
 * Calls with the same key return the same result, within one attempt and
 * across attempts. A call for a key whose callback is still running rejects,
 * including one made from that callback. Results are deleted when the
 * operation, alarm occurrence, or fanout delivery settles.
 *
 * At most {@link maxMemosPerRecord} keys and {@link maxMemoBytes} per result;
 * exceeding either fails the work with `DurableMemoLimitError`.
 */
export type DurableMemoize = <T>(
  key: string,
  callback: () => T | Promise<T>
) => Promise<T>;

/** The most keys one operation, alarm occurrence, or fanout delivery may memoize. */
export const maxMemosPerRecord = 1_000;

/** The largest serialized memoized result, in UTF-8 bytes. */
export const maxMemoBytes = 1_048_576;

const memoLookupSchema = z.object({
  result: z.string().nullable(),
  owned: z.number().int(),
  saved: z.number().int(),
});

const supersededError = (key: string): Error =>
  new Error(
    `Memoized key ${JSON.stringify(key)} belongs to a superseded attempt`
  );

/** Memoization for one attempt; only that attempt may persist new results. */
export const createMemoize = (
  sql: SqlStorage,
  table: DurableTable,
  ref: AttemptRef
): DurableMemoize => {
  const running = new Set<string>();

  /** Serializes, checks, and writes a callback's result, then returns its persisted form. */
  const save = <T>(key: string, value: T): T => {
    let serialized: string;
    try {
      serialized = serialize(value);
    } catch (error) {
      throw new DurableMemoSerializationError(key, error);
    }
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > maxMemoBytes) {
      throw new DurableMemoLimitError(
        `Memoized result for ${JSON.stringify(key)} is ${bytes} bytes, over the ${maxMemoBytes}-byte limit`
      );
    }

    // A timed-out attempt that finishes late must not write over its successor.
    const written =
      sql
        .exec(
          `INSERT INTO durability_memos
             (owner, key, generation_id, memo_key, result)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM ${table.name}
             WHERE ${pendingGeneration(table)} AND attempt = ?
           )
           RETURNING memo_key`,
          table.name,
          ref.key,
          ref.generation,
          key,
          serialized,
          ref.key,
          ref.generation,
          ref.attempt
        )
        .toArray().length > 0;
    if (!written) {
      throw supersededError(key);
    }
    // Return what a replay would return, so later code sees one shape either way.
    return deserialize(serialized) as T;
  };

  // Everything up to the callback runs synchronously, so a concurrent call
  // with the same key sees either the saved result or this key as running.
  const run = async <T>(
    key: string,
    callback: () => T | Promise<T>
  ): Promise<T> => {
    if (typeof key !== 'string' || key === '') {
      throw new TypeError('Memoize keys must be non-empty strings');
    }

    const lookup = memoLookupSchema.parse(
      sql
        .exec(
          `SELECT
             (SELECT result FROM durability_memos
              WHERE owner = ? AND key = ? AND generation_id = ? AND memo_key = ?)
               AS result,
             EXISTS (
               SELECT 1 FROM ${table.name}
               WHERE ${pendingGeneration(table)} AND attempt = ?
             ) AS owned,
             (SELECT COUNT(*) FROM durability_memos
              WHERE owner = ? AND key = ? AND generation_id = ?) AS saved`,
          table.name,
          ref.key,
          ref.generation,
          key,
          ref.key,
          ref.generation,
          ref.attempt,
          table.name,
          ref.key,
          ref.generation
        )
        .toArray()[0]
    );
    if (lookup.result !== null) {
      return deserialize(lookup.result) as T;
    }
    // A rescheduled or purged attempt must not start side effects it can never record.
    if (lookup.owned === 0) {
      throw supersededError(key);
    }
    // Waiting on the running call would deadlock a callback that memoizes its own key.
    if (running.has(key)) {
      throw new Error(
        `Memoized key ${JSON.stringify(key)} is already running; await the first call instead`
      );
    }

    // Running callbacks count too: each may save a result when it settles.
    if (lookup.saved + running.size >= maxMemosPerRecord) {
      throw new DurableMemoLimitError(
        `Memoizing ${JSON.stringify(key)} would exceed ${maxMemosPerRecord} keys`
      );
    }

    // The key stays running through serialization, so a getter that memoizes
    // it again is rejected instead of running the callback a second time.
    running.add(key);
    try {
      return save(key, await callback());
    } finally {
      running.delete(key);
    }
  };

  return <T>(key: string, callback: () => T | Promise<T>): Promise<T> =>
    traceFunction('memoize', () => run(key, callback), {
      owner: table.name,
      key: ref.key,
      attempt: ref.attempt,
      memoKey: key,
    })();
};

const memoKeySchema = z.object({ memo_key: z.string() });

/** Keys a record's current generation has results for, in the order they were saved. */
export const memoizedKeys = (
  sql: SqlStorage,
  table: DurableTable,
  key: string,
  generation: string
): string[] =>
  memoKeySchema
    .array()
    .parse(
      sql
        .exec(
          `SELECT memo_key FROM durability_memos
           WHERE owner = ? AND key = ? AND generation_id = ?
           ORDER BY rowid`,
          table.name,
          key,
          generation
        )
        .toArray()
    )
    .map((row) => row.memo_key);

/** Deletes every memoized result of a record, whichever generation wrote it. */
export const deleteMemos = (
  sql: SqlStorage,
  table: DurableTable,
  key: string
): void => {
  sql.exec(
    'DELETE FROM durability_memos WHERE owner = ? AND key = ?',
    table.name,
    key
  );
};

/** Deletes memoized results whose record generation is no longer pending. */
export const deleteStaleMemos = (
  sql: SqlStorage,
  table: DurableTable
): void => {
  sql.exec(
    `DELETE FROM durability_memos
     WHERE owner = ? AND NOT EXISTS (
       SELECT 1 FROM ${table.name} AS record
       WHERE record.${table.key} = durability_memos.key
         AND record.generation_id = durability_memos.generation_id
         AND record.status = 'pending'
     )`,
    table.name
  );
};

const tableExists = (sql: SqlStorage, name: string): boolean =>
  sql
    .exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name)
    .toArray().length > 0;

/**
 * Deletes the memoized results of a helper whose schema was reverted. The
 * shared table stays for the other helper, but the removed records' results
 * must not.
 */
export const deleteMemosOfDroppedTable = (
  sql: SqlStorage,
  table: DurableTable
): void => {
  if (!tableExists(sql, 'durability_memos') || tableExists(sql, table.name)) {
    return;
  }
  sql.exec('DELETE FROM durability_memos WHERE owner = ?', table.name);
};
