import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { cachedCallUrl, parseCachedCall } from '../src/cache/call';
import { cachePlan, serveCached, type IsJson } from '../src/cache/index';
import { decodeResult, encodeResult, toJson } from '../src/cache/json';
import { cacheControl } from '../src/cache/plan';
import { cacheDOPlan } from './worker';

type Metadata = { id: number; tags: string[]; note?: string };

interface MetadataInterface {
  id: number;
}

class Account {
  async getMetadata(id: number): Promise<Metadata> {
    return { id, tags: [] };
  }

  async getInterface(id: number): Promise<MetadataInterface> {
    return { id };
  }

  async findMetadata(id: number, note?: string): Promise<Metadata | undefined> {
    return note === undefined ? undefined : { id, tags: [], note };
  }

  async getCreatedAt(): Promise<Date> {
    return new Date(0);
  }

  async setPlan(plan: string): Promise<void> {
    void plan;
  }

  async byDate(date: Date): Promise<string> {
    return date.toISOString();
  }

  getSync(): number {
    return 1;
  }
}

function assertPlanTypes() {
  cachePlan<Account>()({
    getMetadata: { location: { fresh: 1_000, stale: 1_000 } },
    getInterface: { location: { fresh: 1_000, stale: 1_000 } },
    findMetadata: { location: { fresh: 1_000, stale: 1_000 } },
  });

  cachePlan<Account>()({
    // @ts-expect-error a Date result does not round-trip through JSON
    getCreatedAt: { location: { fresh: 1_000, stale: 1_000 } },
  });

  cachePlan<Account>()({
    // @ts-expect-error a method that returns nothing has nothing to cache
    setPlan: { location: { fresh: 1_000, stale: 1_000 } },
  });

  cachePlan<Account>()({
    // @ts-expect-error a Date argument does not round-trip through JSON
    byDate: { location: { fresh: 1_000, stale: 1_000 } },
  });

  cachePlan<Account>()({
    // @ts-expect-error only async methods are cacheable
    getSync: { location: { fresh: 1_000, stale: 1_000 } },
  });

  const isJson: IsJson<{ nested: { values: number[] } }> = true;
  const isNotJson: IsJson<{ callback: () => void }> = false;

  void isJson;
  void isNotJson;
}

void assertPlanTypes;

describe('cachePlan', () => {
  it('rejects windows that the Workers cache cannot follow', () => {
    const plan = cachePlan<Account>();

    expect(() =>
      plan({ getMetadata: { location: { fresh: 500, stale: 1_000 } } })
    ).toThrow(RangeError);
    expect(() =>
      plan({ getMetadata: { location: { fresh: 2_000, stale: 1_000 } } })
    ).toThrow('location.stale of getMetadata');
    expect(() =>
      plan({
        getMetadata: {
          location: { fresh: 1_000, stale: 1_000 },
          staleIfError: Number.NaN,
        },
      })
    ).toThrow('staleIfError of getMetadata');
    expect(() => cachePlan<Account>({ version: 0 })).toThrow(RangeError);
  });

  it('builds Cache-Control from the location windows', () => {
    expect(
      cacheControl({
        location: { fresh: 60_000, stale: 86_400_000 },
        staleIfError: 3_600_500,
      })
    ).toBe(
      'public, max-age=60, stale-while-revalidate=86340, stale-if-error=3600'
    );
    expect(cacheControl({ location: { fresh: 1_000, stale: 1_000 } })).toBe(
      'public, max-age=1, stale-while-revalidate=0, stale-if-error=1'
    );
  });
});

describe('cache JSON', () => {
  it('drops undefined properties and rejects values JSON cannot hold', () => {
    expect(toJson({ a: 1, b: undefined, c: [null, 'x'] }, 'value')).toEqual({
      a: 1,
      c: [null, 'x'],
    });
    expect(() => toJson({ at: new Date(0) }, 'value')).toThrow(
      'value.at is not a JSON value'
    );
    expect(() => toJson([1, undefined], 'value')).toThrow('value[1]');
    expect(() => toJson(Number.POSITIVE_INFINITY, 'value')).toThrow(TypeError);
    expect(() => toJson(new Map(), 'value')).toThrow(TypeError);
  });

  it('round-trips results, including undefined', () => {
    expect(decodeResult(encodeResult({ a: [1] }))).toEqual({ a: [1] });
    expect(decodeResult(encodeResult(null))).toBeNull();
    expect(decodeResult(encodeResult(undefined))).toBeUndefined();
    expect(() => decodeResult('[]')).toThrow(TypeError);
  });
});

