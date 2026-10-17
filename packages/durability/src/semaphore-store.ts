import { z } from 'zod';

export const grantRowSchema = z.object({
  grant_id: z.string(),
  client_id: z.string(),
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
 * Permits a semaphore has handed out. Grants and leases are small and bounded
 * by live clients, so aggregates are computed from `list()`.
 */
export class HolderStore {
  constructor(private readonly sql: SqlStorage) {}

  list(): GrantRow[] {
    return grantRowSchema
      .array()
      .parse(
        this.sql
          .exec('SELECT * FROM durability_semaphore_grants ORDER BY created_at')
          .toArray()
      );
  }

  get(grantId: string): GrantRow | undefined {
    return grantRowSchema
      .optional()
      .parse(
        this.sql
          .exec(
            'SELECT * FROM durability_semaphore_grants WHERE grant_id = ? LIMIT 1',
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
             WHERE claimed < permits
             ORDER BY expires_at ASC
             LIMIT 1`
          )
          .toArray()[0]
      )?.expires_at;
  }

  insert(row: GrantRow): boolean {
    return (
      this.sql
        .exec(
          `INSERT INTO durability_semaphore_grants (${grantColumns.join(', ')})
           VALUES (${grantColumns.map(() => '?').join(', ')})
           ON CONFLICT(grant_id) DO NOTHING
           RETURNING grant_id`,
          ...grantColumns.map((column) => row[column])
        )
        .toArray().length > 0
    );
  }

  update(row: GrantRow): void {
    this.sql.exec(
      `UPDATE durability_semaphore_grants
       SET permits = ?, claimed = ?, released = ?, expires_at = ?
       WHERE grant_id = ?`,
      row.permits,
      row.claimed,
      row.released,
      row.expires_at,
      row.grant_id
    );
  }

  remove(grantId: string): void {
    this.sql.exec(
      'DELETE FROM durability_semaphore_grants WHERE grant_id = ?',
      grantId
    );
  }

  listLeases(): LeaseRow[] {
    return leaseRowSchema
      .array()
      .parse(
        this.sql
          .exec('SELECT * FROM durability_semaphore_leases ORDER BY created_at')
          .toArray()
      );
  }

  getLease(leaseId: string): LeaseRow | undefined {
    return leaseRowSchema
      .optional()
      .parse(
        this.sql
          .exec(
            'SELECT * FROM durability_semaphore_leases WHERE lease_id = ? LIMIT 1',
            leaseId
          )
          .toArray()[0]
      );
  }

  insertLease(row: LeaseRow): boolean {
    return (
      this.sql
        .exec(
          `INSERT INTO durability_semaphore_leases (${leaseColumns.join(', ')})
           VALUES (${leaseColumns.map(() => '?').join(', ')})
           ON CONFLICT(lease_id) DO NOTHING
           RETURNING lease_id`,
          ...leaseColumns.map((column) => row[column])
        )
        .toArray().length > 0
    );
  }

  updateLease(row: LeaseRow): void {
    this.sql.exec(
      `UPDATE durability_semaphore_leases
       SET permits = ?, released = ?, expires_at = ?, retired = ?
       WHERE lease_id = ?`,
      row.permits,
      row.released,
      row.expires_at,
      row.retired,
      row.lease_id
    );
  }

  removeLease(leaseId: string): void {
    this.sql.exec(
      'DELETE FROM durability_semaphore_leases WHERE lease_id = ?',
      leaseId
    );
  }
}
