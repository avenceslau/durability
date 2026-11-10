import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurabilityScheduler } from '../index';
import {
  durabilityOutboxMigrations,
  durabilitySemaphoreMigrations,
  durabilitySemaphoreQueueMigrations,
  migrateCapability,
} from '../migrations';
import { DurabilityOutbox } from '../outbox';
import {
  DurabilitySemaphoreQueue,
  type AdmittedItem,
  type SemaphoreHolder,
} from './queue';
import type {
  PermitGrant,
  PermitRequest,
  PermitSync,
  PermitSyncResult,
  SemaphoreRequest,
} from './protocol';
import {
  DurabilitySemaphoreServer,
  type DurabilitySemaphoreConfig,
} from './server';
import { serialize } from '../serialization';
import { contextFor, FakeStorage } from '../test-fakes';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = async (ms = 1_000) => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(5);
  }
};

const schedulerFor = (storage: FakeStorage) =>
  new DurabilityScheduler({ context: contextFor(storage) });

const holderFor = (
  options: Partial<DurabilitySemaphoreConfig> = {},
  storage = new FakeStorage()
) =>
  new DurabilitySemaphoreServer({
    scheduler: schedulerFor(storage),
    limit: 2,
    ...options,
  } as DurabilitySemaphoreConfig);

const round = async (
  holder: DurabilitySemaphoreServer,
  ...requests: PermitRequest[]
): Promise<PermitGrant[]> => {
  const replies = requests.map((message) => holder.handle(message));
  await vi.advanceTimersByTimeAsync(2_000);
  return Promise.all(replies) as Promise<PermitGrant[]>;
};

const leasing = (
  clientId: string,
  count: number,
  clientChannel?: string
): PermitRequest => ({
  type: 'request',
  v: clientChannel === undefined ? 1 : 2,
  clientId,
  ...(clientChannel === undefined ? {} : { clientChannel }),
  demand:
    count === 0
      ? []
      : [
          {
            group: 'g',
            count,
            oldestAt: 1,
          },
        ],
  grants: [],
  leases: [],
});

const sync = (
  holder: DurabilitySemaphoreServer,
  message: Omit<PermitSync, 'type' | 'v'>
) =>
  holder.handle({
    type: 'sync',
    v: message.clientChannel === undefined ? 1 : 2,
    ...message,
  }) as Promise<PermitSyncResult>;

const withoutChannel = <
  Message extends { clientChannel?: string | undefined },
>({
  clientChannel: _ignored,
  ...rest
}: Message): Omit<Message, 'clientChannel'> => rest;

