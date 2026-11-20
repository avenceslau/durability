import { describe, expect, it } from 'vitest';
import { limiterFor } from '../src/layout';
import type { LimiterSample } from '../src/model';
import {
  planLimiters,
  planPartitions,
  planShares,
  type ShareState,
} from '../src/scaling';

const minute = 60_000;

const partitionLoad = {
  current: 2,
  min: 1,
  max: 16,
  targetRate: 100,
  acceptRate: 150,
  drainSeconds: undefined,
  waitingForPermits: false,
  now: 10 * minute,
  lastResizeAt: 0,
};

describe('planPartitions', () => {
  it('stays when the rate fits', () => {
    expect(planPartitions(partitionLoad)).toBeUndefined();
  });

  it('at least doubles when the rate does not fit', () => {
    expect(planPartitions({ ...partitionLoad, acceptRate: 250 })).toBe(4);
    expect(planPartitions({ ...partitionLoad, acceptRate: 900 })).toBe(9);
    expect(planPartitions({ ...partitionLoad, acceptRate: 9_000 })).toBe(16);
  });

  it('grows for a backlog, unless deliveries are waiting for permits', () => {
    const behind = { ...partitionLoad, acceptRate: 10, drainSeconds: 120 };
    expect(planPartitions(behind)).toBe(4);
    expect(
      planPartitions({ ...behind, waitingForPermits: true })
    ).toBeUndefined();
  });

  it('halves only after the longer cooldown', () => {
    const quiet = { ...partitionLoad, current: 8, acceptRate: 100 };
    expect(planPartitions(quiet)).toBe(4);
    expect(
      planPartitions({ ...quiet, lastResizeAt: quiet.now - minute })
    ).toBeUndefined();
  });

  it('returns to the configured range', () => {
    expect(planPartitions({ ...partitionLoad, current: 20 })).toBe(16);
    expect(planPartitions({ ...partitionLoad, min: 4 })).toBe(4);
  });
});

describe('planLimiters', () => {
  const load = {
    current: 1,
    requestsPerSecond: 150,
    targetRate: 200,
    now: 10 * minute,
    lastChangeAt: 0,
  };

  it('adds one limiter when the request rate exceeds what they should carry', () => {
    expect(planLimiters(load)).toBe(1);
    expect(planLimiters({ ...load, requestsPerSecond: 900 })).toBe(2);
  });

  it('removes one only when the rest would be half idle', () => {
    const three = { ...load, current: 3 };
    expect(planLimiters({ ...three, requestsPerSecond: 250 })).toBe(3);
    expect(planLimiters({ ...three, requestsPerSecond: 150 })).toBe(2);
  });
});

const usage = (
  limiter: string,
  granted: number,
  blocked = 0,
  revision = 0
): LimiterSample => ({
  limiter,
  at: 0,
  revision,
  requestsPerSecond: 0,
  limit: 0,
  granted,
  blocked,
});

const total = (shares: Record<string, number>) =>
  Object.values(shares).reduce((all, share) => all + share, 0);

describe('planShares', () => {
  const balanced: ShareState = {
    shares: { a: 50, b: 50 },
    loweredAtRevision: {},
    beforeLowering: {},
  };
  const input = {
    limit: 100,
    active: ['a', 'b'],
    draining: [],
    state: balanced,
    revision: 1,
  };

  it('fast moves permits to the limiter with demand at once', () => {
    const plan = planShares({
      ...input,
      mode: 'fast',
      samples: [usage('a', 50, 100), usage('b', 40)],
    });
    expect(plan.changed).toBe(true);
    expect(plan.shares['a']).toBeGreaterThan(70);
    expect(total(plan.shares)).toBe(100);
  });

  it('strict lowers first and hands out nothing still in use', () => {
    const lowered = planShares({
      ...input,
      mode: 'strict',
      samples: [usage('a', 50, 100), usage('b', 40)],
    });
    // b is lowered, but it may still hold 50 until it confirms.
    expect(lowered.shares['b']).toBeLessThan(50);
    expect(lowered.shares['a']).toBe(50);
    expect(lowered.loweredAtRevision['b']).toBe(1);

    const unconfirmed = planShares({
      ...input,
      mode: 'strict',
      state: lowered,
      revision: 2,
      samples: [usage('a', 50, 100), usage('b', 40, 0, 0)],
    });
    expect(unconfirmed.shares['a']).toBe(50);

    // b applied revision 1 and still runs 40: only 10 are free.
    const confirmed = planShares({
      ...input,
      mode: 'strict',
      state: lowered,
      revision: 2,
      samples: [usage('a', 50, 100), usage('b', 40, 0, 1)],
    });
    expect(confirmed.shares['a']).toBe(60);

    // b is lowered again: it counts at its previous share until it confirms.
    const loweredAgain = planShares({
      ...input,
      mode: 'strict',
      state: confirmed,
      revision: 3,
      samples: [usage('a', 60, 90), usage('b', 5, 0, 2)],
    });
    expect(loweredAgain.shares['b']).toBeLessThan(confirmed.shares['b']!);
    expect(loweredAgain.shares['a']! + confirmed.shares['b']!).toBe(100);

    const finished = planShares({
      ...input,
      mode: 'strict',
      state: loweredAgain,
      revision: 4,
      samples: [usage('a', 79, 60), usage('b', 4, 0, 3)],
    });
    // One permit stays back for the permit b has not confirmed giving up.
    expect(finished.shares['a']! + loweredAgain.shares['b']!).toBe(100);
  });

  it('empties a draining limiter and gives a new one a share', () => {
    const plan = planShares({
      limit: 10,
      mode: 'fast',
      active: ['a', 'c'],
      draining: ['b'],
      state: { ...balanced, shares: { a: 5, b: 5, c: 0 } },
      revision: 1,
      samples: [usage('a', 5), usage('b', 5), usage('c', 0, 4)],
    });
    expect(plan.shares['b']).toBe(0);
    expect(plan.shares['c']).toBeGreaterThan(0);
    expect(total(plan.shares)).toBe(10);
  });

  it('leaves small differences alone', () => {
    const plan = planShares({
      ...input,
      mode: 'fast',
      samples: [usage('a', 26), usage('b', 25)],
    });
    expect(plan.changed).toBe(false);
    expect(plan.shares).toEqual(balanced.shares);
  });
});

describe('limiterFor', () => {
  const partitions = Array.from({ length: 200 }, (_, n) => `queue/1/${n}`);

  it('moves only the partitions that pick the added limiter', () => {
    const before = partitions.map((name) => limiterFor(name, ['a', 'b']));
    const after = partitions.map((name) => limiterFor(name, ['a', 'b', 'c']));
    const moved = partitions.filter((_, n) => before[n] !== after[n]);
    expect(moved.length).toBeGreaterThan(30);
    expect(moved.length).toBeLessThan(110);
    for (const [n, limiter] of after.entries()) {
      expect(limiter === before[n] || limiter === 'c').toBe(true);
    }
  });

  it('has no limiter when the queue has none', () => {
    expect(limiterFor('queue/1/0', [])).toBeUndefined();
  });
});
