/**
 * What the dashboard's load test asks of the load generator, the Worker in
 * `../loadgen`. The queue does not depend on that Worker: these types are the
 * whole contract, and the dashboard hides the load test when the queue has no
 * binding to it.
 */
import * as v from 'valibot';
import { maxPartitions } from './model';

const whole = (min: number, max: number) =>
  v.pipe(v.number(), v.safeInteger(), v.minValue(min), v.maxValue(max));

export const loadOptionsSchema = v.pipe(
  v.object({
    /** Queues to load, named `load-0`, `load-1`, and so on. */
    tenants: whole(1, 200),
    /** Send requests per second to each tenant's queue. */
    requestsPerSecond: whole(1, 100_000),
    /** Each request carries between this many messages... */
    minMessages: whole(1, 1_000),
    /** ...and this many. */
    maxMessages: whole(1, 1_000),
    /** Distinct keys per tenant. */
    keys: whole(1, 1_000_000),
    /** The run stops by itself after this long. */
    seconds: whole(1, 3_600),
    /**
     * With `quietSeconds` above 0 the load comes in bursts: every generator
     * sends for `burstSeconds`, then nothing for `quietSeconds`, and again,
     * all at the same moments. That shows a backlog build and drain.
     */
    burstSeconds: v.optional(whole(1, 3_600), 30),
    quietSeconds: v.optional(whole(0, 3_600), 0),
    /**
     * Messages per second one partition hands the run's target, or `null` to
     * deliver as fast as it can. A low value makes a backlog build while the
     * run sends and drain slowly after it.
     */
    deliverPerSecond: v.optional(v.nullable(whole(1, 1_000_000)), null),
    /** Applied to every tenant's queue. */
    partitions: v.object({
      min: whole(1, maxPartitions),
      max: whole(1, maxPartitions),
    }),
  }),
  v.check(
    (options) => options.minMessages <= options.maxMessages,
    'minMessages must not exceed maxMessages'
  ),
  v.check(
    (options) => options.partitions.min <= options.partitions.max,
    'partitions.min must not exceed partitions.max'
  )
);
export type LoadOptions = v.InferOutput<typeof loadOptionsSchema>;

export type LoadCounts = {
  /** Send requests made. */
  requests: number;
  /** Messages the queue stored. */
  accepted: number;
  /** Messages the queue refused, for backpressure or another reason. */
  rejected: number;
  /** Requests that threw: nothing is known about their messages. */
  failed: number;
};

export type LoadStatus = {
  phase: 'idle' | 'running' | 'finished' | 'stopped';
  options?: LoadOptions;
  startedAt?: number;
  endsAt?: number;
  /** Generators that reported in the last few seconds. */
  generators: number;
  /** Over the generators' latest reports. */
  perSecond: LoadCounts;
  latencyMs: { average: number; max: number };
  /** Since the run started. */
  totals: LoadCounts;
  /** Why the most recent request failed, and why the queue last refused messages. */
  lastFailure?: string;
  lastRejection?: string;
};

export type LoadControl = {
  start(options: LoadOptions): Promise<LoadStatus>;
  stop(): Promise<LoadStatus>;
  status(): Promise<LoadStatus>;
  /** Deletes the tenants' queues; resolves to how many. */
  deleteQueues(): Promise<number>;
};