describe('semaphore pools on one object', () => {
  it('keeps limits, grants, and leases of each pool apart', async () => {
    const storage = new FakeStorage();
    const scheduler = schedulerFor(storage);
    const pool = (channel: string | undefined, limit: number) =>
      new DurabilitySemaphoreServer({
        scheduler,
        ...(channel === undefined ? {} : { channel }),
        limit,
        leases: { provisioning: { mode: 'over', extra: 2 } },
      });
    const main = pool(undefined, 2);
    const batch = pool('batch', 3);

    const [fromMain] = await round(main, leasing('c', 5));
    const [fromBatch] = await round(batch, leasing('c', 5));
    expect(fromMain!.grants.map((grant) => grant.permits)).toEqual([2]);
    expect(fromBatch!.grants.map((grant) => grant.permits)).toEqual([3]);
    expect(await main.usage()).toMatchObject({ granted: 2, leased: 2 });
    expect(await batch.usage()).toMatchObject({ granted: 3, leased: 2 });

    // The same client reporting one pool's grant and lease to the other frees nothing.
    const grantId = fromMain!.grants[0]!.grantId;
    const leaseId = fromMain!.leases![0]!.leaseId;
    const crossed = await sync(batch, {
      clientId: 'c',
      grants: [{ grantId, claimed: 2, released: 2 }],
      leases: [{ leaseId, drawn: 2, released: 2, retired: true }],
    });
    expect(crossed.grantResults).toEqual([
      {
        grantId,
        claimed: 0,
        status: 'not_found',
      },
    ]);
    expect(crossed.leases).toEqual([
      {
        leaseId,
        group: '',
        permits: 0,
        expiresAt: Date.now(),
      },
    ]);
    expect(await main.usage()).toMatchObject({ granted: 2, leased: 2 });
    expect(await batch.usage()).toMatchObject({ granted: 3, leased: 2 });

    await expect(
      sync(main, {
        clientId: 'c',
        grants: [{ grantId, claimed: 2, released: 2 }],
      })
    ).resolves.toMatchObject({
      grantResults: [{ grantId, claimed: 2, status: 'ok' }],
    });
    expect(await main.usage()).toMatchObject({ granted: 0 });
    expect(await batch.usage()).toMatchObject({ granted: 3 });

    expect(() => pool('batch', 1)).toThrow(/already attached/);
  });

  it('reclaims each pool on its own and retains a pool no instance attached', async () => {
    const storage = new FakeStorage();
    const scheduler = schedulerFor(storage);
    const main = new DurabilitySemaphoreServer({ scheduler, limit: 2 });
    await round(main, leasing('c', 1));
    // Left by a pool a deploy removed: unclaimed and long past its window.
    storage.sql.exec(
      `INSERT INTO durability_semaphore_grants
         (channel, grant_id, client_id, client_channel, grp, permits, claimed,
          released, created_at, expires_at)
       VALUES ('gone', 'old', 'c', 'default', 'g', 4, 1, 0, 0, 1)`
    );

    vi.setSystemTime(Date.now() + 10_000);
    await main.alarm();
    expect((await main.usage()).granted).toBe(0);
    expect(
      storage.sql
        .exec(
          "SELECT permits FROM durability_semaphore_grants WHERE channel = 'gone'"
        )
        .toArray()
    ).toEqual([{ permits: 4 }]);

    const gone = new DurabilitySemaphoreServer({
      scheduler,
      channel: 'gone',
      limit: 5,
    });
    await gone.alarm();
    expect(
      storage.sql
        .exec(
          "SELECT permits FROM durability_semaphore_grants WHERE channel = 'gone'"
        )
        .toArray()
    ).toEqual([{ permits: 1 }]);
  });
});

describe('semaphore client channels', () => {
  it('counts one clientId separately per client channel', async () => {
    const holder = holderFor({
      limit: 4,
      leases: {
        provisioning: { mode: 'over', extra: 4 },
        permitsPerLease: 2,
      },
    });
    const [plain, side] = await round(
      holder,
      leasing('shard', 2),
      leasing('shard', 2, 'side')
    );
    expect(plain).not.toHaveProperty('clientChannel');
    expect(side!.clientChannel).toBe('side');
    expect(plain!.grants.map((grant) => grant.permits)).toEqual([2]);
    expect(side!.grants.map((grant) => grant.permits)).toEqual([2]);
    expect(plain!.leases).toHaveLength(1);
    expect(side!.leases).toHaveLength(1);
    expect(await holder.usage()).toMatchObject({ granted: 4, leased: 4 });

    // The side queue cannot claim, release, or settle the default queue's permits.
    const grantId = plain!.grants[0]!.grantId;
    const leaseId = plain!.leases![0]!.leaseId;
    const crossed = await sync(holder, {
      clientId: 'shard',
      clientChannel: 'side',
      grants: [{ grantId, claimed: 2, released: 2 }],
      leases: [{ leaseId, drawn: 0, released: 0, retired: true }],
    });
    expect(crossed.clientChannel).toBe('side');
    expect(crossed.grantResults).toEqual([
      {
        grantId,
        claimed: 0,
        status: 'not_found',
      },
    ]);
    expect(crossed.leases?.[0]?.expiresAt).toBe(Date.now());
    expect(await holder.usage()).toMatchObject({ granted: 4, leased: 4 });

    // An explicit default channel is the default client.
    await expect(
      sync(holder, {
        clientId: 'shard',
        clientChannel: 'default',
        grants: [{ grantId, claimed: 2, released: 2 }],
      })
    ).resolves.toMatchObject({
      clientChannel: 'default',
      grantResults: [{ grantId, claimed: 2, status: 'ok' }],
    });
    const sideGrant = side!.grants[0]!.grantId;
    await expect(
      sync(holder, {
        clientId: 'shard',
        grants: [{ grantId: sideGrant, claimed: 2, released: 2 }],
      })
    ).resolves.toMatchObject({
      grantResults: [{ grantId: sideGrant, status: 'not_found' }],
    });
    expect(await holder.usage()).toMatchObject({ granted: 2, leased: 4 });
  });

  it('echoes retired leases only to the client channel holding them', async () => {
    const holder = holderFor({
      limit: 0,
      leases: {
        provisioning: { mode: 'over', extra: 4 },
        permitsPerLease: 2,
        ttlMs: 5_000,
      },
    });
    const [plain, side] = await round(
      holder,
      leasing('shard', 1),
      leasing('shard', 1, 'side')
    );
    const plainLease = plain!.leases![0]!.leaseId;
    const sideLease = side!.leases![0]!.leaseId;

    vi.setSystemTime(Date.now() + 6_000);
    const [plainLater, sideLater] = await round(
      holder,
      leasing('shard', 0),
      leasing('shard', 0, 'side')
    );
    expect(plainLater!.leases!.map((lease) => lease.leaseId)).toEqual([
      plainLease,
    ]);
    expect(sideLater!.leases!.map((lease) => lease.leaseId)).toEqual([
      sideLease,
    ]);
  });
});

