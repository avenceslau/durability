import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopologyUnavailableError } from './errors';
import { DurabilityTopology } from './topology';
import type { TopologyClientConfig } from './topology-client';
import { encodeSnapshot, type TopologySnapshot } from './topology-snapshot';

const snapshot = (
  version: number,
  overrides: Partial<TopologySnapshot> = {}
): TopologySnapshot => ({
  group: 'acme',
  version,
  coordinator: 'coordinator-1',
  members: [{ id: 'acme-0', state: 'active', joinedAt: 1 }],
  ...overrides,
});

const clientFor = (
  read: TopologyClientConfig['read'],
  config: Omit<TopologyClientConfig, 'read'> = {}
) => {
  const reads = vi.fn(read);
  const fallbacks: Array<{ reason: string; source: string }> = [];
  const client = DurabilityTopology.client({
    ttlMs: 10_000,
    negativeTtlMs: 1_000,
    onFallback: ({ reason, source }) => fallbacks.push({ reason, source }),
    ...config,
    read: reads,
  });
  return { client, reads, fallbacks };
};

const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(TopologyUnavailableError);
  return (error as TopologyUnavailableError).reason;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('topology client', () => {
  it('shares one read between concurrent callers and caches until the TTL', async () => {
    const { client, reads } = clientFor(async () =>
      encodeSnapshot(snapshot(1))
    );

    const [first, second] = await Promise.all([
      client.get('acme'),
      client.get('acme'),
    ]);
    expect(first).toMatchObject({ version: 1, source: 'published' });
    expect(second).toBe(first);
    expect(reads).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(9_999);
    await client.get('acme');
    expect(reads).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await client.get('acme');
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used group, not the oldest fetched', async () => {
    const { client, reads } = clientFor(async (group) =>
      encodeSnapshot(snapshot(1, { group }))
    );
    await client.get('hot');
    for (let index = 0; index < 1_023; index++) {
      // eslint-disable-next-line no-await-in-loop
      await client.get(`cold-${index}`);
    }
    await client.get('hot');
    await client.get('one-more');
    await client.get('hot');

    expect(reads.mock.calls.filter(([group]) => group === 'hot')).toHaveLength(
      1
    );
  });

  it('throws without fallbacks, naming why the published copy was unusable', async () => {
    expect(await reasonOf(clientFor(async () => null).client.get('acme'))).toBe(
      'missing'
    );
    expect(
      await reasonOf(clientFor(async () => '{"nope":1}').client.get('acme'))
    ).toBe('invalid');
    expect(
      await reasonOf(
        clientFor(async () => {
          throw new Error('kv down');
        }).client.get('acme')
      )
    ).toBe('error');

    const hanging = clientFor(() => new Promise<string>(() => undefined));
    const pending = reasonOf(hanging.client.get('acme'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBe('timeout');
  });

  it('rejects a snapshot stored under the wrong group', async () => {
    const otherGroup = clientFor(async () =>
      encodeSnapshot(snapshot(1, { group: 'other' }))
    );
    expect(await reasonOf(otherGroup.client.get('acme'))).toBe('invalid');
  });

  it('remembers a failed read so a broken store is not hit on every call', async () => {
    const { client, reads } = clientFor(async () => null);
    await reasonOf(client.get('acme'));
    await reasonOf(client.get('acme'));
    expect(reads).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    await reasonOf(client.get('acme'));
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('never replaces a newer snapshot with an older one from the same coordinator', async () => {
    let version = 2;
    const { client } = clientFor(async () => encodeSnapshot(snapshot(version)));
    await client.get('acme');
    version = 1;
    vi.advanceTimersByTime(10_000);
    expect(await client.get('acme')).toMatchObject({ version: 2 });
  });

  it('accepts a lower version from a coordinator the group moved to', async () => {
    let current = snapshot(40);
    const { client } = clientFor(async () => encodeSnapshot(current));
    await client.get('acme');
    current = snapshot(1, { coordinator: 'coordinator-2' });
    vi.advanceTimersByTime(10_000);
    expect(await client.get('acme')).toMatchObject({
      version: 1,
      coordinator: 'coordinator-2',
    });
  });

  it('serves stale only when opted in, only after errors, and only within the window', async () => {
    let failure: 'error' | 'missing' | undefined;
    const read = async () => {
      if (failure === 'error') {
        throw new Error('kv down');
      }
      return failure === 'missing' ? null : encodeSnapshot(snapshot(1));
    };

    const strict = clientFor(read);
    await strict.client.get('acme');
    failure = 'error';
    vi.advanceTimersByTime(10_000);
    expect(await reasonOf(strict.client.get('acme'))).toBe('error');

    failure = undefined;
    const lenient = clientFor(read, { staleIfErrorMs: 5_000 });
    await lenient.client.get('acme');
    failure = 'error';
    vi.advanceTimersByTime(10_000);
    expect(await lenient.client.get('acme')).toMatchObject({
      version: 1,
      source: 'stale',
    });
    expect(lenient.fallbacks).toEqual([{ reason: 'error', source: 'stale' }]);

    vi.advanceTimersByTime(5_000);
    expect(await reasonOf(lenient.client.get('acme'))).toBe('error');

    failure = undefined;
    const deleted = clientFor(read, { staleIfErrorMs: 60_000 });
    await deleted.client.get('acme');
    failure = 'missing';
    vi.advanceTimersByTime(10_000);
    expect(await reasonOf(deleted.client.get('acme'))).toBe('missing');
  });

  it('tries seed, then the application fallback, and only calls the fallback when seed has nothing', async () => {
    const fallback = vi.fn(async () => snapshot(7));
    const seeded = clientFor(async () => null, {
      seed: () => [{ id: 'acme-1', state: 'active' }],
      fallback,
    });
    expect(await seeded.client.get('acme')).toMatchObject({
      version: 0,
      source: 'seed',
      members: [{ id: 'acme-1', state: 'active', joinedAt: 0 }],
    });
    expect(fallback).not.toHaveBeenCalled();

    const unseeded = clientFor(async () => null, {
      seed: () => undefined,
      fallback,
    });
    expect(await unseeded.client.get('acme')).toMatchObject({
      version: 7,
      source: 'fallback',
    });
    expect(fallback).toHaveBeenCalledWith('acme', 'missing');
    expect(unseeded.fallbacks).toEqual([
      { reason: 'missing', source: 'fallback' },
    ]);
  });
});
