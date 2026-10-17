import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurabilityScheduler } from './index';
import {
  DurabilitySemaphoreQueue,
  type AdmittedItem,
  type DurabilitySemaphoreQueueConfig,
  type DurabilitySemaphoreQueueEvent,
} from './semaphore-queue';
import {
  DurabilitySemaphoreServer,
  type DurabilitySemaphoreConfig,
} from './semaphore-server';
import type { PermitGrant } from './semaphore-protocol';
import { FakeStorage } from './test-fakes';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Lets the holder's round timer, early alarms, and outbox publication settle.
 * Zero-delay timers created during a tick land at now + 1 under fake timers,
 * so a short tail runs the early alarms the first advance scheduled.
 */
const settle = async (ms = 1_000) => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(5);
  }
};

describe('semaphore queue', () => {
  const storageFor = () => new FakeStorage();
  const schedulerFor = (storage: FakeStorage) =>
    new DurabilityScheduler({
      context: { storage: storage as unknown as DurableObjectStorage },
    });

  const fixture = (
    holder: Partial<DurabilitySemaphoreConfig> = {},
    queue: Partial<DurabilitySemaphoreQueueConfig<string>> = {}
  ) => {
    const holders = new Map<string, DurabilitySemaphoreServer>();
    const holderFor = (key: string) => {
      let server = holders.get(key);
      if (!server) {
        server = new DurabilitySemaphoreServer({
          scheduler: schedulerFor(storageFor()),
          limit: 2,
          ...holder,
        } as DurabilitySemaphoreConfig);
        holders.set(key, server);
      }
      return server;
    };
    const calls = { request: 0, sync: 0 };
    const admitted: AdmittedItem<string>[] = [];
    const events: DurabilitySemaphoreQueueEvent[] = [];
    const storage = storageFor();
    const scheduler = schedulerFor(storage);
    const queued = new DurabilitySemaphoreQueue<string>({
      scheduler,
      clientId: 'shard-1',
      server: {
        request: async (key, message) => {
          calls.request += 1;
          return holderFor(key).handle(message) as never;
        },
        sync: async (key, message) => {
          calls.sync += 1;
          return holderFor(key).handle(message) as never;
        },
      },
      admit: (items) => {
        admitted.push(...items);
      },
      onLifecycleEvent: (event) => {
        events.push(event);
      },
      ...queue,
    } as DurabilitySemaphoreQueueConfig<string>);
    return {
      storage,
      scheduler,
      queue: queued,
      holderFor,
      calls,
      admitted,
      events,
    };
  };

  it('admits in arrival order once the holder confirms, and frees permits on release', async () => {
    const { queue, holderFor, admitted, events } = fixture();
    await queue.enqueue([
      { id: 'a', key: 'acct', body: 'A' },
      { id: 'b', key: 'acct', body: 'B' },
      { id: 'c', key: 'acct', body: 'C' },
    ]);
    expect(await queue.usage()).toEqual({
      queued: 3,
      claiming: 0,
      admitted: 0,
    });

    // The alarm sends the request; the holder answers after its round.
    await settle();
    expect(await queue.usage()).toEqual({
      queued: 1,
      claiming: 0,
      admitted: 2,
    });
    expect(admitted.map((item) => item.id)).toEqual(['a', 'b']);
    expect(await queue.status('c')).toMatchObject({
      state: 'queued',
      blocked: 'limit',
    });
    expect((await holderFor('acct').usage()).granted).toBe(2);

    expect(await queue.release('a')).toBe(true);
    expect(await queue.release('a')).toBe(false);
    // The next request waits for the holder's nextRequestAt, then its round.
    await settle(4_000);
    expect(admitted.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect((await holderFor('acct').usage()).granted).toBe(2);

    expect(
      events
        .filter((event) => event.type !== 'blocked')
        .map((event) => `${event.type}:${'id' in event ? event.id : ''}`)
    ).toEqual([
      'queued:a',
      'queued:b',
      'queued:c',
      'admitted:a',
      'admitted:b',
      'released:a',
      'admitted:c',
    ]);
  });

  it('skips the request when the key already holds unclaimed permits', async () => {
    const { queue, calls, admitted } = fixture({ limit: 5 });
    await queue.enqueue([{ id: 'a', key: 'acct', body: 'A' }]);
    await settle();
    expect(calls.request).toBe(1);
    await queue.release('a');
    await settle();

    // The holder's grant still has unclaimed permits? No: grants are sized
    // to demand. Enqueue two, get two, release one, enqueue one: the freed
    // permit belongs to the holder, so a new request is needed.
    await queue.enqueue([
      { id: 'b', key: 'acct', body: 'B' },
      { id: 'c', key: 'acct', body: 'C' },
    ]);
    await settle(2_000);
    expect(admitted.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(calls.request).toBe(2);
  });

  it('draws from leases locally and keeps drawn permits one-shot', async () => {
    const { queue, holderFor, admitted, calls } = fixture({
      limit: 2,
      leases: { provisioning: { mode: 'over', extra: 4 } },
    });
    await queue.enqueue(
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, key: 'acct', body: id }))
    );
    await settle();
    // Two through confirmed grants, three drawn from the lease of 4.
    expect(admitted.map((item) => `${item.id}:${item.via}`).sort()).toEqual([
      'a:grant',
      'b:grant',
      'c:lease',
      'd:lease',
      'e:lease',
    ]);
    expect(await holderFor('acct').usage()).toMatchObject({
      granted: 2,
      leased: 4,
    });
    expect(calls.request).toBe(1);

    // The fourth lease permit admits without a request; a release does not
    // make a drawn permit drawable again, so the next item must ask.
    await queue.enqueue([{ id: 'f', key: 'acct', body: 'f' }]);
    await settle(10);
    expect(admitted.map((item) => item.id)).toContain('f');
    expect(calls.request).toBe(1);

    await queue.release('c');
    await queue.enqueue([{ id: 'g', key: 'acct', body: 'g' }]);
    await settle(10);
    expect(admitted.map((item) => item.id)).not.toContain('g');
    expect(await queue.status('g')).toMatchObject({ state: 'queued' });
    await settle(4_000);
    expect(calls.request).toBeGreaterThan(1);
    // The release freed one permit of budget; the holder issued it as a new
    // lease, and 'g' drew from that.
    expect(admitted.find((item) => item.id === 'g')).toMatchObject({
      via: 'lease',
    });
    expect(await holderFor('acct').usage()).toMatchObject({
      granted: 2,
      leased: 4,
    });
  });

  /** A queue against a scripted holder, for protocol edge cases. */
  const scripted = (
    server: DurabilitySemaphoreQueueConfig<string>['server'],
    options: Partial<DurabilitySemaphoreQueueConfig<string>> = {}
  ) => {
    const admitted: AdmittedItem<string>[] = [];
    const queue = new DurabilitySemaphoreQueue<string>({
      scheduler: schedulerFor(storageFor()),
      clientId: 'shard-2',
      server,
      admit: (items) => {
        admitted.push(...items);
      },
      retries: { delay: () => 3_000 },
      ...options,
    } as DurabilitySemaphoreQueueConfig<string>);
    return { queue, admitted };
  };

  const grantOf = (grantId: string, permits: number) => ({
    type: 'grant' as const,
    v: 1 as const,
    grants: [{ grantId, group: '', permits }],
    blocked: [],
    nextRequestAt: Date.now() + 2_000,
    grantResults: [],
  });

  it('releases admitted items that finished reports done, without release()', async () => {
    const done = new Set<string>();
    const asked: string[][] = [];
    const { queue, holderFor, admitted } = fixture(
      { limit: 1 },
      {
        finished: (ids) => {
          asked.push(ids);
          return ids.filter((id) => done.has(id));
        },
        finishedCheckMs: 10_000,
      }
    );
    await queue.enqueue([
      { id: 'a', key: 'acct', body: 'A' },
      { id: 'b', key: 'acct', body: 'B' },
    ]);
    await settle(3_000);
    expect(admitted.map((item) => item.id)).toEqual(['a']);

    // Still running at the first check: nothing is released.
    await settle(10_000);
    expect(asked).toContainEqual(['a']);
    expect(await queue.status('a')).toMatchObject({ state: 'admitted' });

    // 'a' finished, but nobody called release(): the next check returns its permit.
    done.add('a');
    await settle(10_000);
    expect(await queue.status('a')).toBeUndefined();
    await settle(5_000);
    expect(admitted.map((item) => item.id)).toEqual(['a', 'b']);
    expect(await holderFor('acct').usage()).toMatchObject({ granted: 1 });
  });

  it('writes nothing on an alarm run with nothing due', async () => {
    const storage = storageFor();
    const queue = new DurabilitySemaphoreQueue<string>({
      scheduler: schedulerFor(storage),
      clientId: 'shard-4',
      server: {
        request: async () => grantOf('unused', 1),
        sync: async () => ({ type: 'synced', v: 1, grantResults: [] }),
      },
      admit: () => undefined,
      finished: (ids) => ids,
    });
    const transactions = vi.spyOn(storage, 'transaction');
    await queue.alarm();
    // Only the engine's own reconciliation after the run.
    expect(transactions).toHaveBeenCalledTimes(1);
  });

  it('stays idle while the holder keeps a request for its round', async () => {
    const storage = storageFor();
    let answer!: (grant: PermitGrant) => void;
    const queue = new DurabilitySemaphoreQueue<string>({
      scheduler: schedulerFor(storage),
      clientId: 'shard-3',
      server: {
        request: () =>
          new Promise<PermitGrant>((resolve) => {
            answer = resolve;
          }),
        sync: async () => ({ type: 'synced', v: 1, grantResults: [] }),
      },
      admit: () => undefined,
    });
    await queue.enqueue([{ id: 'a', key: 'k', body: 'A' }]);
    await vi.advanceTimersByTimeAsync(5);
    expect(answer).toBeDefined();

    // The key was due when the request left; it must not look due while waiting.
    const transactions = vi.spyOn(storage, 'transaction');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transactions.mock.calls.length).toBeLessThan(5);

    answer(grantOf('g1', 1));
    await settle();
    expect(await queue.status('a')).toMatchObject({ state: 'claiming' });
  });

  it('returns items to the queue when the holder forgot or clamped a grant', async () => {
    let requests = 0;
    const { queue, admitted } = scripted({
      request: async () => {
        requests += 1;
        return grantOf(`g${requests}`, 2);
      },
      sync: async (_key, message) => ({
        type: 'synced',
        v: 1,
        grantResults: message.grants.map((grant) =>
          grant.grantId === 'g1'
            ? {
                grantId: grant.grantId,
                claimed: 0,
                status: 'not_found' as const,
              }
            : {
                grantId: grant.grantId,
                claimed: 1,
                status: 'expired' as const,
              }
        ),
      }),
    });

    await queue.enqueue([
      { id: 'a', key: 'k', body: 'A' },
      { id: 'b', key: 'k', body: 'B' },
    ]);
    // g1 is forgotten by the holder: both items go back to the queue.
    await settle();
    expect(admitted).toEqual([]);
    expect(await queue.usage()).toEqual({
      queued: 2,
      claiming: 0,
      admitted: 0,
    });

    // g2 is clamped to one confirmed claim: 'a' is admitted, 'b' requeued.
    await settle(2_000);
    expect(admitted.map((item) => item.id)).toEqual(['a']);
    expect(await queue.status('b')).toMatchObject({ state: 'queued' });
    expect(requests).toBeGreaterThanOrEqual(2);
  });

  it('never admits beyond confirmed claims when a stale result follows a release', async () => {
    // Grant of 3; the holder confirms the first two claims, then keeps
    // answering with that stale count. After one release deletes a row, a
    // third item claims the spare permit: the stale "claimed: 2" must not
    // admit it, because only two claims were ever confirmed.
    const { queue, admitted } = scripted({
      request: async () => grantOf('g1', 3),
      sync: async (_key, message) => ({
        type: 'synced',
        v: 1,
        grantResults: message.grants.map((grant) => ({
          grantId: grant.grantId,
          claimed: Math.min(grant.claimed, 2),
          status: 'ok' as const,
        })),
      }),
    });
    await queue.enqueue([
      { id: 'a', key: 'k', body: 'A' },
      { id: 'b', key: 'k', body: 'B' },
    ]);
    await settle();
    expect(admitted.map((item) => item.id)).toEqual(['a', 'b']);

    await queue.release('a');
    await queue.enqueue([{ id: 'c', key: 'k', body: 'C' }]);
    await settle(2_500);
    expect(admitted.map((item) => item.id)).toEqual(['a', 'b']);
    expect(await queue.status('c')).toMatchObject({ state: 'claiming' });
  });

  it('keeps an admitted item runnable when the holder forgets its grant', async () => {
    let forget = false;
    const { queue, admitted } = scripted({
      request: async () => grantOf('g1', 1),
      sync: async (_key, message) => ({
        type: 'synced',
        v: 1,
        grantResults: message.grants.map((grant) =>
          forget
            ? {
                grantId: grant.grantId,
                claimed: 0,
                status: 'not_found' as const,
              }
            : {
                grantId: grant.grantId,
                claimed: grant.claimed,
                status: 'ok' as const,
              }
        ),
      }),
    });
    await queue.enqueue([{ id: 'a', key: 'k', body: 'A' }]);
    await settle();
    expect(admitted.map((item) => item.id)).toEqual(['a']);

    forget = true;
    expect(await queue.release('a')).toBe(true);
    await settle();
    expect(await queue.usage()).toEqual({
      queued: 0,
      claiming: 0,
      admitted: 0,
    });
    expect(await queue.status('a')).toBeUndefined();
  });

  it('retries admit() until it returns and reports failures', async () => {
    let fail = true;
    const { queue, admitted } = fixture(
      {},
      {
        retries: { delay: () => 5_000 },
        admit: (items) => {
          if (fail) {
            throw new Error('consumer down');
          }
          admitted.push(...items);
        },
      }
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await queue.enqueue([{ id: 'a', key: 'acct', body: 'A' }]);
    await settle();
    expect(admitted).toEqual([]);
    expect(await queue.status('a')).toMatchObject({ state: 'admitted' });

    fail = false;
    await settle(5_000);
    expect(admitted.map((item) => item.id)).toEqual(['a']);
  });

  it('cancels queued items, deduplicates IDs, and survives a holder outage', async () => {
    let down = true;
    let requests = 0;
    const { queue, admitted } = scripted({
      request: async () => {
        requests += 1;
        if (down) {
          throw new Error('holder unavailable');
        }
        return grantOf('g1', 1);
      },
      sync: async (_key, message) => ({
        type: 'synced',
        v: 1,
        grantResults: message.grants.map((grant) => ({
          grantId: grant.grantId,
          claimed: grant.claimed,
          status: 'ok' as const,
        })),
      }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await queue.enqueue([
      { id: 'a', key: 'k', body: 'A' },
      { id: 'a', key: 'k', body: 'A' },
      { id: 'b', key: 'k', body: 'B' },
    ]);
    expect(result).toEqual({ queued: ['a', 'b'], duplicates: ['a'] });
    expect(await queue.cancel('b')).toBe(true);
    expect(await queue.cancel('b')).toBe(false);

    await settle();
    expect(requests).toBe(1);
    expect(admitted).toEqual([]);

    down = false;
    await settle(3_000);
    expect(admitted.map((item) => item.id)).toEqual(['a']);
    expect(await queue.cancel('a')).toBe(false);
  });
});
