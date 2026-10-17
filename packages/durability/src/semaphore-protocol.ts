import { z } from 'zod';

/**
 * Messages between a semaphore client and the Durable Object holding the
 * limit. Both sides tolerate unknown fields so mixed deployments keep working;
 * new fields must be optional.
 */

const nonNegative = z.number().int().nonnegative();
const nonEmpty = z.string().min(1);

/** Cumulative counts for one grant. Replaying a report can never free capacity twice. */
export const grantReportSchema = z.object({
  grantId: nonEmpty,
  /** Permits of this grant the client has used, as a high-water mark. */
  claimed: nonNegative,
  /** Claimed permits the client has returned, as a high-water mark. */
  released: nonNegative,
});
export type GrantReport = z.infer<typeof grantReportSchema>;

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
    .array(),
  grants: grantReportSchema.array(),
});
export type PermitRequest = z.infer<typeof permitRequestSchema>;

export const permitSyncSchema = z.object({
  type: z.literal('sync'),
  v: z.literal(1),
  clientId: nonEmpty,
  grants: grantReportSchema.array(),
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
});
export type PermitGrant = z.infer<typeof permitGrantSchema>;

export const permitSyncResultSchema = z.object({
  type: z.literal('synced'),
  v: z.literal(1),
  grantResults: grantResultSchema.array(),
});
export type PermitSyncResult = z.infer<typeof permitSyncResultSchema>;

export const semaphoreResponseSchema = z.discriminatedUnion('type', [
  permitGrantSchema,
  permitSyncResultSchema,
]);
export type SemaphoreResponse = z.infer<typeof semaphoreResponseSchema>;
