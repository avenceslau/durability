/**
 * The orchestrator's decisions, kept free of I/O so they can be tested and
 * tuned on their own.
 */
import type { LimiterSample } from './model';

/** A queue that is refusing sends should not wait long to grow again. */
const scaleOutCooldownMs = 10_000;
/** Growing for a backlog makes delivery wait for a drain, so it repeats less soon. */
const backlogCooldownMs = 30_000;
/**
 * A queue shrinks only after it would have fitted in half its partitions for
 * this long without a break, and this long after its last resize. A resize
 * makes delivery wait for a drain, and the traffic that needed the
 * partitions tends to come back.
 */
const scaleInQuietMs = 30 * 60_000;
const limiterScaleOutCooldownMs = 30_000;
const limiterScaleInCooldownMs = 5 * 60_000;
/** A backlog that would take longer than this to deliver asks for more partitions. */
const maxDrainSeconds = 30;

export type PartitionLoad = {
  current: number;
  min: number;
  max: number;
  /** Accepted messages per second one partition should carry. */
  targetRate: number;
  /** Messages per second sent to the queue recently, accepted or refused. */
  acceptRate: number;
  /**
   * Seconds the slowest running target needs to deliver what it has pending,
   * at its recent pace. Undefined when nothing is pending.
   */
  drainSeconds: number | undefined;
  /** More partitions cannot help while deliveries wait for permits. */
  waitingForPermits: boolean;
  now: number;
  lastResizeAt: number;
  /**
   * Since when the queue has fitted in half its partitions without a break,
   * by `fitsInHalf`. Undefined while it does not.
   */
  quietSince: number | undefined;
};

const backlogged = (load: Pick<PartitionLoad, 'drainSeconds'>): boolean =>
  load.drainSeconds !== undefined && load.drainSeconds > maxDrainSeconds;

/** True while half the partitions would carry the traffic and nothing is behind. */
export const fitsInHalf = (
  load: Pick<
    PartitionLoad,
    'current' | 'targetRate' | 'acceptRate' | 'drainSeconds'
  >
): boolean =>
  Math.ceil(load.acceptRate / load.targetRate) <= load.current / 2 &&
  !backlogged(load);

/** The partition count a queue should move to, or undefined to stay. */
export const planPartitions = (load: PartitionLoad): number | undefined => {
  const clamp = (count: number) =>
    Math.min(load.max, Math.max(load.min, count));
  const moveTo = (count: number) =>
    clamp(count) === load.current ? undefined : clamp(count);

  if (load.current < load.min || load.current > load.max) {
    return clamp(load.current);
  }

  const sinceResize = load.now - load.lastResizeAt;
  const forRate = Math.ceil(load.acceptRate / load.targetRate);

  // Doubling at least keeps resizes rare: each one makes delivery wait for a drain.
  if (forRate > load.current && sinceResize >= scaleOutCooldownMs) {
    return moveTo(Math.max(forRate, load.current * 2));
  }
  if (
    backlogged(load) &&
    !load.waitingForPermits &&
    sinceResize >= backlogCooldownMs
  ) {
    return moveTo(load.current * 2);
  }

  if (
    load.quietSince !== undefined &&
    load.now - load.quietSince >= scaleInQuietMs &&
    sinceResize >= scaleInQuietMs
  ) {
    return moveTo(Math.ceil(load.current / 2));
  }

  return undefined;
};

export type LimiterLoad = {
  current: number;
  /** Permit requests per second across all limiters. */
  requestsPerSecond: number;
  /** Permit requests per second one limiter should carry. */
  targetRate: number;
  now: number;
  lastChangeAt: number;
};

/** Limiters are added and removed one at a time, on request rate alone. */
export const planLimiters = (load: LimiterLoad): number => {
  const sinceChange = load.now - load.lastChangeAt;
  const wanted = Math.max(
    1,
    Math.ceil(load.requestsPerSecond / load.targetRate)
  );

  if (wanted > load.current && sinceChange >= limiterScaleOutCooldownMs) {
    return load.current + 1;
  }

  const fitsInFewer =
    load.requestsPerSecond < (load.current - 1) * load.targetRate * 0.5;
  if (
    load.current > 1 &&
    fitsInFewer &&
    sinceChange >= limiterScaleInCooldownMs
  ) {
    return load.current - 1;
  }
  return load.current;
};

export type ShareState = {
  /** Permits each limiter may hand out, as last published. */
  shares: Record<string, number>;
  /** Revision of the publication that last lowered each limiter's share. */
  loweredAtRevision: Record<string, number>;
  /** The share each lowered limiter had before, until it confirms the lower one. */
  beforeLowering: Record<string, number>;
};

