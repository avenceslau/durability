import * as v from 'valibot';

export const grantRowSchema = v.object({
  grant_id: v.string(),
  client_id: v.string(),
  /** The client's queue channel; `clientId` alone does not identify a client. */
  client_channel: v.string(),
  grp: v.string(),
  permits: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  claimed: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  released: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  created_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /** Unclaimed permits are reclaimed once this passes. */
  expires_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export type GrantRow = v.InferOutput<typeof grantRowSchema>;

/** Permits a client may draw locally without a round trip; held by the holder. */
export const leaseRowSchema = v.object({
  lease_id: v.string(),
  client_id: v.string(),
  client_channel: v.string(),
  grp: v.string(),
  permits: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /** Drawn permits the client has returned, as a high-water mark. */
  released: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  created_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /** Refreshed by every report; the lease is swept once this passes. */
  expires_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  /** 1 once no more permits may be drawn; footprint stays until released. */
  retired: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(1)),
});

export type LeaseRow = v.InferOutput<typeof leaseRowSchema>;

const grantColumns = v.keyof(grantRowSchema).options;
const leaseColumns = v.keyof(leaseRowSchema).options;

/**
 * Permits one semaphore channel has handed out. Every query is scoped to the
 * channel, so semaphores sharing an object never see each other's grants or
 * leases. Grants and leases are small and bounded by live clients, so
 * aggregates are computed from `list()`.
 */
export class HolderStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly channel: string
  ) {}

  list(): GrantRow[] {
    return v.parse(
      v.array(grantRowSchema),
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_grants
             WHERE channel = ? ORDER BY created_at`,
          this.channel
        )
        .toArray()
    );
  }

  get(grantId: string): GrantRow | undefined {
    return v.parse(
      v.optional(grantRowSchema),
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_grants
             WHERE channel = ? AND grant_id = ? LIMIT 1`,
          this.channel,
          grantId
        )
        .toArray()[0]
    );
  }

  nextPendingAt(): number | undefined {
    return v.parse(
      v.optional(v.pick(grantRowSchema, ['expires_at'])),
      this.sql
        .exec(
          `SELECT expires_at FROM durability_semaphore_grants
           WHERE channel = ? AND claimed < permits
           ORDER BY expires_at ASC
           LIMIT 1`,
          this.channel
        )
        .toArray()[0]
    )?.expires_at;
  }

  insert(row: GrantRow): boolean {
    return (
      this.sql
        .exec(
          `INSERT INTO durability_semaphore_grants (channel, ${grantColumns.join(', ')})
           VALUES (?, ${grantColumns.map(() => '?').join(', ')})
           ON CONFLICT(channel, grant_id) DO NOTHING
           RETURNING grant_id`,
          this.channel,
          ...grantColumns.map((column) => row[column])
        )
        .toArray().length > 0
    );
  }

  update(row: GrantRow): void {
    this.sql.exec(
      `UPDATE durability_semaphore_grants
       SET permits = ?, claimed = ?, released = ?, expires_at = ?
       WHERE channel = ? AND grant_id = ?`,
      row.permits,
      row.claimed,
      row.released,
      row.expires_at,
      this.channel,
      row.grant_id
    );
  }

  remove(grantId: string): void {
    this.sql.exec(
      'DELETE FROM durability_semaphore_grants WHERE channel = ? AND grant_id = ?',
      this.channel,
      grantId
    );
  }

  listLeases(): LeaseRow[] {
    return v.parse(
      v.array(leaseRowSchema),
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_leases
             WHERE channel = ? ORDER BY created_at`,
          this.channel
        )
        .toArray()
    );
  }

  getLease(leaseId: string): LeaseRow | undefined {
    return v.parse(
      v.optional(leaseRowSchema),
      this.sql
        .exec(
          `SELECT * FROM durability_semaphore_leases
             WHERE channel = ? AND lease_id = ? LIMIT 1`,
          this.channel,
          leaseId
        )
        .toArray()[0]
    );
  }

  insertLease(row: LeaseRow): boolean {
    return (
      this.sql
        .exec(
          `INSERT INTO durability_semaphore_leases (channel, ${leaseColumns.join(', ')})
           VALUES (?, ${leaseColumns.map(() => '?').join(', ')})
           ON CONFLICT(channel, lease_id) DO NOTHING
           RETURNING lease_id`,
          this.channel,
          ...leaseColumns.map((column) => row[column])
        )
        .toArray().length > 0
    );
  }

  updateLease(row: LeaseRow): void {
    this.sql.exec(
      `UPDATE durability_semaphore_leases
       SET permits = ?, released = ?, expires_at = ?, retired = ?
       WHERE channel = ? AND lease_id = ?`,
      row.permits,
      row.released,
      row.expires_at,
      row.retired,
      this.channel,
      row.lease_id
    );
  }

  removeLease(leaseId: string): void {
    this.sql.exec(
      'DELETE FROM durability_semaphore_leases WHERE channel = ? AND lease_id = ?',
      this.channel,
      leaseId
    );
  }
}
