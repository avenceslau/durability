import { z } from 'zod';

/**
 * Messages between a semaphore client and the Durable Object holding the
 * limit. Both sides tolerate unknown fields so mixed deployments keep working;
 * new fields must be optional.
 */

const nonNegative = z.number().int().nonnegative();
const nonEmpty = z.string().min(1);

/** Bounds one message's work so a client cannot monopolize the holder. */
export const maxDemandEntries = 100;
export const maxGrantReports = 200;

/** Cumulative counts for one grant. Replaying a report can never free capacity twice. */
export const grantReportSchema = z.object({
  grantId: nonEmpty,
  /** Permits of this grant the client has used, as a high-water mark. */
  claimed: nonNegative,
  /** Claimed permits the client has returned, as a high-water mark. */
  released: nonNegative,
});
export type GrantReport = z.infer<typeof grantReportSchema>;

/** Cumulative counts for one lease the client holds. */
export const leaseReportSchema = z.object({
  leaseId: nonEmpty,
  /** Permits drawn locally so far, as a high-water mark. */
  drawn: nonNegative,
  /** Drawn permits returned, as a high-water mark. */
  released: nonNegative,
  /** The client stopped drawing: the lease's undrawn permits are returned. */
  retired: z.boolean().optional(),
});
export type LeaseReport = z.infer<typeof leaseReportSchema>;

export const leaseGrantSchema = z.object({
  leaseId: nonEmpty,
  group: z.string(),
  permits: nonNegative,
  /** `expiresAt <= now` retires the lease: stop drawing immediately. */
  expiresAt: nonNegative,
});
export type LeaseGrant = z.infer<typeof leaseGrantSchema>;

export const permitRequestSchema = z.object({
  type: z.literal('request'),
  v: z.literal(1),
  clientId: nonEmpty,
  /** Sparse demand per group with the oldest queued time, for FIFO allocation. */
  demand: z
    .object({
      group: z.string(),
      count: z.number().int().positive(),
      oldestAt: nonNegative,
    })
    .array()
    .max(maxDemandEntries),
  grants: grantReportSchema.array().max(maxGrantReports),
  leases: leaseReportSchema.array().max(maxGrantReports).optional(),
});
export type PermitRequest = z.infer<typeof permitRequestSchema>;

export const permitSyncSchema = z.object({
  type: z.literal('sync'),
  v: z.literal(1),
  clientId: nonEmpty,
  grants: grantReportSchema.array().max(maxGrantReports),
  leases: leaseReportSchema.array().max(maxGrantReports).optional(),
});
export type PermitSync = z.infer<typeof permitSyncSchema>;

export const semaphoreRequestSchema = z.discriminatedUnion('type', [
  permitRequestSchema,
  permitSyncSchema,
]);
export type SemaphoreRequest = z.infer<typeof semaphoreRequestSchema>;

export const semaphoreBlockedReasonSchema = z.enum([
  'group_limit',
  'limit',
  'limit_resolution_error',
  'not_permitted',
]);
export type SemaphoreBlockedReason = z.infer<
  typeof semaphoreBlockedReasonSchema
>;

export const grantResultSchema = z.object({
  grantId: nonEmpty,
  /** Server-clamped claim high-water mark; the client admits only up to this. */
  claimed: nonNegative,
  status: z.enum(['ok', 'not_found', 'expired']),
});
export type GrantResult = z.infer<typeof grantResultSchema>;

export const permitGrantSchema = z.object({
  type: z.literal('grant'),
  v: z.literal(1),
  grants: z
    .object({
      grantId: nonEmpty,
      group: z.string(),
      permits: z.number().int().positive(),
    })
    .array(),
  blocked: z
    .object({ group: z.string(), reason: semaphoreBlockedReasonSchema })
    .array(),
  /** The client must not send another request before this. */
  nextRequestAt: nonNegative,
  grantResults: grantResultSchema.array(),
  leases: leaseGrantSchema.array().optional(),
  /** Demand went unserved: return undrawn lease permits in groups with nothing queued. */
  contended: z.boolean().optional(),
});
export type PermitGrant = z.infer<typeof permitGrantSchema>;

export const permitSyncResultSchema = z.object({
  type: z.literal('synced'),
  v: z.literal(1),
  grantResults: grantResultSchema.array(),
  leases: leaseGrantSchema.array().optional(),
  contended: z.boolean().optional(),
});
export type PermitSyncResult = z.infer<typeof permitSyncResultSchema>;

export const semaphoreResponseSchema = z.discriminatedUnion('type', [
  permitGrantSchema,
  permitSyncResultSchema,
]);
export type SemaphoreResponse = z.infer<typeof semaphoreResponseSchema>;
