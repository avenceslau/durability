import { exports as workerExports } from 'cloudflare:workers';
import { timeout } from '@durability/transforms';
import { describe, expect, it } from 'vitest';
import type { PermitGrant } from '../src/semaphore';
import { limits, type LimitObject } from './semaphore-worker';

const namespace = (workerExports as Record<string, unknown>)[
  'LimitObject'
] as DurableObjectNamespace<LimitObject>;

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
});