describe('semaphore queue channels', () => {
  type Queue = DurabilitySemaphoreQueue<string>;

  const grantReply = (
    message: PermitRequest,
    options: Pick<PermitGrant, 'nextRequestAt'> &
      Partial<Pick<PermitGrant, 'grants'>>
  ): PermitGrant => ({
    type: 'grant',
    v: message.v,
    grants: options.grants ?? [],
    blocked: [],
    nextRequestAt: options.nextRequestAt,
    grantResults: [],
    ...(message.clientChannel === undefined
      ? {}
      : { clientChannel: message.clientChannel }),
  });

  const holderServer = (
    holder: DurabilitySemaphoreServer
  ): SemaphoreHolder => ({
    request: (_key, message) => holder.handle(message) as Promise<PermitGrant>,
    sync: (_key, message) =>
      holder.handle(message) as Promise<PermitSyncResult>,
  });

  const queueOn = (
    scheduler: DurabilityScheduler,
    server: SemaphoreHolder,
    channel: string | undefined,
    admitted: AdmittedItem<string>[] = [],
    options: { attemptTimeoutMs?: number } = {}
  ): Queue =>
    new DurabilitySemaphoreQueue<string>({
      scheduler,
      ...(channel === undefined ? {} : { channel }),
      clientId: 'shard',
      server,
      admit: (items) => {
        admitted.push(...items);
      },
      retries: { delay: () => 1_000 },
      ...options,
    });

  it('keeps two queues with one clientId apart at a shared holder pool', async () => {
    const holder = holderFor({ limit: 3 });
    const scheduler = schedulerFor(new FakeStorage());
    const mainAdmitted: AdmittedItem<string>[] = [];
    const sideAdmitted: AdmittedItem<string>[] = [];
    const main = queueOn(
      scheduler,
      holderServer(holder),
      undefined,
      mainAdmitted
    );
    const side = queueOn(scheduler, holderServer(holder), 'side', sideAdmitted);

    const items = ['x', 'y'].map((id) => ({
      id,
      key: 'acct',
      body: id,
    }));
    await expect(main.enqueue(items)).resolves.toEqual({
      queued: ['x', 'y'],
      duplicates: [],
    });
    await expect(side.enqueue(items)).resolves.toEqual({
      queued: ['x', 'y'],
      duplicates: [],
    });
    await settle(3_000);

    // Three permits between four items with two shared IDs: never more.
    expect(mainAdmitted.length + sideAdmitted.length).toBe(3);
    expect(await holder.usage()).toMatchObject({ granted: 3 });
    const usages = [await main.usage(), await side.usage()];
    expect(usages.map((usage) => usage.admitted).sort()).toEqual([1, 2]);
    expect(usages.map((usage) => usage.queued).sort()).toEqual([0, 1]);

    // Releasing an ID in one queue leaves the same ID in the other admitted.
    const [full, partial] =
      mainAdmitted.length === 2 ? [main, side] : [side, main];
    const partialAdmitted =
      mainAdmitted.length === 2 ? sideAdmitted : mainAdmitted;
    const sharedId = partialAdmitted[0]!.id;
    expect(await partial.release(sharedId)).toBe(true);
    expect(await full.status(sharedId)).toMatchObject({ state: 'admitted' });
    expect(await partial.release(sharedId)).toBe(false);

    await settle(5_000);
    expect(mainAdmitted.length + sideAdmitted.length).toBe(4);
    expect(await holder.usage()).toMatchObject({ granted: 3 });
    expect(await full.usage()).toEqual({
      queued: 0,
      claiming: 0,
      admitted: 2,
    });
    expect(await partial.usage()).toEqual({
      queued: 0,
      claiming: 0,
      admitted: 1,
    });
  });

  it('admits nothing for a named queue through a version-1 holder', async () => {
    const holder = holderFor({
      limit: 2,
      grantTimeoutMs: 5_000,
      leases: {
        provisioning: { mode: 'over', extra: 2 },
        permitsPerLease: 2,
      },
    });
    let legacy = true;
    const sent: SemaphoreRequest[] = [];
    const server: SemaphoreHolder = {
      request: async (_key, message) => {
        sent.push(message);
        if (legacy && message.v !== 1) {
          throw new Error('Unsupported semaphore protocol version');
        }
        const reply = (await holder.handle(
          legacy ? (withoutChannel(message) as PermitRequest) : message
        )) as PermitGrant;
        return legacy ? (withoutChannel(reply) as PermitGrant) : reply;
      },
      sync: async (_key, message) => {
        sent.push(message);
        if (legacy && message.v !== 1) {
          throw new Error('Unsupported semaphore protocol version');
        }
        const reply = (await holder.handle(
          legacy ? (withoutChannel(message) as PermitSync) : message
        )) as PermitSyncResult;
        return legacy ? (withoutChannel(reply) as PermitSyncResult) : reply;
      },
    };
    const scheduler = schedulerFor(new FakeStorage());
    const mainAdmitted: AdmittedItem<string>[] = [];
    const sideAdmitted: AdmittedItem<string>[] = [];
    const main = queueOn(scheduler, server, undefined, mainAdmitted);
    const side = queueOn(scheduler, server, 'side', sideAdmitted, {
      attemptTimeoutMs: 10_000,
    });

    await main.enqueue([{ id: 'm', key: 'acct', body: 'm' }]);
    await side.enqueue([{ id: 's', key: 'acct', body: 's' }]);
    await settle(3_000);
    expect(mainAdmitted.map((item) => item.id)).toEqual(['m']);
    expect(sideAdmitted).toEqual([]);
    expect(await side.status('s')).toMatchObject({ state: 'queued' });
    const sideRequests = sent.filter(
      (message) => message.clientChannel === 'side'
    );
    expect(sideRequests.length).toBeGreaterThan(0);
    // Old holders reject version 2 before granting or leasing to the wrong client.
    expect(sideRequests.every((message) => message.v === 2)).toBe(true);

    // The rejected requests consume none of the old holder's grant capacity.
    await settle(5_000);
    const usage = await holder.usage();
    expect(usage.granted).toBeLessThanOrEqual(1);
    expect(sideAdmitted).toEqual([]);

    legacy = false;
    await settle(10_000);
    expect(sideAdmitted.map((item) => item.id)).toEqual(['s']);
    expect(await side.status('s')).toMatchObject({ state: 'admitted' });
  });

  it('keeps claims pending while a holder answers syncs without the channel', async () => {
    let acknowledgeSync = false;
    const syncs: PermitSync[] = [];
    const server: SemaphoreHolder = {
      request: async (_key, message) =>
        grantReply(message, {
          grants: [
            {
              grantId: 'g1',
              group: '',
              permits: 1,
            },
          ],
          nextRequestAt: Date.now() + 2_000,
        }),
      sync: async (_key, message) => {
        syncs.push(message);
        return {
          type: 'synced',
          v: message.v,
          grantResults: message.grants.map((grant) => ({
            grantId: grant.grantId,
            claimed: grant.claimed,
            status: 'ok' as const,
          })),
          ...(acknowledgeSync ? { clientChannel: message.clientChannel! } : {}),
        };
      },
    };
    const admitted: AdmittedItem<string>[] = [];
    const queue = queueOn(
      schedulerFor(new FakeStorage()),
      server,
      'side',
      admitted
    );
    await queue.enqueue([{ id: 'a', key: 'k', body: 'A' }]);
    await settle(3_000);
    expect(syncs.length).toBeGreaterThan(0);
    expect(syncs.every((message) => message.clientChannel === 'side')).toBe(
      true
    );
    expect(await queue.status('a')).toMatchObject({ state: 'claiming' });
    expect(admitted).toEqual([]);

    acknowledgeSync = true;
    await settle(6_000);
    expect(admitted.map((item) => item.id)).toEqual(['a']);
  });

  it('keeps the legacy outbox channel for the default queue and a tuple for named ones', async () => {
    const storage = new FakeStorage();
    const scheduler = schedulerFor(storage);
    const unavailable: SemaphoreHolder = {
      request: async (_key, message) =>
        grantReply(message, {
          grants: [
            {
              grantId: 'g1',
              group: '',
              permits: 1,
            },
          ],
          nextRequestAt: Date.now() + 60_000,
        }),
      sync: async () => {
        throw new Error('holder unavailable');
      },
    };
    const published: string[] = [];
    // Under dot concatenation this user outbox would share the named queue's channel.
    const userOutbox = new DurabilityOutbox<string>({
      scheduler,
      channel: 'durability.semaphore-queue.x',
      publish: (entries) => {
        published.push(...entries.map((entry) => entry.value));
      },
    });
    const main = queueOn(scheduler, unavailable, undefined);
    const named = queueOn(scheduler, unavailable, 'x');
    const lookalike = queueOn(
      scheduler,
      unavailable,
      'durability.semaphore-queue'
    );
    expect(
      () =>
        new DurabilityOutbox({
          scheduler,
          channel: JSON.stringify(['durability.semaphore-queue', 'x']),
          publish: () => undefined,
        })
    ).toThrow(/already attached/);

    for (const queue of [main, named, lookalike]) {
      // eslint-disable-next-line no-await-in-loop
      await queue.enqueue([{ id: 'a', key: 'k', body: 'A' }]);
    }
    await userOutbox.stage('k', 'user');
    await settle(2_000);

    expect(published).toEqual(['user']);
    expect(
      storage.sql
        .exec('SELECT DISTINCT channel FROM durability_outbox ORDER BY channel')
        .toArray()
        .map((row) => row['channel'])
    ).toEqual([
      '["durability.semaphore-queue","durability.semaphore-queue"]',
      '["durability.semaphore-queue","x"]',
      'durability.semaphore-queue',
    ]);
    for (const queue of [main, named, lookalike]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await queue.status('a')).toMatchObject({ state: 'claiming' });
    }
  });

  it('rejects a second queue on the same channel', () => {
    const scheduler = schedulerFor(new FakeStorage());
    const server = holderServer(holderFor());
    queueOn(scheduler, server, 'side');
    expect(() => queueOn(scheduler, server, 'side')).toThrow(
      /already attached/
    );
    expect(() => queueOn(scheduler, server, '')).toThrow(/non-empty/);
  });

  it('retains the state of a queue channel no instance attached', async () => {
    const storage = new FakeStorage();
    const scheduler = schedulerFor(storage);
    const requested: string[] = [];
    const server: SemaphoreHolder = {
      request: async (key, message) => {
        requested.push(`${message.clientChannel ?? 'default'}:${key}`);
        return grantReply(message, { nextRequestAt: Date.now() + 60_000 });
      },
      sync: async () => ({ type: 'synced', v: 1, grantResults: [] }),
    };
    const main = queueOn(scheduler, server, undefined);
    storage.sql.exec(
      `INSERT INTO durability_semaphore_queue_items
         (channel, id, key, grp, payload, status, created_at, next_attempt_at)
       VALUES ('gone', 'a', 'k', '', 'null', 'queued', 0, 0);
       INSERT INTO durability_semaphore_queue_keys
         (channel, key, next_request_at, queued)
       VALUES ('gone', 'k', 0, 1);
       INSERT INTO durability_semaphore_queue_leases
         (channel, lease_id, key, grp, permits, drawn, released, created_at,
          expires_at, renew_at, renew_ms, confirmed)
       VALUES ('gone', 'L', 'k', '', 2, 1, 0, 0, 1, 0, 1000, 0);`
    );

    await main.alarm();
    await settle(2_000);
    expect(requested).toEqual([]);
    expect(await main.usage()).toEqual({
      queued: 0,
      claiming: 0,
      admitted: 0,
    });
    expect(
      storage.sql
        .exec(
          "SELECT next_request_at, queued FROM durability_semaphore_queue_keys WHERE channel = 'gone'"
        )
        .toArray()
    ).toEqual([{ next_request_at: 0, queued: 1 }]);
    expect(
      storage.sql
        .exec(
          "SELECT renew_at FROM durability_semaphore_queue_leases WHERE channel = 'gone'"
        )
        .toArray()
    ).toEqual([{ renew_at: 0 }]);
    // The dormant rows do not keep the alarm awake.
    expect(storage.alarmAt).toBeNull();

    const gone = queueOn(scheduler, server, 'gone');
    expect(await gone.status('a')).toMatchObject({ state: 'queued' });
    await gone.alarm();
    await settle(10);
    expect(requested).toEqual(['gone:k']);
  });
});

