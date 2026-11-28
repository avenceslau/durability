import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cachePlan, memoryTier, workerCacheTier } from '../src/cache/index';
import { CacheEntry, encodeCacheEntry } from '../src/cache/entry';
import type { CacheDO } from './worker';

const memoryWindows = { freshMs: 1_000, staleMs: 10_000 };

const memoryPlan = cachePlan<CacheDO>()({
  countRead: { memory: memoryWindows },
  readOrFail: { memory: memoryWindows, staleIfErrorMs: 60_000 },
});

const startedAt = Date.UTC(2026, 0, 1);

function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(startedAt);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('memoryTier', () => {
  it('answers fresh entries without calling the target', async () => {
    const stub = env.CACHE_DO.getByName('memory-fresh').with(
      memoryTier(memoryPlan)
    );

    await expect(stub.countRead('a')).resolves.toStrictEqual({
      key: 'a',
      reads: 1,
    });
    await expect(stub.countRead('a')).resolves.toStrictEqual({
      key: 'a',
      reads: 1,
    });
    await expect(stub.countRead('b')).resolves.toEqual({ key: 'b', reads: 2 });
  });

  it('merges concurrent misses into one call to the target', async () => {
    const stub = env.CACHE_DO.getByName('memory-merge').with(
      memoryTier(memoryPlan)
    );

    const results = await Promise.all([
      stub.countRead('a'),
      stub.countRead('a'),
      stub.countRead('a'),
    ]);

    expect(results).toEqual([
      { key: 'a', reads: 1 },
      { key: 'a', reads: 1 },
      { key: 'a', reads: 1 },
    ]);
  });

  it('answers stale entries while one call refreshes them', async () => {
    const stub = env.CACHE_DO.getByName('memory-stale').with(
      memoryTier(memoryPlan)
    );

    await stub.countRead('a');
    advance(2_000);

    await expect(stub.countRead('a')).resolves.toEqual({ key: 'a', reads: 1 });
    // Calls during the refresh answer the stale entry and join the same load.
    await vi.waitFor(() =>
      expect(stub.countRead('a')).resolves.toEqual({ key: 'a', reads: 2 })
    );
    await expect(
      env.CACHE_DO.getByName('memory-stale').countRead('b')
    ).resolves.toEqual({ key: 'b', reads: 3 });
  });

  it('loads again once entries are older than the stale window', async () => {
    const stub = env.CACHE_DO.getByName('memory-expired').with(
      memoryTier(memoryPlan)
    );

    await stub.countRead('a');
    advance(11_000);

    await expect(stub.countRead('a')).resolves.toEqual({ key: 'a', reads: 2 });
  });

  it('answers with an old entry while the target fails, within staleIfErrorMs', async () => {
    const tier = memoryTier(memoryPlan);
    const stub = env.CACHE_DO.getByName('memory-error').with(tier);

    await stub.readOrFail('a');
    await stub.setFailing(true);
    advance(30_000);

    await expect(stub.readOrFail('a')).resolves.toEqual({ key: 'a', reads: 1 });

    advance(40_000);

    await expect(stub.readOrFail('a')).rejects.toThrow('Reading a failed');
  });

  it('does not let callers change cached results', async () => {
    const stub = env.CACHE_DO.getByName('memory-clone').with(
      memoryTier(memoryPlan)
    );

    const first = await stub.countRead('a');
    first.reads = 100;

    await expect(stub.countRead('a')).resolves.toEqual({ key: 'a', reads: 1 });
  });

  it('evicts the least recently used entries', async () => {
    const stub = env.CACHE_DO.getByName('memory-evict').with(
      memoryTier(memoryPlan, { maxEntries: 2 })
    );

    await stub.countRead('a');
    await stub.countRead('b');
    await stub.countRead('a');
    await stub.countRead('c');

    await expect(stub.countRead('a')).resolves.toEqual({ key: 'a', reads: 1 });
    await expect(stub.countRead('b')).resolves.toEqual({ key: 'b', reads: 4 });
  });

  it('calls methods without memory windows directly', async () => {
    const stub = env.CACHE_DO.getByName('memory-direct').with(
      memoryTier(memoryPlan)
    );

    await stub.setReadCount(5);

    await expect(stub.getNothing()).resolves.toBeUndefined();
  });
});

describe('composed tiers', () => {
  it('judges an entry from a slower tier by when the target returned it', async () => {
    const plan = cachePlan<CacheDO>()({
      countRead: {
        memory: memoryWindows,
        location: { freshMs: 60_000, staleMs: 120_000 },
      },
    });

    const sent: string[] = [];
    const loadedAt = startedAt - 5_000;

    const location = workerCacheTier(plan, {
      binding: () => ({
        async fetch(input: RequestInfo | URL) {
          sent.push(String(input));

          return new Response(
            encodeCacheEntry(new CacheEntry({ key: 'a', reads: 9 }, loadedAt))
          );
        },
        connect() {
          throw new Error('connect is not used by the cache tier');
        },
      }),
    });

    const stub = env.CACHE_DO.getByName('composed')
      .with(memoryTier(plan))
      .with(location);

    await expect(stub.countRead('a')).resolves.toStrictEqual({
      key: 'a',
      reads: 9,
    });

    // The location answer was already 5s old, past the memory fresh window.
    await stub.countRead('a');

    await vi.waitFor(() => expect(sent).toHaveLength(2));
  });
});

describe('durableTier', () => {
  it("keeps entries in the calling object's storage", async () => {
    const caller = env.CACHE_CALLER_DO.getByName('durable-caller');

    await expect(
      caller.readThroughStorage('durable-target', 'a', false)
    ).resolves.toEqual({ key: 'a', reads: 1 });
    await expect(
      caller.readThroughStorage('durable-target', 'a', true)
    ).resolves.toEqual({ key: 'a', reads: 1 });

    const keys = await caller.storedKeys();

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^durability-cache:[0-9a-f]{64}$/);
  });
});
