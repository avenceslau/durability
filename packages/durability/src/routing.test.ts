import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutingLoad, type EnqueueResult } from './load';
import { RoutingClient } from './routing-client';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const accepted = (backlog = 0): EnqueueResult<string> => ({
  success: true,
  value: 'accepted',
  load: new RoutingLoad().snapshot(backlog),
});

describe('routing client', () => {
  it('routes a whole input once with caller context and a location hint', async () => {
    const input = [{ id: 'a' }, { id: 'b' }];
    const context = { tenant: 'acme', extra: () => 'local only' };
    const sharding = vi.fn(() => ({
      shard: 'tenant-acme',
      locationHint: 'weur' as const,
    }));
    const invoke = vi.fn(async () => accepted());
    const routing = new RoutingClient({ sharding, invoke });
    await expect(routing.push(input, context)).resolves.toMatchObject({
      success: true,
    });
    expect(sharding).toHaveBeenCalledWith(input, context, new Map());
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      { shard: 'tenant-acme', locationHint: 'weur' },
      input
    );
  });

  it('returns rejection plus load without rerouting or retrying', async () => {
    const response: EnqueueResult<string> = {
      success: false,
      error: { name: 'Rejected', message: 'full' },
      load: new RoutingLoad().snapshot(500),
    };
    const invoke = vi.fn(async () => response);
    const router = new RoutingClient({ sharding: () => 'same', invoke });
    expect(await router.push('batch')).toBe(response);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(router.observations().get('same')).toEqual(response.load);
  });

  it('propagates transport uncertainty without fabricating acceptance or load', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('connection lost');
    });
    const router = new RoutingClient({ invoke });
    await expect(router.push('batch')).rejects.toThrow('connection lost');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(router.observations().size).toBe(0);
  });

  it('widens under backlog pressure, ignores stale samples, and ages observations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const invoke = vi.fn(async () => accepted(101));
    const router = new RoutingClient({ invoke, softBacklogLimit: 100 });
    await router.push('first');
    await router.push('second');
    expect(invoke.mock.calls).toHaveLength(2);
    // Newly selected shard created on demand; no configured instance count.
    expect(router.observations().has('shard-1')).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(router.observations().size).toBe(0);
  });

  it('exposes observed timings to custom sharding without sharing mutable snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const load = new RoutingLoad();
    const finish = load.begin('outbound');
    vi.advanceTimersByTime(125);
    finish();
    const snapshot = load.snapshot(12);
    const sharding = vi.fn(() => 'hot');
    const router = new RoutingClient({
      sharding,
      invoke: async () => ({
        success: true as const,
        value: 1,
        load: snapshot,
      }),
    });
    await router.push('first');
    const seen = router.observations().get('hot');
    expect(seen?.outbound).toMatchObject({
      completed: 1,
      averageProcessingMs: 125,
      pendingDeliveries: 12,
    });
    if (seen) {
      seen.outbound.pendingDeliveries = 999;
    }
    await router.push('second');
    expect(sharding).toHaveBeenLastCalledWith(
      'second',
      undefined,
      new Map([['hot', snapshot]])
    );
  });
});
