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
export const consumerNameSchema = name;

/** The target a queue with pull consumers gets by itself; nobody else may use the name. */
export const pullTargetName = 'pull';

/**
 * Where dead letters go when a queue has no target at all. It cannot be a
 * target's name: those start with a letter or a digit.
 */
export const noTargetName = '_no-target';

export const sendSchema = v.object({
  /**
   * Messages sharing a key are delivered in the order they were accepted. A
   * send has one key, so it goes to one partition, which stores all of it or
   * none of it.
   */
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  messages: v.pipe(
    v.array(
      v.object({
        body: v.unknown(),
        /** Sending the same id again while the message is retained is a no-op. */
        id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
      })
    ),
    v.minLength(1),
    v.maxLength(1_000)
  ),
});
export type SendInput = v.InferOutput<typeof sendSchema>;

/** A message as a partition stores it. */
export type Message = {
  id: string;
  key: string;
  body: unknown;
  sentAt: number;
  /** Set by a redrive: only these targets receive the message. */
  only?: string[];
  /**
   * What the partition deduplicates on when that is not the id. A redriven
   * message keeps its id, so consumers recognise it, but has to be stored again.
   */
  dedupeId?: string;
};

const destinationSchema = v.variant('type', [
  v.object({
    type: v.literal('webhook'),
    url: v.pipe(v.string(), v.url()),
    /** Signs each request body with HMAC-SHA256 in `X-Queue-Signature`. */
    secret: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.object({
    type: v.literal('rpc'),
    /**
     * Name of a service binding, declared in `wrangler.jsonc`, to a class
     * that extends `QueueEntrypoint`.
     */
    binding: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    type: v.literal('service'),
    /** Name of a service binding declared in `wrangler.jsonc`; the batch is POSTed to it. */
    binding: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    type: v.literal('queue'),
    queue: name,
  }),
  v.object({ type: v.literal('archive') }),
]);
export type Destination = v.InferOutput<typeof destinationSchema>;

/**
 * Where a target's batches go. `pull` is the queue's own target: it writes
 * every batch to the pull bucket, which is what pull consumers read.
 */
export type TargetDestination = Destination | { type: 'pull' };

/** The longest a retry can be put off, by the target's setting or by a consumer. */
export const maxRetryDelaySeconds = 86_400;

export const targetInputSchema = v.object({
  destination: destinationSchema,
  /** Messages one partition hands this target at a time. */
  maxBatchSize: v.optional(v.pipe(positive, v.maxValue(100)), 10),
  /** Times a message is delivered again before it is dead-lettered. */
  maxRetries: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(100)),
    3
  ),
  /** Seconds before a retried message is delivered again, unless the consumer says otherwise. */
  retryDelaySeconds: v.optional(
    v.pipe(v.number(), v.minValue(0), v.maxValue(maxRetryDelaySeconds)),
    0
  ),
  /** Batches in flight for this target across the whole queue. */
  maxConcurrency: v.optional(positive),
  /** Messages per second one partition hands this target. */
  maxPerSecond: v.optional(positive),
  attemptTimeoutMs: v.optional(
    v.pipe(positive, v.minValue(100), v.maxValue(30_000)),
    10_000
  ),
  paused: v.optional(v.boolean(), false),
  /** Where a new target starts reading. */
  startAt: v.optional(v.picklist(['latest', 'earliest']), 'latest'),
});
export type TargetSettings = v.InferOutput<typeof targetInputSchema>;

/**
 * The most partitions one queue may have: one orchestrator hears from all of
 * them. Tried with 4,000.
 */
export const maxPartitions = 10_000;

export const settingsInputSchema = v.object({
  partitions: v.optional(
    v.object({
      min: v.optional(v.pipe(positive, v.maxValue(maxPartitions)), 1),
      max: v.optional(v.pipe(positive, v.maxValue(maxPartitions)), 16),
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
  /**
   * Undelivered messages one partition holds before it rejects sends, or
   * `null` for no limit: a backlog that outgrows a partition moves to R2 and
   * is read back as delivery reaches it.
   */
  maxBacklog: v.optional(v.nullable(positive), null),
  /** Also writes every message to the pull bucket, for consumers that ask for messages. */
  pullConsumers: v.optional(v.boolean(), false),
  /** Days a message stays in the pull bucket. */
  pullRetentionDays: v.optional(v.pipe(positive, v.maxValue(50)), 7),
});
export type QueueSettings = v.InferOutput<typeof settingsInputSchema>;

/** Targets given when a queue is created, by name. */
export const targetsInputSchema = v.record(targetNameSchema, targetInputSchema);

/** Which partitions a key hashes onto. A resize starts a new epoch. */
export type Layout = { epoch: number; count: number };

export type PartitionIdentity = { queue: string; epoch: number; index: number };

export type PartitionTarget = Omit<TargetSettings, 'destination'> & {
  destination: TargetDestination;
  /**
   * The oldest epoch that still holds messages for this target. Partitions of
   * a later epoch wait, so messages of one key are never delivered out of order
   * across a resize.
   */
  deliverFromEpoch: number;
  /**
   * When the target was added, by the orchestrator's clock. A partition may
   * hear of a target some time after that, and what it accepted in between
   * is the target's. Absent on targets stored before this was recorded.
   */
  addedAt?: number;
};

/** What the orchestrator pushes to every partition. */
export type PartitionConfig = {
  targets: Record<string, PartitionTarget>;
  /** Limiter object names; empty when the queue has no concurrency limit. */
  limiters: string[];
  maxBacklog: number | null;
  /**
   * How often a partition reports to the orchestrator. It grows with the
   * number of partitions, so that one orchestrator can take all of them.
   */
  sampleIntervalMs: number;
  /** How long a batch stays in the pull bucket. */
  pullRetentionMs: number;
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
  /** Messages dead-lettered because the queue had no target to deliver them to. */
  withoutTarget: number;
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

/** What one pull hands a consumer: consecutive messages of one partition. */
export type PullBatch = {
  /** Names this delivery; acknowledge with it before `expiresAt`. */
  lease: string;
  /** `queue/epoch/index` of the partition the messages came from. */
  partition: string;
  /** One-based; higher when an earlier delivery was not acknowledged in time. */
  attempt: number;
  expiresAt: number;
  messages: {
    id: string;
    key: string;
    offset: number;
    /** Whatever JSON the producer sent: a primitive, an array, or an object. */
    body: string | number | boolean | null | object;
    sentAt: number;
  }[];
};

/** Progress of a queue's current or most recent redrive. */
export type RedriveStatus = {
  running: boolean;
  /** Set when the redrive is for one target rather than the whole queue. */
  target?: string;
  startedAt: number;
  finishedAt?: number;
  /** Messages accepted back into the queue. */
  redriven: number;
  /** Messages the queue refused; their dead letters stay where they are. */
  left: number;
  /** Why the last page failed, while it is being retried. */
  lastError?: string;
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
  /** Messages dead-lettered because the queue had no target to deliver them to. */
  withoutTarget: number;
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

/** One queue's latest numbers, for the dashboard's page of all queues. */
export type QueueSummary = {
  queue: string;
  /** Partitions accepting messages. */
  partitions: number;
  /** More than one while a resize waits for the previous partitions to drain. */
  epochs: number;
  acceptedPerSecond: number;
  rejectedPerSecond: number;
  /** Of the target furthest behind; adding targets up would count a message once for each. */
  deliveredPerSecond: number;
  backlog: number;
  deadLettered: number;
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
