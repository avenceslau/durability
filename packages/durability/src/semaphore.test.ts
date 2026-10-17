import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurabilityScheduler } from './index';
import { SemaphoreClient } from './semaphore-client';
import type {
  PermitGrant,
  PermitRequest,
  SemaphoreRequest,
} from './semaphore-protocol';
import {
  DurabilitySemaphoreServer,
  type DurabilitySemaphoreConfig,
  type DurabilitySemaphoreEvent,
} from './semaphore-server';
import { FakeStorage } from './test-fakes';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const request = (
  clientId: string,
  demand: PermitRequest['demand'],
  grants: PermitRequest['grants'] = []
): PermitRequest => ({ type: 'request', v: 1, clientId, demand, grants });

/** A request from a client that accepts leases. */
const leasing = (
  clientId: string,
  demand: PermitRequest['demand'],
  leases: NonNullable<PermitRequest['leases']> = []
): PermitRequest => ({
  type: 'request',
  v: 1,
  clientId,
  demand,
  grants: [],
  leases,
});

const leased = (grant: PermitGrant) =>
  (grant.leases ?? []).map(({ group, permits, expiresAt }) => ({
    group,
    permits,
    retired: expiresAt <= Date.now(),
  }));

const given = (grant: PermitGrant) =>
  grant.grants.map(({ group, permits }) => ({ group, permits }));

