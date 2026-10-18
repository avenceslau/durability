import { z } from 'zod';

export const queueItemRowSchema = z.object({
  id: z.string(),
  key: z.string(),
  grp: z.string(),
  payload: z.string(),
  /** queued: waiting for permits; claiming: counted against a grant, awaiting confirmation; admitted: running. */
  status: z.enum(['queued', 'claiming', 'admitted']),
  grant_id: z.string().nullable(),
  lease_id: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
  admitted_at: z.number().int().nonnegative().nullable(),
  /** 0 until `admit()` has returned for this item. */
  notified: z.number().int().min(0).max(1),
  attempt: z.number().int().nonnegative(),
  next_attempt_at: z.number().int().nonnegative(),
});

export type QueueItemRow = z.infer<typeof queueItemRowSchema>;

export const queueGrantRowSchema = z.object({
  grant_id: z.string(),
  key: z.string(),
  grp: z.string(),
  permits: z.number().int().nonnegative(),
  /** Permits counted against this grant locally, as a high-water mark. */
  claimed: z.number().int().nonnegative(),
  /** Claims the holder has confirmed. */
  confirmed: z.number().int().nonnegative(),
  /** Items handed to `admit()` from this grant; never derived from live rows. */
  admitted: z.number().int().nonnegative(),
  released: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
});

export type QueueGrantRow = z.infer<typeof queueGrantRowSchema>;

export const queueKeyRowSchema = z.object({
  key: z.string(),
  /** Earliest time the next permit request for this key may be sent. */
  next_request_at: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
});

export type QueueKeyRow = z.infer<typeof queueKeyRowSchema>;

export const queueLeaseRowSchema = z.object({
  lease_id: z.string(),
  key: z.string(),
  grp: z.string(),
  permits: z.number().int().nonnegative(),
  /** Permits drawn so far; a drawn permit is never drawable again. */
  drawn: z.number().int().nonnegative(),
  released: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  /** When to report the lease again while it has permits in use, so the holder keeps it. */
  renew_at: z.number().int().nonnegative(),
  /** Half the lease's lifetime at the holder, from its last refresh. */
  renew_ms: z.number().int().positive(),
});

export type QueueLeaseRow = z.infer<typeof queueLeaseRowSchema>;

const queueItemColumns = queueItemRowSchema.keyof().options;
const queueGrantColumns = queueGrantRowSchema.keyof().options;
const queueLeaseColumns = queueLeaseRowSchema.keyof().options;
const statusCountSchema = z.object({
  status: queueItemRowSchema.shape.status,
  count: z.number().int().nonnegative(),
});

/**
 * A semaphore client's queue: items, the grants it holds per key, and per-key
 * request pacing. Due work is a key whose request time has passed with items
 * queued, an admitted item whose `admit()` notification is outstanding, or a
 * lease with permits in use whose renewal is due.
 */
export class QueueStore {
  constructor(private readonly sql: SqlStorage) {}

  getItem(id: string): QueueItemRow | undefined {
    return this.items(
      'SELECT * FROM durability_semaphore_queue_items WHERE id = ? LIMIT 1',
      id
    )[0];
  }

  insertItem(row: QueueItemRow): boolean {
    return (
      this.sql
        .exec(
          `INSERT INTO durability_semaphore_queue_items (${queueItemColumns.join(', ')})
           VALUES (${queueItemColumns.map(() => '?').join(', ')})
           ON CONFLICT(id) DO NOTHING
           RETURNING id`,
          ...queueItemColumns.map((column) => row[column])
        )
        .toArray().length > 0
    );
  }

  updateItem(row: QueueItemRow): void {
    this.sql.exec(
      `UPDATE durability_semaphore_queue_items
       SET status = ?, grant_id = ?, lease_id = ?, admitted_at = ?, notified = ?,
         attempt = ?, next_attempt_at = ?
       WHERE id = ?`,
      row.status,
      row.grant_id,
      row.lease_id,
      row.admitted_at,
      row.notified,
      row.attempt,
      row.next_attempt_at,
      row.id
    );
  }

