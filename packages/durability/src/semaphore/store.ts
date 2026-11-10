import { z } from 'zod';

export const grantRowSchema = z.object({
  grant_id: z.string(),
  client_id: z.string(),
  /** The client's queue channel; `clientId` alone does not identify a client. */
  client_channel: z.string(),
  grp: z.string(),
  permits: z.number().int().nonnegative(),
  claimed: z.number().int().nonnegative(),
  released: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  /** Unclaimed permits are reclaimed once this passes. */
  expires_at: z.number().int().nonnegative(),
});

export type GrantRow = z.infer<typeof grantRowSchema>;

/** Permits a client may draw locally without a round trip; held by the holder. */
export const leaseRowSchema = z.object({
  lease_id: z.string(),
  client_id: z.string(),
  client_channel: z.string(),
  grp: z.string(),
  permits: z.number().int().nonnegative(),
  /** Drawn permits the client has returned, as a high-water mark. */
  released: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  /** Refreshed by every report; the lease is swept once this passes. */
  expires_at: z.number().int().nonnegative(),
  /** 1 once no more permits may be drawn; footprint stays until released. */
  retired: z.number().int().min(0).max(1),
});

export type LeaseRow = z.infer<typeof leaseRowSchema>;

const grantColumns = grantRowSchema.keyof().options;
const leaseColumns = leaseRowSchema.keyof().options;

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
    return grantRowSchema.array().parse(
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
    return grantRowSchema.optional().parse(
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
    return grantRowSchema
      .pick({ expires_at: true })
      .optional()
      .parse(
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
    return leaseRowSchema.array().parse(
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
    return leaseRowSchema.optional().parse(
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