describe('cached call URLs', () => {
  it('encodes arguments with sorted keys', () => {
    const call = {
      planVersion: 2,
      instance: '_',
      method: 'find',
      args: [{ b: 1, a: [{ d: 1, c: 2 }] }],
    };

    const reordered = {
      ...call,
      args: [{ a: [{ c: 2, d: 1 }], b: 1 }],
    };

    expect(cachedCallUrl(call)).toBe(cachedCallUrl(reordered));
    expect(parseCachedCall(cachedCallUrl(call))).toEqual(reordered);
  });

  it('rejects URLs it did not build', () => {
    expect(
      parseCachedCall('https://cache.invalid/v1/1/_/find')
    ).toBeUndefined();
    expect(
      parseCachedCall('https://cache.invalid/v2/1/_/find?args=[]')
    ).toBeUndefined();
    expect(
      parseCachedCall('https://cache.invalid/v1/1/_/find/extra?args=[]')
    ).toBeUndefined();
    expect(
      parseCachedCall('https://cache.invalid/v1/1/_/find?args={}')
    ).toBeUndefined();
    expect(
      parseCachedCall('https://cache.invalid/v1/1/_/find?args=%E0')
    ).toBeUndefined();
  });
});

describe('serveCached', () => {
  const id = () => env.CACHE_DO.idFromName('served').toString();

  const request = (url: string, method = 'GET') =>
    serveCached(new Request(url, { method }), cacheDOPlan, {
      namespace: env.CACHE_DO,
    });

  it('answers a planned method with Cache-Control from the plan', async () => {
    const response = await request(
      cachedCallUrl({
        planVersion: 1,
        instance: id(),
        method: 'getValue',
        args: ['a'],
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=60, stale-while-revalidate=60, stale-if-error=120'
    );
    expect(decodeResult(await response.text())).toEqual({ key: 'a', calls: 1 });
  });

  it('answers everything else with no-store', async () => {
    const planned = (method: string, planVersion = 1, instance = id()) =>
      cachedCallUrl({ planVersion, instance, method, args: ['a'] });

    const responses = await Promise.all([
      request(planned('getValue'), 'POST'),
      request('https://cache.invalid/other'),
      request(planned('getValue', 2)),
      request(planned('setValue')),
      request(planned('getValue', 1, 'not-an-id')),
      request(planned('failValue')),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      405, 400, 400, 404, 400, 503,
    ]);

    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('reports a target that throws', async () => {
    const errors: unknown[] = [];

    const response = await serveCached(
      new Request(
        cachedCallUrl({
          planVersion: 1,
          instance: id(),
          method: 'failValue',
          args: ['k'],
        })
      ),
      cacheDOPlan,
      {
        namespace: env.CACHE_DO,
        onError: (error) => errors.push(error),
      }
    );

    expect(response.status).toBe(503);
    expect(errors).toEqual([
      expect.objectContaining({ message: 'No value for k' }),
    ]);
  });

  it('calls targets that are not Durable Objects without an instance', async () => {
    const plan = cachePlan<Account>()({
      getMetadata: { location: { fresh: 1_000, stale: 1_000 } },
    });

    const url = (instance: string) =>
      cachedCallUrl({
        planVersion: 1,
        instance,
        method: 'getMetadata',
        args: [7],
      });

    const served = await serveCached(new Request(url('_')), plan, {
      target: new Account(),
    });

    const addressed = await serveCached(new Request(url(id())), plan, {
      target: new Account(),
    });

    expect(decodeResult(await served.text())).toEqual({ id: 7, tags: [] });
    expect(addressed.status).toBe(400);
  });
});