  removeItem(id: string): void {
    this.sql.exec(
      'DELETE FROM durability_semaphore_queue_items WHERE id = ?',
      id
    );
  }

  listItems(
    key: string,
    status: QueueItemRow['status'],
    limit: number
  ): QueueItemRow[] {
    return this.items(
      `SELECT * FROM durability_semaphore_queue_items
       WHERE key = ? AND status = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      key,
      status,
      limit
    );
  }

  listItemsByGrant(grantId: string): QueueItemRow[] {
    return this.items(
      `SELECT * FROM durability_semaphore_queue_items
       WHERE grant_id = ?
       ORDER BY created_at ASC, id ASC`,
      grantId
    );
  }

  /** Notified items whose `finished` check is due; `next_attempt_at` holds the check time. */
  listCheckDue(now: number, limit: number): QueueItemRow[] {
    return this.items(
      `SELECT * FROM durability_semaphore_queue_items
       WHERE status = 'admitted' AND notified = 1 AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC
       LIMIT ?`,
      now,
      limit
    );
  }

  listUnnotified(now: number, limit: number): QueueItemRow[] {
    return this.items(
      `SELECT * FROM durability_semaphore_queue_items
       WHERE status = 'admitted' AND notified = 0 AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC
       LIMIT ?`,
      now,
      limit
    );
  }

  countItems(): Record<QueueItemRow['status'], number> {
    const counts = { queued: 0, claiming: 0, admitted: 0 };
    for (const row of statusCountSchema.array().parse(
      this.sql
        .exec(
          `SELECT status, COUNT(*) AS count FROM durability_semaphore_queue_items
           GROUP BY status`
        )
        .toArray()
    )) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  getGrant(grantId: string): QueueGrantRow | undefined {
    return queueGrantRowSchema
      .optional()
      .parse(
        this.sql
          .exec(
            'SELECT * FROM durability_semaphore_queue_grants WHERE grant_id = ? LIMIT 1',
            grantId
          )
          .toArray()[0]
      );
  }

  insertGrant(row: QueueGrantRow): boolean {
    return (
      this.sql
        .exec(
          `INSERT INTO durability_semaphore_queue_grants (${queueGrantColumns.join(', ')})
           VALUES (${queueGrantColumns.map(() => '?').join(', ')})
           ON CONFLICT(grant_id) DO NOTHING
           RETURNING grant_id`,
          ...queueGrantColumns.map((column) => row[column])
        )
        .toArray().length > 0
    );
  }

  updateGrant(row: QueueGrantRow): void {
    this.sql.exec(
      `UPDATE durability_semaphore_queue_grants
       SET permits = ?, claimed = ?, confirmed = ?, admitted = ?, released = ?
       WHERE grant_id = ?`,
      row.permits,
      row.claimed,
      row.confirmed,
      row.admitted,
      row.released,
      row.grant_id
    );
  }

  removeGrant(grantId: string): void {
    this.sql.exec(
      'DELETE FROM durability_semaphore_queue_grants WHERE grant_id = ?',
      grantId
    );
  }

  listGrants(key: string): QueueGrantRow[] {
    return queueGrantRowSchema.array().parse(
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_queue_grants
           WHERE key = ? ORDER BY created_at ASC, grant_id ASC`,
          key
        )
        .toArray()
    );
  }

  getLease(leaseId: string): QueueLeaseRow | undefined {
    return queueLeaseRowSchema
      .optional()
      .parse(
        this.sql
          .exec(
            'SELECT * FROM durability_semaphore_queue_leases WHERE lease_id = ? LIMIT 1',
            leaseId
          )
          .toArray()[0]
      );
  }

  insertLease(row: QueueLeaseRow): boolean {
    return (
      this.sql
        .exec(
          `INSERT INTO durability_semaphore_queue_leases (${queueLeaseColumns.join(', ')})
           VALUES (${queueLeaseColumns.map(() => '?').join(', ')})
           ON CONFLICT(lease_id) DO NOTHING
           RETURNING lease_id`,
          ...queueLeaseColumns.map((column) => row[column])
        )
        .toArray().length > 0
    );
  }

  updateLease(row: QueueLeaseRow): void {
    this.sql.exec(
      `UPDATE durability_semaphore_queue_leases
       SET permits = ?, drawn = ?, released = ?, expires_at = ?,
         renew_at = ?, renew_ms = ?
       WHERE lease_id = ?`,
      row.permits,
      row.drawn,
      row.released,
      row.expires_at,
      row.renew_at,
      row.renew_ms,
      row.lease_id
    );
  }

  /** Leases with permits in use whose report to the holder is due. */
  listRenewalsDue(now: number, limit: number): QueueLeaseRow[] {
    return queueLeaseRowSchema.array().parse(
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_queue_leases
           WHERE released < drawn AND renew_at <= ?
           ORDER BY renew_at ASC LIMIT ?`,
          now,
          limit
        )
        .toArray()
    );
  }

  /** Drops leases that stopped drawing before `before` and have every drawn permit back. */
  removeSpentLeases(before: number): void {
    this.sql.exec(
      `DELETE FROM durability_semaphore_queue_leases
       WHERE expires_at < ? AND released >= drawn`,
      before
    );
  }

  listLeases(key: string): QueueLeaseRow[] {
    return queueLeaseRowSchema.array().parse(
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_queue_leases
           WHERE key = ? ORDER BY created_at ASC, lease_id ASC`,
          key
        )
        .toArray()
    );
  }

  getKey(key: string): QueueKeyRow | undefined {
    return queueKeyRowSchema
      .optional()
      .parse(
        this.sql
          .exec(
            'SELECT * FROM durability_semaphore_queue_keys WHERE key = ? LIMIT 1',
            key
          )
          .toArray()[0]
      );
  }

  upsertKey(row: QueueKeyRow): void {
    this.sql.exec(
      `INSERT INTO durability_semaphore_queue_keys (key, next_request_at, queued)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         next_request_at = excluded.next_request_at, queued = excluded.queued`,
      row.key,
      row.next_request_at,
      row.queued
    );
  }

  removeKey(key: string): void {
    this.sql.exec(
      'DELETE FROM durability_semaphore_queue_keys WHERE key = ?',
      key
    );
  }

  listDueKeys(now: number): QueueKeyRow[] {
    return queueKeyRowSchema.array().parse(
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_queue_keys
           WHERE queued > 0 AND next_request_at <= ?
           ORDER BY next_request_at ASC`,
          now
        )
        .toArray()
    );
  }

  nextPendingAt(checksFinished: boolean): number | undefined {
    const candidates = [
      this.sql
        .exec(
          `SELECT next_request_at AS at FROM durability_semaphore_queue_keys
           WHERE queued > 0 ORDER BY next_request_at ASC LIMIT 1`
        )
        .toArray()[0]?.['at'],
      this.sql
        .exec(
          `SELECT next_attempt_at AS at FROM durability_semaphore_queue_items
           WHERE status = 'admitted' AND (notified = 0 OR ?)
           ORDER BY next_attempt_at ASC LIMIT 1`,
          checksFinished ? 1 : 0
        )
        .toArray()[0]?.['at'],
      this.sql
        .exec(
          `SELECT renew_at AS at FROM durability_semaphore_queue_leases
           WHERE released < drawn ORDER BY renew_at ASC LIMIT 1`
        )
        .toArray()[0]?.['at'],
    ].filter((value): value is number => typeof value === 'number');
    return candidates.length === 0 ? undefined : Math.min(...candidates);
  }

  private items(query: string, ...bindings: SqlStorageValue[]): QueueItemRow[] {
    return queueItemRowSchema
      .array()
      .parse(this.sql.exec(query, ...bindings).toArray());
  }
}
