import { exports as workerExports } from 'cloudflare:workers';
import { timeout } from '@durability/transforms';
import { describe, expect, it } from 'vitest';
import type { PermitGrant } from '../../src/semaphore';
import { limits, type JobShard, type LimitObject } from './worker';

const namespace = (workerExports as Record<string, unknown>)[
  'LimitObject'
] as DurableObjectNamespace<LimitObject>;
const shards = (workerExports as Record<string, unknown>)[
  'JobShard'
] as DurableObjectNamespace<JobShard>;

describe('semaphore in workerd', () => {
  it('routes requests to the holder by key through caller transforms', async () => {
    const key = crypto.randomUUID();
    const client = limits.with(timeout, 5_000);
    const [a, b] = await Promise.all([
      client.request(key, {
        type: 'request',
        v: 1,
        clientId: 'shard-a',
        demand: [
          { group: 'capped', count: 2, oldestAt: 1 },
          { group: 'open', count: 1, oldestAt: 2 },
        ],
        grants: [],
      }),
      client.request(key, {
        type: 'request',
        v: 1,
        clientId: 'shard-b',
        demand: [{ group: 'open', count: 5, oldestAt: 3 }],
        grants: [],
      }),
    ]);

    const permits = (grant: PermitGrant) =>
      grant.grants.map(({ group, permits: count }) => ({ group, count }));
    expect(permits(a)).toEqual([
      { group: 'capped', count: 1 },
      { group: 'open', count: 1 },
    ]);
    expect(permits(b)).toEqual([{ group: 'open', count: 1 }]);
    expect(b.blocked).toEqual([{ group: 'open', reason: 'limit' }]);
    expect(a.nextRequestAt).toBe(b.nextRequestAt);

    const grantId = b.grants[0]!.grantId;
    await expect(
      client.sync(key, {
        type: 'sync',
        v: 1,
        clientId: 'shard-b',
        grants: [{ grantId, claimed: 1, released: 1 }],
      })
    ).resolves.toMatchObject({
      grantResults: [{ grantId, claimed: 1, status: 'ok' }],
    });
    expect(await namespace.getByName(key).usage()).toMatchObject({
      limit: 3,
      granted: 2,
      available: 1,
    });
  });

  it('admits queued jobs across shards within the account limit and frees permits on release', async () => {
    const account = crypto.randomUUID();
    const a = shards.getByName(`${account}-a`);
    const b = shards.getByName(`${account}-b`);

    await a.submit(account, [{ id: 'a1' }, { id: 'a2', group: 'capped' }]);
    await b.submit(account, [{ id: 'b1' }, { id: 'b2', group: 'capped' }]);

    // limit 3, 'capped' group limit 1: three jobs run, one capped job waits.
    await expect
      .poll(
        async () => [
          ...((await a.admitted()) ?? []),
          ...((await b.admitted()) ?? []),
        ],
        { timeout: 5_000 }
      )
      .toHaveLength(3);
    expect(await namespace.getByName(account).usage()).toMatchObject({
      granted: 3,
      available: 0,
    });

    const admittedA: string[] = (await a.admitted()) ?? [];
    const cappedOnA = admittedA.includes('a2');
    await (cappedOnA ? a : b).finish(cappedOnA ? 'a2' : 'b2');
    await expect
      .poll(
        async () => [
          ...((await a.admitted()) ?? []),
          ...((await b.admitted()) ?? []),
        ],
        { timeout: 5_000 }
      )
      .toHaveLength(4);
    expect(await namespace.getByName(account).usage()).toMatchObject({
      granted: 3,
    });
  });

  it('keeps queues with one clientId apart at a shared holder pool', async () => {
    const account = crypto.randomUUID();
    const shard = shards.getByName(account);
    const ids = ['x', 'y'];
    await shard.submit(account, [{ id: 'x' }, { id: 'y' }]);
    await shard.submit(account, [{ id: 'x' }, { id: 'y' }], 'side');

    const both = async () => [
      ...((await shard.admitted()) ?? []),
      ...((await shard.admitted('side')) ?? []),
    ];
    // Limit 3 for four items: one waits, whichever queue it is in.
    await expect.poll(both, { timeout: 5_000 }).toHaveLength(3);
    expect(await namespace.getByName(account).usage()).toMatchObject({
      granted: 3,
    });

    const main = (await shard.admitted()) ?? [];
    const side = (await shard.admitted('side')) ?? [];
    const [partial, other] =
      main.length === 1
        ? (['main', 'side'] as const)
        : (['side', 'main'] as const);
    const id = (main.length === 1 ? main : side)[0]!;
    expect(ids).toContain(id);
    expect(await shard.finish(id, partial)).toBe(true);
    expect(await shard.status(id, other)).toMatchObject({ state: 'admitted' });

    await expect.poll(both, { timeout: 5_000 }).toHaveLength(4);
    expect(await namespace.getByName(account).usage()).toMatchObject({
      granted: 3,
    });
  });

  it('routes a queue to its own holder pool on the same object', async () => {
    const account = crypto.randomUUID();
    const shard = shards.getByName(account);
    await shard.submit(account, [{ id: 'b1' }, { id: 'b2' }], 'batch');
    await expect
      .poll(async () => (await shard.admitted('batch')) ?? [], {
        timeout: 5_000,
      })
      .toHaveLength(1);
    const holder = namespace.getByName(account);
    expect(await holder.batchUsage()).toMatchObject({ limit: 1, granted: 1 });
    expect(await holder.usage()).toMatchObject({ limit: 3, granted: 0 });
    expect(await shard.usage('batch')).toEqual({
      queued: 1,
      claiming: 0,
      admitted: 1,
    });
  });

  // Node 22's node:sqlite truncates returned TEXT at NUL; exercise these IDs
  // against Durable Object storage rather than the Node-backed FakeStorage.
  it.each(['\u0000id', 'id\u0000suffix', 'id\u0000'])(
    'keeps the exact item ID %j apart in two queues',
    async (id) => {
      const account = `${crypto.randomUUID()}\u0000key`;
      const shard = shards.getByName(crypto.randomUUID());
      await shard.submit(account, [{ id }]);
      await shard.submit(account, [{ id }], 'side');
      await expect
        .poll(
          async () => [
            (await shard.admitted()) ?? [],
            (await shard.admitted('side')) ?? [],
          ],
          { timeout: 5_000 }
        )
        .toEqual([[id], [id]]);
      expect(await namespace.getByName(account).usage()).toMatchObject({
        granted: 2,
      });

      expect(await shard.finish(id, 'side')).toBe(true);
      expect(await shard.status(id, 'side')).toBeUndefined();
      expect(await shard.status(id)).toMatchObject({ state: 'admitted' });
      await expect
        .poll(() => namespace.getByName(account).usage(), { timeout: 5_000 })
        .toMatchObject({ granted: 1 });
    }
  );
});
