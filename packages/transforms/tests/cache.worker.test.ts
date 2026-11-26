import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  CachedCallError,
  workerCacheTier,
  type WorkerCacheRead,
} from '../src/cache/index';
import { cacheDOPlan } from './worker';

type SentRequest = { url: string; cache: RequestInit['cache'] };

/** A service binding that records each request and answers with `respond`. */
function fakeBinding(
  sent: SentRequest[],
  respond: () => Response | Promise<Response>
): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      sent.push({ url: String(input), cache: init?.cache });

      return respond();
    },
    connect() {
      throw new Error('connect is not used by the cache tier');
    },
  };
}

function cacheTier(reads: WorkerCacheRead[]) {
  return workerCacheTier(cacheDOPlan, {
    binding: () => env.CACHE_READS,
    onRead: (read) => reads.push(read),
  });
}

describe('workerCacheTier through a generated entrypoint', () => {
  it('answers planned methods through the cache entrypoint', async () => {
    const reads: WorkerCacheRead[] = [];
    const stub = env.CACHE_DO.getByName('planned').with(cacheTier(reads));

    await expect(stub.getValue('a')).resolves.toEqual({ key: 'a', calls: 1 });
    expect(reads).toEqual([{ method: 'getValue', outcome: 'cache' }]);
  });

  it('keeps an undefined result distinct from null', async () => {
    const reads: WorkerCacheRead[] = [];
    const stub = env.CACHE_DO.getByName('nothing').with(cacheTier(reads));

    await expect(stub.getNothing()).resolves.toBeUndefined();
    expect(reads).toEqual([{ method: 'getNothing', outcome: 'cache' }]);
  });

  it('calls methods outside the plan directly', async () => {
    const reads: WorkerCacheRead[] = [];
    const stub = env.CACHE_DO.getByName('direct').with(cacheTier(reads));

    await stub.setValue('abc');

    await expect(stub.with(cacheTier(reads)).getValue('x')).resolves.toEqual({
      key: 'x',
      calls: 4,
    });
    expect(reads.map((read) => read.outcome)).toEqual(['direct', 'cache']);
  });

  it('falls back to calling the target when the target fails behind the cache', async () => {
    const reads: WorkerCacheRead[] = [];
    const stub = env.CACHE_DO.getByName('failing').with(cacheTier(reads));

    await expect(stub.failValue('k')).rejects.toThrow('No value for k');
    expect(reads).toEqual([
      {
        method: 'failValue',
        outcome: 'fallback',
        error: new CachedCallError('failValue', 503),
      },
    ]);
  });
});

describe('workerCacheTier requests', () => {
  it('addresses one Durable Object, method and canonical arguments', async () => {
    const sent: SentRequest[] = [];

    const tier = workerCacheTier(cacheDOPlan, {
      binding: () =>
        fakeBinding(sent, () =>
          Response.json({ value: { key: 'k', calls: 9 } })
        ),
    });

    const stub = env.CACHE_DO.getByName('addressed');

    await expect(stub.with(tier).getValue('k')).resolves.toEqual({
      key: 'k',
      calls: 9,
    });

    const id = env.CACHE_DO.idFromName('addressed').toString();

    expect(sent).toEqual([
      {
        url: `https://cache.invalid/v1/1/${id}/getValue?args=${encodeURIComponent('["k"]')}`,
        cache: undefined,
      },
    ]);
  });

  it('passes the per-call cache mode as RequestInit.cache', async () => {
    const sent: SentRequest[] = [];

    const tier = workerCacheTier(cacheDOPlan, {
      binding: () => fakeBinding(sent, () => Response.json({})),
    });

    const stub = env.CACHE_DO.getByName('modes');

    await stub.with(tier, { cache: 'no-cache' }).getNothing();
    await stub.with(tier, { cache: 'no-store' }).getNothing();

    expect(sent.map((request) => request.cache)).toEqual([
      'no-cache',
      'no-store',
    ]);
  });

  it('reports the cache status header', async () => {
    const reads: WorkerCacheRead[] = [];

    const tier = workerCacheTier(cacheDOPlan, {
      binding: () =>
        fakeBinding(
          [],
          () =>
            new Response('{}', {
              headers: { 'cf-cache-status': 'HIT' },
            })
        ),
      onRead: (read) => reads.push(read),
    });

    await env.CACHE_DO.getByName('status').with(tier).getNothing();

    expect(reads).toEqual([
      { method: 'getNothing', outcome: 'cache', cacheStatus: 'HIT' },
    ]);
  });

  it('throws CachedCallError instead of falling back when asked to', async () => {
    const reads: WorkerCacheRead[] = [];

    const tier = workerCacheTier(cacheDOPlan, {
      binding: () => fakeBinding([], () => new Response(null, { status: 500 })),
      fallback: 'throw',
      onRead: (read) => reads.push(read),
    });

    const call = env.CACHE_DO.getByName('throws').with(tier).getValue('a');

    await expect(call).rejects.toBeInstanceOf(CachedCallError);
    await expect(call).rejects.toMatchObject({
      method: 'getValue',
      status: 500,
    });
    expect(reads.map((read) => read.outcome)).toEqual(['failed']);
  });

  it('falls back when the cached body is not a cached result', async () => {
    const reads: WorkerCacheRead[] = [];

    const tier = workerCacheTier(cacheDOPlan, {
      binding: () => fakeBinding([], () => new Response('[1, 2]')),
      onRead: (read) => reads.push(read),
    });

    await expect(
      env.CACHE_DO.getByName('invalid-body').with(tier).getValue('a')
    ).resolves.toEqual({ key: 'a', calls: 1 });
    expect(reads.map((read) => read.outcome)).toEqual(['fallback']);
  });

  it('calls the target directly when the cache URL would be too long', async () => {
    const sent: SentRequest[] = [];
    const reads: WorkerCacheRead[] = [];

    const tier = workerCacheTier(cacheDOPlan, {
      binding: () => fakeBinding(sent, () => Response.json({})),
      onRead: (read) => reads.push(read),
    });

    const key = 'k'.repeat(5_000);

    await expect(
      env.CACHE_DO.getByName('long').with(tier).getValue(key)
    ).resolves.toEqual({ key, calls: 1 });
    expect(sent).toEqual([]);
    expect(reads.map((read) => read.outcome)).toEqual(['direct']);
  });
});
