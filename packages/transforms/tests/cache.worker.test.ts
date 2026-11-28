import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  CachedCallError,
  workerCacheTier,
  type WorkerCacheRead,
  type WorkerCacheTierOptions,
} from '../src/cache/index';
import { cacheDOPlan } from './worker';

type SentRequest = { url: string; cache: RequestInit['cache'] };

function fakeBinding(
  sent: SentRequest[],
  respond: (init: RequestInit | undefined) => Response | Promise<Response>
): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      sent.push({ url: String(input), cache: init?.cache });

      return respond(init);
    },
    connect() {
      throw new Error('connect is not used by the cache tier');
    },
  };
}

function cacheTier(
  reads: WorkerCacheRead[],
  options: Omit<Partial<WorkerCacheTierOptions>, 'onRead'> = {}
) {
  return workerCacheTier(cacheDOPlan, {
    binding: () => env.CACHE_READS,
    ...options,
    onRead: (read) => reads.push(read),
  });
}

describe('workerCacheTier through a generated entrypoint', () => {
  it('answers planned methods through the cache entrypoint', async () => {
    const reads: WorkerCacheRead[] = [];
    const stub = env.CACHE_DO.getByName('planned').with(cacheTier(reads));

    await expect(stub.countRead('a')).resolves.toEqual({ key: 'a', reads: 1 });
    expect(reads).toEqual([{ method: 'countRead', outcome: 'cache' }]);
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

    await stub.setReadCount(3);

    await expect(stub.countRead('x')).resolves.toEqual({ key: 'x', reads: 4 });
    expect(reads.map((read) => read.outcome)).toEqual(['direct', 'cache']);
  });

  it('falls back to calling the target when the target fails behind the cache', async () => {
    const reads: WorkerCacheRead[] = [];
    const stub = env.CACHE_DO.getByName('failing').with(cacheTier(reads));

    await expect(stub.failRead('k')).rejects.toThrow('No value for k');
    expect(reads).toEqual([
      {
        method: 'failRead',
        outcome: 'fallback',
        error: new CachedCallError('failRead', 503),
      },
    ]);
  });
});

describe('workerCacheTier requests', () => {
  it('addresses one Durable Object, method and canonical arguments', async () => {
    const sent: SentRequest[] = [];

    const tier = cacheTier([], {
      binding: () =>
        fakeBinding(sent, () =>
          Response.json({ value: { key: 'k', reads: 9 }, loadedAt: 0 })
        ),
    });

    await expect(
      env.CACHE_DO.getByName('addressed').with(tier).countRead('k')
    ).resolves.toEqual({ key: 'k', reads: 9 });

    const id = env.CACHE_DO.idFromName('addressed').toString();

    expect(sent).toEqual([
      {
        url: `https://cache.invalid/v1/1/${id}/countRead?args=${encodeURIComponent('["k"]')}`,
        cache: undefined,
      },
    ]);
  });

  it('passes the per-call cache mode as RequestInit.cache', async () => {
    const sent: SentRequest[] = [];

    const tier = cacheTier([], {
      binding: () => fakeBinding(sent, () => Response.json({ loadedAt: 0 })),
    });

    const stub = env.CACHE_DO.getByName('modes');

    await stub.with(tier, { cache: 'no-cache' }).getNothing();
    await stub.with(tier, { cache: 'no-store' }).getNothing();

    expect(sent.map((request) => request.cache)).toEqual([
      'no-cache',
      'no-store',
    ]);
  });

  it('reports the CF-Cache-Status header', async () => {
    const reads: WorkerCacheRead[] = [];

    const tier = cacheTier(reads, {
      binding: () =>
        fakeBinding(
          [],
          () =>
            new Response('{"loadedAt":0}', {
              headers: { 'cf-cache-status': 'HIT' },
            })
        ),
    });

    await env.CACHE_DO.getByName('status').with(tier).getNothing();

    expect(reads).toEqual([
      { method: 'getNothing', outcome: 'cache', cfCacheStatus: 'HIT' },
    ]);
  });

  it('throws CachedCallError instead of falling back when asked to', async () => {
    const reads: WorkerCacheRead[] = [];

    const tier = cacheTier(reads, {
      binding: () => fakeBinding([], () => new Response(null, { status: 500 })),
      fallback: 'throw',
    });

    const call = env.CACHE_DO.getByName('throws').with(tier).countRead('a');

    await expect(call).rejects.toBeInstanceOf(CachedCallError);
    await expect(call).rejects.toMatchObject({
      method: 'countRead',
      status: 500,
    });
    expect(reads.map((read) => read.outcome)).toEqual(['failed']);
  });

  it('falls back when the cached request times out', async () => {
    const reads: WorkerCacheRead[] = [];

    const tier = cacheTier(reads, {
      timeoutMs: 10,
      binding: () =>
        fakeBinding(
          [],
          (init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(init.signal?.reason)
              );
            })
        ),
    });

    await expect(
      env.CACHE_DO.getByName('timeout').with(tier).countRead('a')
    ).resolves.toEqual({ key: 'a', reads: 1 });
    expect(reads.map((read) => read.outcome)).toEqual(['fallback']);
  });

  it('falls back when the cached body is not a cached result', async () => {
    const reads: WorkerCacheRead[] = [];

    const tier = cacheTier(reads, {
      binding: () => fakeBinding([], () => new Response('[1, 2]')),
    });

    await expect(
      env.CACHE_DO.getByName('invalid-body').with(tier).countRead('a')
    ).resolves.toEqual({ key: 'a', reads: 1 });
    expect(reads.map((read) => read.outcome)).toEqual(['fallback']);
  });

  it('calls the target directly when the cache URL would be too long', async () => {
    const sent: SentRequest[] = [];
    const reads: WorkerCacheRead[] = [];

    const tier = cacheTier(reads, {
      binding: () => fakeBinding(sent, () => Response.json({ loadedAt: 0 })),
    });

    const key = 'k'.repeat(5_000);

    await expect(
      env.CACHE_DO.getByName('long').with(tier).countRead(key)
    ).resolves.toEqual({ key, reads: 1 });
    expect(sent).toEqual([]);
    expect(reads.map((read) => read.outcome)).toEqual(['direct']);
  });
});