describe('semaphore channel migrations', () => {
  it('moves legacy holder grants and leases to the default pool and client channel', async () => {
    const storage = new FakeStorage();
    migrateCapability(
      storage,
      'semaphore',
      durabilitySemaphoreMigrations,
      'durability_0009_create_semaphore_leases'
    );
    const now = Date.now();
    storage.sql.exec(
      `INSERT INTO durability_semaphore_grants
         (grant_id, client_id, grp, permits, claimed, released, created_at, expires_at)
       VALUES ('g1', 'shard', 'g', 3, 2, 1, ?, ?)`,
      now,
      now + 60_000
    );
    storage.sql.exec(
      `INSERT INTO durability_semaphore_leases
         (lease_id, client_id, grp, permits, released, created_at, expires_at, retired)
       VALUES ('L1', 'shard', 'g', 2, 0, ?, ?, 0)`,
      now,
      now + 60_000
    );

    const holder = holderFor(
      { limit: 10, leases: { provisioning: { mode: 'over', extra: 4 } } },
      storage
    );
    const batch = new DurabilitySemaphoreServer({
      scheduler: schedulerFor(storage),
      channel: 'batch',
      limit: 10,
    });
    expect(await holder.usage()).toMatchObject({ granted: 2, leased: 2 });
    expect(await batch.usage()).toMatchObject({ granted: 0, leased: 0 });

    // An old client, sending no channel, still owns its grant and lease.
    await expect(
      sync(holder, {
        clientId: 'shard',
        grants: [{ grantId: 'g1', claimed: 3, released: 3 }],
        leases: [{ leaseId: 'L1', drawn: 1, released: 1, retired: true }],
      })
    ).resolves.toMatchObject({
      grantResults: [{ grantId: 'g1', claimed: 3, status: 'ok' }],
      leases: [{ leaseId: 'L1', permits: 1 }],
    });
    expect(await holder.usage()).toMatchObject({ granted: 0, leased: 0 });
  });

  it('reverts the holder schema only while every pool and client is default', async () => {
    const storage = new FakeStorage();
    migrateCapability(
      storage,
      'semaphore',
      durabilitySemaphoreMigrations,
      undefined
    );
    storage.sql.exec(
      `INSERT INTO durability_semaphore_grants
         (channel, grant_id, client_id, client_channel, grp, permits, claimed,
          released, created_at, expires_at)
       VALUES ('default', 'g1', 'shard', 'side', 'g', 1, 0, 0, 0, 1)`
    );
    const revert = () =>
      migrateCapability(
        storage,
        'semaphore',
        durabilitySemaphoreMigrations,
        'durability_0009_create_semaphore_leases'
      );
    expect(revert).toThrow(/CHECK constraint/);
    expect(
      storage.sql
        .exec('SELECT client_channel FROM durability_semaphore_grants')
        .toArray()
    ).toEqual([{ client_channel: 'side' }]);

    storage.sql.exec(
      `UPDATE durability_semaphore_grants SET client_channel = 'default', channel = 'batch'`
    );
    expect(revert).toThrow(/CHECK constraint/);

    storage.sql.exec(
      `UPDATE durability_semaphore_grants SET channel = 'default'`
    );
    expect(revert()).toMatchObject({
      rolledBack: ['durability_0020_semaphore_channels'],
    });
    expect(
      storage.sql
        .exec('SELECT grant_id, client_id FROM durability_semaphore_grants')
        .toArray()
    ).toEqual([{ grant_id: 'g1', client_id: 'shard' }]);
  });

  it('keeps queued, claiming, and admitted legacy items with their grants, leases, and pending reports', async () => {
    const storage = new FakeStorage();
    migrateCapability(
      storage,
      'semaphoreQueue',
      durabilitySemaphoreQueueMigrations,
      'durability_0011_renew_semaphore_queue_leases'
    );
    migrateCapability(storage, 'outbox', durabilityOutboxMigrations, undefined);
    const now = Date.now();
    storage.sql.exec(
      `INSERT INTO durability_semaphore_queue_items
         (id, key, grp, payload, status, grant_id, lease_id, created_at,
          admitted_at, notified, attempt, next_attempt_at)
       VALUES
         ('q', 'k', '', ?, 'queued', NULL, NULL, 1, NULL, 0, 0, 1),
         ('c', 'k', '', ?, 'claiming', 'g1', NULL, 2, NULL, 0, 0, 2),
         ('a', 'k', '', ?, 'admitted', 'g1', NULL, 3, 4, 1, 1, ?),
         ('l', 'k', '', ?, 'admitted', NULL, 'L1', 5, 6, 1, 1, ?)`,
      serialize('Q'),
      serialize('C'),
      serialize('A'),
      now + 600_000,
      serialize('L'),
      now + 600_000
    );
    storage.sql.exec(
      `INSERT INTO durability_semaphore_queue_grants
         (grant_id, key, grp, permits, claimed, confirmed, admitted, released, created_at)
       VALUES ('g1', 'k', '', 2, 2, 1, 1, 0, 2)`
    );
    storage.sql.exec(
      `INSERT INTO durability_semaphore_queue_keys (key, next_request_at, queued)
       VALUES ('k', ?, 1)`,
      now
    );
    storage.sql.exec(
      `INSERT INTO durability_semaphore_queue_leases
         (lease_id, key, grp, permits, drawn, released, created_at, expires_at,
          renew_at, renew_ms, confirmed)
       VALUES ('L1', 'k', '', 2, 1, 0, 5, ?, ?, 30000, 0)`,
      now + 600_000,
      now + 300_000
    );
    storage.sql.exec(
      `INSERT INTO durability_outbox
         (id, channel, entry_key, version, payload, status, attempt,
          next_attempt_at, created_at, generation_id)
       VALUES (?, 'durability.semaphore-queue', ?, 1, ?, 'pending', 0, ?, ?, '1')`,
      JSON.stringify([
        'durability.semaphore-queue',
        JSON.stringify(['k', 'grant:g1']),
      ]),
      JSON.stringify(['k', 'grant:g1']),
      serialize({ kind: 'grant', claimed: 2, released: 0 }),
      now,
      now
    );

    const requests: PermitRequest[] = [];
    const syncs: PermitSync[] = [];
    const admitted: AdmittedItem<string>[] = [];
    const queue = new DurabilitySemaphoreQueue<string>({
      scheduler: schedulerFor(storage),
      clientId: 'shard',
      server: {
        request: async (_key, message) => {
          requests.push(message);
          return {
            type: 'grant',
            v: 1,
            grants: [],
            blocked: [],
            nextRequestAt: Date.now() + 600_000,
            grantResults: [],
          };
        },
        sync: async (_key, message) => {
          syncs.push(message);
          return {
            type: 'synced',
            v: 1,
            grantResults: message.grants.map((grant) => ({
              grantId: grant.grantId,
              claimed: grant.claimed,
              status: 'ok' as const,
            })),
          };
        },
      },
      admit: (items) => {
        admitted.push(...items);
      },
    });
    expect(await queue.usage()).toEqual({
      queued: 1,
      claiming: 1,
      admitted: 2,
    });
    expect(await queue.status('q')).toMatchObject({ state: 'queued' });
    expect(await queue.status('c')).toMatchObject({ state: 'claiming' });
    expect(await queue.status('a')).toMatchObject({ state: 'admitted' });
    expect(await queue.status('l')).toMatchObject({ state: 'admitted' });

    await queue.alarm();
    await settle(2_000);
    // The report staged before the upgrade is delivered, in the default wire shape.
    expect(syncs[0]).toEqual({
      type: 'sync',
      v: 1,
      clientId: 'shard',
      grants: [{ grantId: 'g1', claimed: 2, released: 0 }],
      leases: [],
    });
    // The confirmed claim admits 'c'; 'q' draws the lease's last permit.
    expect(
      admitted.map((item) => [item.id, item.body, item.via]).sort()
    ).toEqual([
      ['c', 'C', 'grant'],
      ['q', 'Q', 'lease'],
    ]);
    expect(requests[0]).toMatchObject({
      clientId: 'shard',
      demand: [{ group: '', count: 1 }],
      leases: [{ leaseId: 'L1', drawn: 1, released: 0 }],
    });
    expect(requests[0]).not.toHaveProperty('clientChannel');

    expect(await queue.release('a')).toBe(true);
    expect(await queue.release('l')).toBe(true);
    expect(await queue.usage()).toEqual({
      queued: 0,
      claiming: 0,
      admitted: 2,
    });
  });

  it('reverts the queue schema only while every queue is default', () => {
    const storage = new FakeStorage();
    migrateCapability(
      storage,
      'semaphoreQueue',
      durabilitySemaphoreQueueMigrations,
      undefined
    );
    const revert = () =>
      migrateCapability(
        storage,
        'semaphoreQueue',
        durabilitySemaphoreQueueMigrations,
        'durability_0011_renew_semaphore_queue_leases'
      );
    for (const table of [
      `durability_semaphore_queue_items
         (channel, id, key, grp, payload, status, created_at, next_attempt_at)
       VALUES ('side', 'a', 'k', '', 'null', 'queued', 0, 0)`,
      `durability_semaphore_queue_grants
         (channel, grant_id, key, grp, permits, created_at)
       VALUES ('side', 'g', 'k', '', 1, 0)`,
      `durability_semaphore_queue_keys (channel, key, next_request_at, queued)
       VALUES ('side', 'k', 0, 1)`,
      `durability_semaphore_queue_leases
         (channel, lease_id, key, grp, permits, created_at, expires_at)
       VALUES ('side', 'L', 'k', '', 1, 0, 0)`,
    ]) {
      storage.sql.exec(`INSERT INTO ${table}`);
      expect(revert).toThrow(/CHECK constraint/);
      for (const name of ['items', 'grants', 'keys', 'leases']) {
        storage.sql.exec(
          `UPDATE durability_semaphore_queue_${name} SET channel = 'default'`
        );
      }
    }

    expect(revert()).toMatchObject({
      rolledBack: ['durability_0021_semaphore_queue_channels'],
    });
    expect(
      storage.sql
        .exec('SELECT id, key, status FROM durability_semaphore_queue_items')
        .toArray()
    ).toEqual([
      {
        id: 'a',
        key: 'k',
        status: 'queued',
      },
    ]);
    expect(
      storage.sql
        .exec('SELECT lease_id FROM durability_semaphore_queue_leases')
        .toArray()
    ).toEqual([{ lease_id: 'L' }]);
  });
});
