import * as v from 'valibot';

export const queueItemRowSchema = v.object({
  id: v.string(),
  key: v.string(),
  grp: v.string(),
  payload: v.string(),
  /** queued: waiting for permits; claiming: counted against a grant, awaiting confirmation; admitted: running. */
  status: v.picklist(['queued', 'claiming', 'admitted']),
  grant_id: v.nullable(v.string()),
  lease_id: v.nullable(v.string()),
  created_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  admitted_at: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  /** 0 until `admit()` has returned for this item. */
  notified: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(1)),
  attempt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  next_attempt_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export type QueueItemRow = v.InferOutput<typeof queueItemRowSchema>;

export const queueGrantRowSchema = v.object({
  grant_id: v.string(),
  key: v.string(),
  grp: v.string(),
  permits: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /** Permits counted against this grant locally, as a high-water mark. */
  claimed: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /** Claims the holder has confirmed. */
  confirmed: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /** Items handed to `admit()` from this grant; never derived from live rows. */
  admitted: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  released: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  created_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export type QueueGrantRow = v.InferOutput<typeof queueGrantRowSchema>;

export const queueKeyRowSchema = v.object({
  key: v.string(),
  /** Earliest time the next permit request for this key may be sent. */
  next_request_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  queued: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export type QueueKeyRow = v.InferOutput<typeof queueKeyRowSchema>;

export const queueLeaseRowSchema = v.object({
  lease_id: v.string(),
  key: v.string(),
  grp: v.string(),
  permits: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /** Permits drawn so far; a drawn permit is never drawable again. */
  drawn: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  released: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  created_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  expires_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /** When to report the lease again while it has permits in use, so the holder keeps it. */
  renew_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /** Half the lease's lifetime at the holder, from its last refresh. */
  renew_ms: v.pipe(v.number(), v.safeInteger(), v.gtValue(0)),
  /** 1 once the holder has settled the stopped lease; until then it is reported again. */
  confirmed: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(1)),
});

export type QueueLeaseRow = v.InferOutput<typeof queueLeaseRowSchema>;

const queueItemColumns = v.keyof(queueItemRowSchema).options;
const queueGrantColumns = v.keyof(queueGrantRowSchema).options;
const queueLeaseColumns = v.keyof(queueLeaseRowSchema).options;
const statusCountSchema = v.object({
  status: queueItemRowSchema.entries.status,
  count: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

/**
 * One queue channel of a semaphore client: items, the grants it holds per
 * key, and per-key request pacing. Every query is scoped to the channel, so
 * queues sharing an object may reuse item IDs and keys. Due work is a key
 * whose request time has passed with items queued, an admitted item whose
 * `admit()` notification is outstanding, or a lease the holder must hear
 * about again.
 */
export class QueueStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly channel: string
  ) {}

  getItem(id: string): QueueItemRow | undefined {
    return this.items(
      `SELECT * FROM durability_semaphore_queue_items
       WHERE channel = ? AND id = ? LIMIT 1`,
      this.channel,
      id
    )[0];
  }

  insertItem(row: QueueItemRow): boolean {
    return (
      this.sql
        .exec(
          `INSERT INTO durability_semaphore_queue_items (channel, ${queueItemColumns.join(', ')})
           VALUES (?, ${queueItemColumns.map(() => '?').join(', ')})
           ON CONFLICT(channel, id) DO NOTHING
           RETURNING id`,
          this.channel,
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
       WHERE channel = ? AND id = ?`,
      row.status,
      row.grant_id,
      row.lease_id,
      row.admitted_at,
      row.notified,
      row.attempt,
      row.next_attempt_at,
      this.channel,
      row.id
    );
  }

  removeItem(id: string): void {
    this.sql.exec(
      'DELETE FROM durability_semaphore_queue_items WHERE channel = ? AND id = ?',
      this.channel,
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
       WHERE channel = ? AND key = ? AND status = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      this.channel,
      key,
      status,
      limit
    );
  }

  listItemsByGrant(grantId: string): QueueItemRow[] {
    return this.items(
      `SELECT * FROM durability_semaphore_queue_items
       WHERE channel = ? AND grant_id = ?
       ORDER BY created_at ASC, id ASC`,
      this.channel,
      grantId
    );
  }

  /** Notified items whose `finished` check is due; `next_attempt_at` holds the check time. */
  listCheckDue(now: number, limit: number): QueueItemRow[] {
    return this.items(
      `SELECT * FROM durability_semaphore_queue_items
       WHERE channel = ? AND status = 'admitted' AND notified = 1
         AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC
       LIMIT ?`,
      this.channel,
      now,
      limit
    );
  }

  listUnnotified(now: number, limit: number): QueueItemRow[] {
    return this.items(
      `SELECT * FROM durability_semaphore_queue_items
       WHERE channel = ? AND status = 'admitted' AND notified = 0
         AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC
       LIMIT ?`,
      this.channel,
      now,
      limit
    );
  }

  countItems(): Record<QueueItemRow['status'], number> {
    const counts = { queued: 0, claiming: 0, admitted: 0 };
    for (const row of v.parse(
      v.array(statusCountSchema),
      this.sql
        .exec(
          `SELECT status, COUNT(*) AS count FROM durability_semaphore_queue_items
           WHERE channel = ? GROUP BY status`,
          this.channel
        )
        .toArray()
    )) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  getGrant(grantId: string): QueueGrantRow | undefined {
    return v.parse(
      v.optional(queueGrantRowSchema),
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_queue_grants
             WHERE channel = ? AND grant_id = ? LIMIT 1`,
          this.channel,
          grantId
        )
        .toArray()[0]
    );
  }

  insertGrant(row: QueueGrantRow): boolean {
    return (
      this.sql
        .exec(
          `INSERT INTO durability_semaphore_queue_grants (channel, ${queueGrantColumns.join(', ')})
           VALUES (?, ${queueGrantColumns.map(() => '?').join(', ')})
           ON CONFLICT(channel, grant_id) DO NOTHING
           RETURNING grant_id`,
          this.channel,
          ...queueGrantColumns.map((column) => row[column])
        )
        .toArray().length > 0
    );
  }

  updateGrant(row: QueueGrantRow): void {
    this.sql.exec(
      `UPDATE durability_semaphore_queue_grants
       SET permits = ?, claimed = ?, confirmed = ?, admitted = ?, released = ?
       WHERE channel = ? AND grant_id = ?`,
      row.permits,
      row.claimed,
      row.confirmed,
      row.admitted,
      row.released,
      this.channel,
      row.grant_id
    );
  }

  removeGrant(grantId: string): void {
    this.sql.exec(
      'DELETE FROM durability_semaphore_queue_grants WHERE channel = ? AND grant_id = ?',
      this.channel,
      grantId
    );
  }

  listGrants(key: string): QueueGrantRow[] {
    return v.parse(
      v.array(queueGrantRowSchema),
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_queue_grants
           WHERE channel = ? AND key = ? ORDER BY created_at ASC, grant_id ASC`,
          this.channel,
          key
        )
        .toArray()
    );
  }

  getLease(leaseId: string): QueueLeaseRow | undefined {
    return v.parse(
      v.optional(queueLeaseRowSchema),
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_queue_leases
             WHERE channel = ? AND lease_id = ? LIMIT 1`,
          this.channel,
          leaseId
        )
        .toArray()[0]
    );
  }

  insertLease(row: QueueLeaseRow): boolean {
    return (
      this.sql
        .exec(
          `INSERT INTO durability_semaphore_queue_leases (channel, ${queueLeaseColumns.join(', ')})
           VALUES (?, ${queueLeaseColumns.map(() => '?').join(', ')})
           ON CONFLICT(channel, lease_id) DO NOTHING
           RETURNING lease_id`,
          this.channel,
          ...queueLeaseColumns.map((column) => row[column])
        )
        .toArray().length > 0
    );
  }

  updateLease(row: QueueLeaseRow): void {
    this.sql.exec(
      `UPDATE durability_semaphore_queue_leases
       SET permits = ?, drawn = ?, released = ?, expires_at = ?,
         renew_at = ?, renew_ms = ?, confirmed = ?
       WHERE channel = ? AND lease_id = ?`,
      row.permits,
      row.drawn,
      row.released,
      row.expires_at,
      row.renew_at,
      row.renew_ms,
      row.confirmed,
      this.channel,
      row.lease_id
    );
  }

  /**
   * Leases the holder must hear about again: those with permits in use, and
   * stopped ones it has not settled. Both stay counted at the holder until
   * reported, so a lost report must be repeated.
   */
  listRenewalsDue(now: number, limit: number): QueueLeaseRow[] {
    return v.parse(
      v.array(queueLeaseRowSchema),
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_queue_leases
           WHERE channel = ? AND confirmed = 0 AND renew_at <= ?
             AND (released < drawn OR expires_at <= ?)
           ORDER BY renew_at ASC LIMIT ?`,
          this.channel,
          now,
          now,
          limit
        )
        .toArray()
    );
  }

  /** Drops settled leases that stopped drawing before `before`. */
  removeSpentLeases(before: number): void {
    this.sql.exec(
      `DELETE FROM durability_semaphore_queue_leases
       WHERE channel = ? AND confirmed = 1 AND expires_at < ?
         AND released >= drawn`,
      this.channel,
      before
    );
  }

  listLeases(key: string): QueueLeaseRow[] {
    return v.parse(
      v.array(queueLeaseRowSchema),
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_queue_leases
           WHERE channel = ? AND key = ? ORDER BY created_at ASC, lease_id ASC`,
          this.channel,
          key
        )
        .toArray()
    );
  }

  getKey(key: string): QueueKeyRow | undefined {
    return v.parse(
      v.optional(queueKeyRowSchema),
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_queue_keys
             WHERE channel = ? AND key = ? LIMIT 1`,
          this.channel,
          key
        )
        .toArray()[0]
    );
  }

  upsertKey(row: QueueKeyRow): void {
    this.sql.exec(
      `INSERT INTO durability_semaphore_queue_keys
         (channel, key, next_request_at, queued)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel, key) DO UPDATE SET
         next_request_at = excluded.next_request_at, queued = excluded.queued
       WHERE next_request_at != excluded.next_request_at
          OR queued != excluded.queued`,
      this.channel,
      row.key,
      row.next_request_at,
      row.queued
    );
  }

  removeKey(key: string): void {
    this.sql.exec(
      'DELETE FROM durability_semaphore_queue_keys WHERE channel = ? AND key = ?',
      this.channel,
      key
    );
  }

  listDueKeys(now: number): QueueKeyRow[] {
    return v.parse(
      v.array(queueKeyRowSchema),
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_queue_keys
           WHERE channel = ? AND queued > 0 AND next_request_at <= ?
           ORDER BY next_request_at ASC`,
          this.channel,
          now
        )
        .toArray()
    );
  }

  nextPendingAt({
    unnotified,
    notified,
  }: {
    unnotified: boolean;
    notified: boolean;
  }): number | undefined {
    // An idle lease is due when it stops at its expiry, not before.
    const at = this.sql
      .exec(
        `SELECT MIN(at) AS at FROM (
           SELECT (
             SELECT next_request_at FROM durability_semaphore_queue_keys
             WHERE channel = ? AND queued > 0
             ORDER BY next_request_at ASC LIMIT 1
           ) AS at
           UNION ALL
           SELECT (
             SELECT next_attempt_at FROM durability_semaphore_queue_items
             WHERE channel = ? AND status = 'admitted'
               AND ((notified = 0 AND ?) OR (notified = 1 AND ?))
             ORDER BY next_attempt_at ASC LIMIT 1
           ) AS at
           UNION ALL
           SELECT MIN(CASE WHEN released < drawn THEN renew_at
                           ELSE MAX(renew_at, expires_at) END) AS at
           FROM durability_semaphore_queue_leases
           WHERE channel = ? AND confirmed = 0
         )`,
        this.channel,
        this.channel,
        unnotified ? 1 : 0,
        notified ? 1 : 0,
        this.channel
      )
      .toArray()[0]?.['at'];
    return typeof at === 'number' ? at : undefined;
  }

  private items(query: string, ...bindings: SqlStorageValue[]): QueueItemRow[] {
    return v.parse(
      v.array(queueItemRowSchema),
      this.sql.exec(query, ...bindings).toArray()
    );
  }
}