export type SharePlan = ShareState & { changed: boolean };

/** Splits `total` by weight; the leftover goes to the largest remainders. */
const apportion = (
  total: number,
  weights: Record<string, number>
): Record<string, number> => {
  const names = Object.keys(weights);
  const sum = names.reduce((all, name) => all + weights[name]!, 0);
  if (names.length === 0 || sum === 0) {
    return Object.fromEntries(names.map((name) => [name, 0]));
  }

  const exact = names.map((name) => (total * weights[name]!) / sum);
  const shares = exact.map(Math.floor);
  let leftover = total - shares.reduce((all, share) => all + share, 0);
  const byRemainder = names
    .map((_, index) => index)
    .sort((a, b) => exact[b]! - shares[b]! - (exact[a]! - shares[a]!));
  for (const index of byRemainder) {
    if (leftover === 0) {
      break;
    }
    shares[index]! += 1;
    leftover -= 1;
  }
  return Object.fromEntries(names.map((name, index) => [name, shares[index]!]));
};

/**
 * Decides each limiter's share of the queue limit from what the limiters
 * report. Shares follow demand: permits in use plus permits still asked for.
 *
 * `fast` publishes the wanted shares at once. A lowered limiter keeps the work
 * it already admitted, so the queue can run above its limit until that work
 * finishes.
 *
 * `strict` lowers first and raises later. A limiter is counted at its old
 * share until it reports having applied the lower one, and at its permits in
 * use while those still exceed it; only what is left may be handed to others.
 * The shares it publishes therefore never add up to more than the limit
 * together with work that is still running.
 */
export const planShares = (input: {
  limit: number;
  mode: 'strict' | 'fast';
  active: readonly string[];
  draining: readonly string[];
  state: ShareState;
  samples: readonly LimiterSample[];
  /** Revision the plan will be published under. */
  revision: number;
}): SharePlan => {
  const { limit, mode, active, draining, state, revision } = input;
  const sample = new Map(input.samples.map((entry) => [entry.limiter, entry]));
  const everyone = [...active, ...draining];

  // One extra per limiter keeps an idle one able to admit its first request.
  const wanted = {
    ...apportion(
      limit,
      Object.fromEntries(
        active.map((name) => {
          const usage = sample.get(name);
          return [name, (usage?.granted ?? 0) + (usage?.blocked ?? 0) + 1];
        })
      )
    ),
    ...Object.fromEntries(draining.map((name) => [name, 0])),
  };

  const loweredAtRevision = { ...state.loweredAtRevision };
  const beforeLowering = { ...state.beforeLowering };
  const shares: Record<string, number> = {};
  /** Permits not promised to any limiter, counting work that is still running. */
  let unassigned = limit;

  for (const name of everyone) {
    const current = state.shares[name] ?? 0;
    const share =
      mode === 'fast' ? wanted[name]! : Math.min(current, wanted[name]!);
    shares[name] = share;

    const usage = sample.get(name);
    const appliedLastLowering =
      usage !== undefined &&
      usage.revision >= (state.loweredAtRevision[name] ?? 0);
    if (appliedLastLowering) {
      delete beforeLowering[name];
    }
    const stillRunning = appliedLastLowering ? usage.granted : 0;

    if (share < current) {
      loweredAtRevision[name] = revision;
      beforeLowering[name] = Math.max(
        beforeLowering[name] ?? 0,
        current,
        stillRunning
      );
      unassigned -= beforeLowering[name];
      continue;
    }
    unassigned -= Math.max(share, stillRunning, beforeLowering[name] ?? 0);
  }

  if (mode === 'strict') {
    const mostBlockedFirst = [...active].sort(
      (a, b) => (sample.get(b)?.blocked ?? 0) - (sample.get(a)?.blocked ?? 0)
    );
    for (const name of mostBlockedFirst) {
      const raise = Math.min(wanted[name]! - shares[name]!, unassigned);
      if (raise > 0) {
        shares[name]! += raise;
        unassigned -= raise;
      }
    }
  }

  // Republishing for a permit or two would wake every limiter each tick.
  const tolerance = Math.max(1, Math.ceil(limit * 0.05));
  const changed = everyone.some((name) => {
    const difference = Math.abs(shares[name]! - (state.shares[name] ?? 0));
    const starved = (sample.get(name)?.blocked ?? 0) > 0 && difference > 0;
    const emptied = shares[name] === 0 && difference > 0;
    return difference >= tolerance || starved || emptied;
  });

  return changed
    ? { shares, loweredAtRevision, beforeLowering, changed }
    : { ...state, changed };
};
