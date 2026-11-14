/**
 * Types and input schemas shared by the Worker, the Durable Objects, and the
 * dashboard. Nothing here depends on the Workers runtime.
 */
import * as v from 'valibot';

const name = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'Use lowercase letters, digits, - or _')
);
const positive = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

export const queueNameSchema = name;
export const targetNameSchema = name;

export const messageInputSchema = v.object({
  /** Messages sharing a key are delivered in the order they were accepted. */
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  body: v.unknown(),
  /** Sending the same id again while the message is retained is a no-op. */
  id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
});
export type MessageInput = v.InferOutput<typeof messageInputSchema>;

export const sendSchema = v.union([
  v.pipe(v.array(messageInputSchema), v.minLength(1), v.maxLength(1_000)),
  v.pipe(
    messageInputSchema,
    v.transform((message) => [message])
  ),
]);

/** A message as a partition stores it. */
export type Message = {
  id: string;
  key: string;
  body: unknown;
  sentAt: number;
  /** Set by a redrive: only these targets receive the message. */
  only?: string[];
};

const destinationSchema = v.variant('type', [
  v.object({
    type: v.literal('webhook'),
    url: v.pipe(v.string(), v.url()),
    /** Signs each request body with HMAC-SHA256 in `X-Queue-Signature`. */
    secret: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.object({
    type: v.literal('service'),
    /** Name of a service binding declared in `wrangler.jsonc`. */
    binding: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    type: v.literal('queue'),
    queue: name,
  }),
  v.object({ type: v.literal('archive') }),
]);
export type Destination = v.InferOutput<typeof destinationSchema>;

export const targetInputSchema = v.object({
  destination: destinationSchema,
  /** Messages one partition hands this target at a time. */
  batchSize: v.optional(v.pipe(positive, v.maxValue(100)), 10),
  /** Messages per second one partition hands this target. */
  maxPerSecond: v.optional(positive),
  /** Batches in flight for this target across the whole queue. */
  maxConcurrency: v.optional(positive),
  /** Deliveries of one batch before it is dead-lettered. */
  maxAttempts: v.optional(v.pipe(positive, v.maxValue(100)), 5),
  attemptTimeoutMs: v.optional(
    v.pipe(positive, v.minValue(100), v.maxValue(30_000)),
    10_000
  ),
  paused: v.optional(v.boolean(), false),
  /** Where a new target starts reading. */
  startAt: v.optional(v.picklist(['latest', 'earliest']), 'latest'),
});
export type TargetSettings = v.InferOutput<typeof targetInputSchema>;

export const settingsInputSchema = v.object({
  partitions: v.optional(
    v.object({
      min: v.optional(v.pipe(positive, v.maxValue(256)), 1),
      max: v.optional(v.pipe(positive, v.maxValue(256)), 16),
      /** Accepted messages per second one partition should carry. */
      targetRate: v.optional(positive, 200),
    }),
    {}
  ),
  /** Batches in flight across the whole queue; omit for no limit. */
  maxConcurrency: v.optional(v.nullable(positive), null),
  /**
   * How permits move between limiters. `strict` never exceeds the limit;
   * `fast` follows demand at once and may exceed it briefly.
   */
  limitMode: v.optional(v.picklist(['strict', 'fast']), 'strict'),
  /** Permit requests per second one limiter should carry. */
  limiterTargetRate: v.optional(positive, 200),
  /** Undelivered messages one partition holds before it rejects sends. */
  maxBacklog: v.optional(positive, 100_000),
});
export type QueueSettings = v.InferOutput<typeof settingsInputSchema>;

/** Which partitions a key hashes onto. A resize starts a new epoch. */
export type Layout = { epoch: number; count: number };

export type PartitionIdentity = { queue: string; epoch: number; index: number };

export type PartitionTarget = TargetSettings & {
  /**
   * The oldest epoch that still holds messages for this target. Partitions of
   * a later epoch wait, so messages of one key are never delivered out of order
   * across a resize.
   */
  deliverFromEpoch: number;
};

/** What the orchestrator pushes to every partition. */
export type PartitionConfig = {
  targets: Record<string, PartitionTarget>;
  /** Limiter object names; empty when the queue has no concurrency limit. */
  limiters: string[];
  maxBacklog: number;
};

export type TargetProgress = {
  /** Offset the target has settled up to: delivered, or dead-lettered. */
  settled: number;
  inFlight: number;
  retries: number;
  deadLettered: number;
  lastError?: string;
};

/** A partition's durable positions; rates are derived from successive samples. */
export type PartitionSample = PartitionIdentity & {
  at: number;
  /** Counts the partition's samples, so the newest wins whatever the clock says. */
  sequence: number;
  /** Total messages ever accepted: the log's next offset. */
  accepted: number;
  rejected: number;
  /** False once a resize replaced this partition; it then only delivers. */
  accepting: boolean;
  targets: Record<string, TargetProgress>;
};

/** Each limiter's share of the queue limit, and of each target's ceiling. */
export type Shares = {
  revision: number;
  limiters: Record<
    string,
    {
      permits: number;
      targets: Record<string, number>;
    }
  >;
};

export type LimiterSample = {
  limiter: string;
  at: number;
  /** Revision of the shares this limiter has applied. */
  revision: number;
  requestsPerSecond: number;
  limit: number;
  granted: number;
  /** Permits asked for in the last round that stayed queued. */
  blocked: number;
};

export type TargetTotals = {
  settled: number;
  pending: number;
  inFlight: number;
  retries: number;
  deadLettered: number;
};

/** Queue-wide cumulative counters at one instant. */
export type Point = {
  at: number;
  accepted: number;
  rejected: number;
  partitions: number;
  targets: Record<string, TargetTotals>;
  permits?: {
    limit: number;
    granted: number;
    blocked: number;
  };
};

export type QueueEvent = {
  at: number;
  kind: 'created' | 'scaled' | 'epoch_drained' | 'limiters' | 'settings';
  detail: string;
};

export type Overview = {
  queue: string;
  settings: QueueSettings;
  targets: Record<string, PartitionTarget>;
  /** Oldest first; the last one accepts new messages. */
  epochs: Layout[];
  partitions: PartitionSample[];
  limiters: {
    active: string[];
    draining: string[];
    shares: Record<string, number>;
    samples: LimiterSample[];
  };
  points: Point[];
  events: QueueEvent[];
};