describe('semaphore', () => {
  const fixture = (
    options: Partial<
      Omit<DurabilitySemaphoreConfig, 'scheduler' | 'context'>
    > = {}
  ) => {
    const storage = new FakeStorage();
    const scheduler = new DurabilityScheduler({
      context: { storage: storage as unknown as DurableObjectStorage },
    });
    const events: DurabilitySemaphoreEvent[] = [];
    const semaphore = new DurabilitySemaphoreServer({
      scheduler,
      limit: 10,
      onLifecycleEvent: (event) => {
        events.push(event);
      },
      ...options,
    } as DurabilitySemaphoreConfig);
    /** Sends a request and runs the round it joins. */
    const round = async (...requests: PermitRequest[]) => {
      const replies = requests.map((message) => semaphore.handle(message));
      await vi.advanceTimersByTimeAsync(2_000);
      return Promise.all(replies) as Promise<PermitGrant[]>;
    };
    const grantOf = (message: PermitRequest) =>
      semaphore.handle(message) as Promise<PermitGrant>;
    return { storage, scheduler, semaphore, events, round, grantOf };
  };

  it('allocates one round in arrival order and attributes the limit', async () => {
    const { semaphore, round, events } = fixture();
    const start = Date.now();
    const [late, early] = await round(
      request('late', [{ group: 'g', count: 6, oldestAt: 200 }]),
      request('early', [{ group: 'g', count: 6, oldestAt: 100 }])
    );

    expect(given(early!)).toEqual([{ group: 'g', permits: 6 }]);
    expect(given(late!)).toEqual([{ group: 'g', permits: 4 }]);
    expect(late!.blocked).toEqual([{ group: 'g', reason: 'limit' }]);
    // The round ran after roundWaitMs; the next may start roundPeriodMs later.
    expect(early!.nextRequestAt).toBe(start + 1_000 + 2_000);
    expect(await semaphore.usage()).toMatchObject({
      limit: 10,
      granted: 10,
      available: 0,
    });
    expect(events.map((event) => event.type)).toEqual(['round', 'blocked']);
    expect(events[1]).toMatchObject({
      group: 'g',
      reason: 'limit',
      count: 2,
    });
  });

  it('checks the group limit before the shared limit and fails closed on errors', async () => {
    const { round } = fixture({
      groupLimit: (group) => {
        if (group === 'broken') {
          throw new Error('lookup failed');
        }
        return group === 'small' ? 2 : undefined;
      },
      canGrant: (group) => group !== 'denied',
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [grant] = await round(
      request('c', [
        { group: 'small', count: 5, oldestAt: 1 },
        { group: 'broken', count: 1, oldestAt: 2 },
        { group: 'denied', count: 1, oldestAt: 3 },
        { group: 'open', count: 20, oldestAt: 4 },
      ])
    );

    expect(given(grant!)).toEqual([
      { group: 'small', permits: 2 },
      { group: 'open', permits: 8 },
    ]);
    expect(grant!.blocked).toEqual([
      { group: 'small', reason: 'group_limit' },
      { group: 'broken', reason: 'limit_resolution_error' },
      { group: 'denied', reason: 'not_permitted' },
      { group: 'open', reason: 'limit' },
    ]);
  });

  it('applies claim and release reports as clamped high-water marks', async () => {
    const { semaphore, round } = fixture();
    const [grant] = await round(
      request('c', [{ group: 'g', count: 4, oldestAt: 1 }])
    );
    const grantId = grant!.grants[0]!.grantId;
    const sync = (clientId: string, claimed: number, released: number) =>
      semaphore.handle({
        type: 'sync',
        v: 1,
        clientId,
        grants: [{ grantId, claimed, released }],
      });

    await expect(sync('c', 3, 1)).resolves.toMatchObject({
      grantResults: [{ grantId, claimed: 3, status: 'ok' }],
    });
    // A replayed or stale report moves nothing backwards.
    await expect(sync('c', 2, 0)).resolves.toMatchObject({
      grantResults: [{ grantId, claimed: 3, status: 'ok' }],
    });
    // Releases are bounded by claims, claims by permits.
    await expect(sync('c', 9, 9)).resolves.toMatchObject({
      grantResults: [{ grantId, claimed: 4, status: 'ok' }],
    });
    expect((await semaphore.usage()).granted).toBe(0);
    await expect(sync('c', 4, 4)).resolves.toMatchObject({
      grantResults: [{ grantId, status: 'not_found' }],
    });
    await expect(sync('other', 1, 0)).resolves.toMatchObject({
      grantResults: [{ grantId, claimed: 0, status: 'not_found' }],
    });
  });

  it('reclaims unclaimed permits after the grant timeout', async () => {
    const { semaphore, round, events } = fixture({
      grantTimeoutMs: 5_000,
    });
    const [grant] = await round(
      request('c', [{ group: 'g', count: 4, oldestAt: 1 }])
    );
    const grantId = grant!.grants[0]!.grantId;
    await semaphore.handle({
      type: 'sync',
      v: 1,
      clientId: 'c',
      grants: [{ grantId, claimed: 1, released: 0 }],
    });
    vi.setSystemTime(Date.now() + 5_000);
    await semaphore.alarm();
    expect(await semaphore.usage()).toMatchObject({
      granted: 1,
      available: 9,
    });
    expect(events[events.length - 1]).toMatchObject({
      type: 'grant_reclaimed',
      grantId,
      permits: 3,
    });

    // A late claim beyond the reclaimed permits is clamped and flagged.
    await expect(
      semaphore.handle({
        type: 'sync',
        v: 1,
        clientId: 'c',
        grants: [{ grantId, claimed: 3, released: 0 }],
      })
    ).resolves.toMatchObject({
      grantResults: [{ grantId, claimed: 1, status: 'expired' }],
    });
  });

  it('frees reported releases before allocating in the same round', async () => {
    const { round } = fixture({ limit: 4 });
    const [first] = await round(
      request('a', [{ group: 'g', count: 4, oldestAt: 1 }])
    );
    const grantId = first!.grants[0]!.grantId;

    const [second] = await round(
      request(
        'a',
        [{ group: 'g', count: 2, oldestAt: 2 }],
        [{ grantId, claimed: 4, released: 3 }]
      )
    );
    expect(given(second!)).toEqual([{ group: 'g', permits: 2 }]);
    expect(second!.grantResults).toEqual([
      { grantId, claimed: 4, status: 'ok' },
    ]);
  });

  it('coalesces requests into rounds no closer than the period', async () => {
    const { grantOf } = fixture({
      roundWaitMs: 1_000,
      roundPeriodMs: 3_000,
    });
    const first = grantOf(
      request('a', [{ group: 'g', count: 1, oldestAt: 1 }])
    );
    await vi.advanceTimersByTimeAsync(500);
    const second = grantOf(
      request('b', [{ group: 'g', count: 1, oldestAt: 2 }])
    );
    await vi.advanceTimersByTimeAsync(500);
    const roundAt = Date.now();
    expect((await first).nextRequestAt).toBe(roundAt + 3_000);
    expect((await second).nextRequestAt).toBe(roundAt + 3_000);

    const third = grantOf(
      request('c', [{ group: 'g', count: 1, oldestAt: 3 }])
    );
    let settled = false;
    void third.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await third).nextRequestAt).toBe(roundAt + 6_000);
  });

  it('never overlaps rounds when limit resolution is slow', async () => {
    let resolveLimit!: (limit: number) => void;
    const { semaphore, grantOf } = fixture({
      roundWaitMs: 100,
      roundPeriodMs: 100,
      limit: () =>
        new Promise<number>((resolve) => {
          resolveLimit = resolve;
        }),
    });
    const first = grantOf(
      request('a', [{ group: 'g', count: 1, oldestAt: 1 }])
    );
    await vi.advanceTimersByTimeAsync(100);
    // The round is now awaiting limit(); this request must join the next round.
    const second = grantOf(
      request('b', [{ group: 'g', count: 1, oldestAt: 2 }])
    );
    await vi.advanceTimersByTimeAsync(1_000);
    let secondSettled = false;
    void second.finally(() => {
      secondSettled = true;
    });
    expect(secondSettled).toBe(false);

    resolveLimit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(given(await first)).toEqual([{ group: 'g', permits: 1 }]);
    await vi.advanceTimersByTimeAsync(100);
    resolveLimit(1);
    await vi.advanceTimersByTimeAsync(0);
    expect((await second).blocked).toEqual([{ group: 'g', reason: 'limit' }]);
    expect((await second).nextRequestAt).toBeGreaterThan(
      (await first).nextRequestAt
    );
    const usage = semaphore.usage();
    resolveLimit(1);
    expect((await usage).granted).toBe(1);
  });

  it('handles more grants than one storage page', async () => {
    const { semaphore, round } = fixture({ limit: 300 });
    const clients = Array.from({ length: 130 }, (_, index) =>
      request(`client-${String(index).padStart(3, '0')}`, [
        { group: 'g', count: 1, oldestAt: index },
      ])
    );
    const grants = await round(...clients);
    expect(grants.every((grant) => grant.grants.length === 1)).toBe(true);
    expect((await semaphore.usage()).granted).toBe(130);

    // Release half; the rest stays outstanding.
    for (const [index, grant] of grants.entries()) {
      if (index % 2 === 0) {
        // eslint-disable-next-line no-await-in-loop
        await semaphore.handle({
          type: 'sync',
          v: 1,
          clientId: clients[index]!.clientId,
          grants: [
            { grantId: grant.grants[0]!.grantId, claimed: 1, released: 1 },
          ],
        });
      }
    }
    expect((await semaphore.usage()).granted).toBe(65);
  });

  it('rejects malformed messages and failed rounds', async () => {
    const { semaphore } = fixture({
      limit: (): number => {
        throw new Error('limit unavailable');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      semaphore.handle({ type: 'nonsense' } as unknown as SemaphoreRequest)
    ).rejects.toThrow('Malformed semaphore message');
    await expect(
      semaphore.handle(
        request(
          'a',
          Array.from({ length: 101 }, (_, index) => ({
            group: `g${index}`,
            count: 1,
            oldestAt: 1,
          }))
        )
      )
    ).rejects.toThrow('Malformed semaphore message');

    await expect(
      Promise.all([
        semaphore.handle(request('a', [{ group: 'g', count: 1, oldestAt: 1 }])),
        vi.advanceTimersByTimeAsync(1_000),
      ])
    ).rejects.toThrow('limit unavailable');
  });

  describe('leases', () => {
    it('over: leases come from a budget above the limit', async () => {
      const { semaphore, round } = fixture({
        limit: 2,
        leases: { provisioning: { mode: 'over', extra: 4 } },
      });
      const [first] = await round(
        leasing('a', [{ group: 'g', count: 5, oldestAt: 1 }])
      );
      expect(given(first!)).toEqual([{ group: 'g', permits: 2 }]);
      expect(leased(first!)).toEqual([
        { group: 'g', permits: 4, retired: false },
      ]);
      expect(await semaphore.usage()).toMatchObject({
        granted: 2,
        leased: 4,
        available: 0,
      });

      // Budget exhausted on both sides; a client without lease support gets nothing extra.
      const [second] = await round(
        request('b', [{ group: 'g', count: 1, oldestAt: 2 }])
      );
      expect(given(second!)).toEqual([]);
      expect(second!.leases).toBeUndefined();
    });

    it('under: a reserve inside the limit is kept for leases', async () => {
      const { semaphore, round } = fixture({
        limit: 10,
        leases: { provisioning: { mode: 'under', reserve: 4 } },
      });
      const [grant] = await round(
        leasing('a', [{ group: 'g', count: 10, oldestAt: 1 }])
      );
      expect(given(grant!)).toEqual([{ group: 'g', permits: 6 }]);
      expect(leased(grant!)).toEqual([
        { group: 'g', permits: 4, retired: false },
      ]);
      expect(await semaphore.usage()).toMatchObject({
        limit: 10,
        granted: 6,
        leased: 4,
        available: 0,
      });
    });

    it('strict: grants and lease footprint share the limit, grants first', async () => {
      const { semaphore, round } = fixture({
        limit: 10,
        leases: { provisioning: { mode: 'strict' } },
      });
      const [first] = await round(
        leasing('a', [{ group: 'g', count: 7, oldestAt: 1 }])
      );
      expect(given(first!)).toEqual([{ group: 'g', permits: 7 }]);
      expect(leased(first!)).toEqual([
        { group: 'g', permits: 3, retired: false },
      ]);
      const leaseId = first!.leases![0]!.leaseId;

      // The lease's footprint is reserved: nothing left for another client.
      const [second] = await round(
        leasing('b', [{ group: 'g', count: 1, oldestAt: 2 }])
      );
      expect(given(second!)).toEqual([]);
      expect(second!.blocked).toEqual([{ group: 'g', reason: 'limit' }]);

      // Fully releasing the lease frees its footprint in the same round: b
      // gets its grant, and a lease from what is left.
      const [third, fourth] = await round(
        leasing('a', [], [{ leaseId, drawn: 3, released: 3 }]),
        leasing('b', [{ group: 'g', count: 1, oldestAt: 2 }])
      );
      expect(leased(third!)).toEqual([
        { group: 'g', permits: 3, retired: true },
      ]);
      expect(given(fourth!)).toEqual([{ group: 'g', permits: 1 }]);
      expect(leased(fourth!)).toEqual([
        { group: 'g', permits: 2, retired: false },
      ]);
      expect(await semaphore.usage()).toMatchObject({
        granted: 8,
        leased: 2,
        available: 0,
      });
    });

    it('heartbeats, sweeps, and charges leases the holder no longer knows', async () => {
      const { semaphore, round } = fixture({
        limit: 1,
        leases: { provisioning: { mode: 'over', extra: 4 }, ttlMs: 5_000 },
      });
      const [first] = await round(
        leasing('a', [{ group: 'g', count: 3, oldestAt: 1 }])
      );
      const leaseId = first!.leases![0]!.leaseId;
      expect(leased(first!)).toEqual([
        { group: 'g', permits: 4, retired: false },
      ]);

      // A report within the TTL refreshes it (the lease was issued 1s ago).
      vi.setSystemTime(Date.now() + 3_000);
      const refreshed = (await semaphore.handle({
        type: 'sync',
        v: 1,
        clientId: 'a',
        grants: [],
        leases: [{ leaseId, drawn: 2, released: 0 }],
      })) as { leases?: { expiresAt: number }[] };
      expect(refreshed.leases![0]!.expiresAt).toBe(Date.now() + 5_000);

      // Silence past the TTL sweeps it; a stale report is retired and its
      // live footprint is charged against this round's budget.
      vi.setSystemTime(Date.now() + 6_000);
      const [stale, fresh] = await round(
        leasing('a', [], [{ leaseId, drawn: 2, released: 0 }]),
        leasing('b', [{ group: 'g', count: 1, oldestAt: 3 }])
      );
      expect(leased(stale!)).toEqual([
        { group: 'g', permits: 4, retired: true },
      ]);
      // Budget 4 minus unknown debt 2 leaves a lease of 2.
      expect(leased(fresh!)).toEqual([
        { group: 'g', permits: 2, retired: false },
      ]);
    });

    it('excludes limited groups unless leasing within the group limit', async () => {
      const excluded = fixture({
        limit: 10,
        groupLimit: (group) => (group === 'capped' ? 3 : undefined),
        leases: { provisioning: { mode: 'over', extra: 10 } },
      });
      const [first] = await excluded.round(
        leasing('a', [{ group: 'capped', count: 5, oldestAt: 1 }])
      );
      expect(given(first!)).toEqual([{ group: 'capped', permits: 3 }]);
      expect(leased(first!)).toEqual([]);

      const within = fixture({
        limit: 10,
        groupLimit: (group) => (group === 'capped' ? 3 : undefined),
        leases: {
          provisioning: { mode: 'over', extra: 10 },
          limitedGroups: 'withinGroupLimit',
        },
      });
      const [second] = await within.round(
        leasing('a', [{ group: 'capped', count: 2, oldestAt: 1 }])
      );
      expect(given(second!)).toEqual([{ group: 'capped', permits: 2 }]);
      expect(leased(second!)).toEqual([
        { group: 'capped', permits: 1, retired: false },
      ]);
    });
  });

  it('drives the holder through SemaphoreClient', async () => {
    const { semaphore } = fixture();
    const invoked: string[] = [];
    const client = new SemaphoreClient({
      invoke: (address, message) => {
        invoked.push(`${address.key}:${address.locationHint}`);
        return semaphore.handle(message);
      },
      locationHint: () => 'weur',
    });

    const reply = client.request(
      'acct',
      request('c', [{ group: 'g', count: 1, oldestAt: 1 }])
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const grant = await reply;
    expect(client.nextRequestAt('acct')).toBe(grant.nextRequestAt);
    expect(invoked).toEqual(['acct:weur']);
    await expect(
      client.sync('acct', { type: 'sync', v: 1, clientId: 'c', grants: [] })
    ).resolves.toMatchObject({ type: 'synced' });

    const broken = new SemaphoreClient({
      invoke: async () => ({ type: 'synced', v: 1, grantResults: [] }),
    });
    await expect(broken.request('acct', request('c', []))).rejects.toThrow(
      /Unexpected response/
    );
    await expect(
      broken.sync('', { type: 'sync', v: 1, clientId: 'c', grants: [] })
    ).rejects.toThrow(/non-empty/);
  });
});
