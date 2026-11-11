import * as v from 'valibot';

/**
 * Messages between a semaphore client and the Durable Object holding the
 * limit. Default clients keep version 1. Named queues use version 2 so old
 * holders reject them before allocating grants or leases under the wrong
 * identity. Extra fields remain tolerated within each version.
 */

const nonNegative = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const nonEmpty = v.pipe(v.string(), v.minLength(1));
const protocolVersion = v.picklist([1, 2]);

const versionMatchesChannel = <
  Message extends { v: 1 | 2; clientChannel?: string | undefined },
>(
  message: Message
): boolean => message.v === (message.clientChannel === undefined ? 1 : 2);

const channelVersionError =
  'Client channel does not match semaphore protocol version';

/**
 * Which queue of the client object sent the message. Version 1 omits it;
 * version 2 requires it. Older clients therefore keep their identity.
 */
const clientChannel = v.optional(nonEmpty);

/** Bounds one message's work so a client cannot monopolize the holder. */
export const maxDemandEntries = 100;
export const maxGrantReports = 200;

/** Cumulative counts for one grant. Replaying a report can never free capacity twice. */
export const grantReportSchema = v.object({
  grantId: nonEmpty,
  /** Permits of this grant the client has used, as a high-water mark. */
  claimed: nonNegative,
  /** Claimed permits the client has returned, as a high-water mark. */
  released: nonNegative,
});
export type GrantReport = v.InferOutput<typeof grantReportSchema>;

/** Cumulative counts for one lease the client holds. */
export const leaseReportSchema = v.object({
  leaseId: nonEmpty,
  /** Permits drawn locally so far, as a high-water mark. */
  drawn: nonNegative,
  /** Drawn permits returned, as a high-water mark. */
  released: nonNegative,
  /** The client stopped drawing: the lease's undrawn permits are returned. */
  retired: v.optional(v.boolean()),
});
export type LeaseReport = v.InferOutput<typeof leaseReportSchema>;

export const leaseGrantSchema = v.object({
  leaseId: nonEmpty,
  group: v.string(),
  permits: nonNegative,
  /** `expiresAt <= now` retires the lease: stop drawing immediately. */
  expiresAt: nonNegative,
});
export type LeaseGrant = v.InferOutput<typeof leaseGrantSchema>;

export const permitRequestSchema = v.pipe(
  v.object({
    type: v.literal('request'),
    v: protocolVersion,
    clientId: nonEmpty,
    clientChannel,
    /** Sparse demand per group with the oldest queued time, for FIFO allocation. */
    demand: v.pipe(
      v.array(
        v.object({
          group: v.string(),
          count: v.pipe(v.number(), v.safeInteger(), v.gtValue(0)),
          oldestAt: nonNegative,
        })
      ),
      v.maxLength(maxDemandEntries)
    ),
    grants: v.pipe(v.array(grantReportSchema), v.maxLength(maxGrantReports)),
    leases: v.optional(
      v.pipe(v.array(leaseReportSchema), v.maxLength(maxGrantReports))
    ),
  }),
  v.check(versionMatchesChannel, channelVersionError)
);
export type PermitRequest = v.InferOutput<typeof permitRequestSchema>;

export const permitSyncSchema = v.pipe(
  v.object({
    type: v.literal('sync'),
    v: protocolVersion,
    clientId: nonEmpty,
    clientChannel,
    grants: v.pipe(v.array(grantReportSchema), v.maxLength(maxGrantReports)),
    leases: v.optional(
      v.pipe(v.array(leaseReportSchema), v.maxLength(maxGrantReports))
    ),
  }),
  v.check(versionMatchesChannel, channelVersionError)
);
export type PermitSync = v.InferOutput<typeof permitSyncSchema>;

export const semaphoreRequestSchema = v.union([
  permitRequestSchema,
  permitSyncSchema,
]);
export type SemaphoreRequest = v.InferOutput<typeof semaphoreRequestSchema>;

export const semaphoreBlockedReasonSchema = v.picklist([
  'group_limit',
  'limit',
  'limit_resolution_error',
  'not_permitted',
]);
export type SemaphoreBlockedReason = v.InferOutput<
  typeof semaphoreBlockedReasonSchema
>;

export const grantResultSchema = v.object({
  grantId: nonEmpty,
  /** Server-clamped claim high-water mark; the client admits only up to this. */
  claimed: nonNegative,
  status: v.picklist(['ok', 'not_found', 'expired']),
});
export type GrantResult = v.InferOutput<typeof grantResultSchema>;

export const permitGrantSchema = v.pipe(
  v.object({
    type: v.literal('grant'),
    v: protocolVersion,
    grants: v.array(
      v.object({
        grantId: nonEmpty,
        group: v.string(),
        permits: v.pipe(v.number(), v.safeInteger(), v.gtValue(0)),
      })
    ),
    blocked: v.array(
      v.object({ group: v.string(), reason: semaphoreBlockedReasonSchema })
    ),
    /** The client must not send another request before this. */
    nextRequestAt: nonNegative,
    grantResults: v.array(grantResultSchema),
    leases: v.optional(v.array(leaseGrantSchema)),
    /** Demand went unserved: return undrawn lease permits in groups with nothing queued. */
    contended: v.optional(v.boolean()),
    /** Echoes the request's client channel in version 2. */
    clientChannel,
  }),
  v.check(versionMatchesChannel, channelVersionError)
);
export type PermitGrant = v.InferOutput<typeof permitGrantSchema>;

export const permitSyncResultSchema = v.pipe(
  v.object({
    type: v.literal('synced'),
    v: protocolVersion,
    grantResults: v.array(grantResultSchema),
    leases: v.optional(v.array(leaseGrantSchema)),
    contended: v.optional(v.boolean()),
    /** Echoes the sync's `clientChannel`, as for a grant. */
    clientChannel,
  }),
  v.check(versionMatchesChannel, channelVersionError)
);
export type PermitSyncResult = v.InferOutput<typeof permitSyncResultSchema>;

export const semaphoreResponseSchema = v.union([
  permitGrantSchema,
  permitSyncResultSchema,
]);
export type SemaphoreResponse = v.InferOutput<typeof semaphoreResponseSchema>;
