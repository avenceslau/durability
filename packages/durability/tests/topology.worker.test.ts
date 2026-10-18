import { env, exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  DurabilityTopology,
  TopologyUnavailableError,
} from '../src/experimental';
import {
  topologyKey,
  type TopologyCoordinator,
  type TopologyShard,
} from './topology-worker';

declare global {
  namespace Cloudflare {
    interface Env {
      TOPOLOGY: KVNamespace;
    }
  }
}

const namespaceFor = <T extends Rpc.DurableObjectBranded>(name: string) =>
  (workerExports as Record<string, unknown>)[name] as DurableObjectNamespace<T>;

const coordinators = namespaceFor<TopologyCoordinator>('TopologyCoordinator');
const shards = namespaceFor<TopologyShard>('TopologyShard');

const waitFor = async (
  assertion: () => Promise<void>,
  remaining = 80
): Promise<void> => {
  try {
    await assertion();
  } catch (error) {
    if (remaining === 0) {
      throw error;
    }
    await scheduler.wait(10);
    await waitFor(assertion, remaining - 1);
  }
};

const clientFor = () =>
  DurabilityTopology.client({
    read: (group) => env.TOPOLOGY.get(topologyKey(group)),
    holder: (group) => coordinators.idFromName(group),
    ttlMs: 1,
    negativeTtlMs: 1,
  });

describe('topology in workerd', () => {
  it('publishes to KV, checks the holder, and syncs state to members', async () => {
    const group = crypto.randomUUID();
    const coordinator = coordinators.getByName(group);

    const created = await coordinator.create(group, 2, { max: 5 });
    expect(created.published).toBe(true);
    expect(created.snapshot.holder).toBe(
      coordinators.idFromName(group).toString()
    );

    const view = await clientFor().get(group);
    expect(view.members.map((member) => member.id)).toEqual([
      `${group}-0`,
      `${group}-1`,
    ]);

    await waitFor(async () => {
      expect(await shards.getByName(`${group}-0`).limits()).toEqual({ max: 5 });
      expect(await shards.getByName(`${group}-1`).limits()).toEqual({ max: 5 });
    });

    await coordinator.rotate(group, `${group}-0`);
    await waitFor(async () => {
      expect(await shards.getByName(`${group}-2`).limits()).toEqual({ max: 5 });
    });
    const rotated = await clientFor().get(group);
    expect(rotated.members.map((member) => [member.id, member.state])).toEqual([
      [`${group}-0`, 'draining'],
      [`${group}-1`, 'active'],
      [`${group}-2`, 'active'],
    ]);

    await coordinator.setLimits(group, { max: 9 });
    await waitFor(async () => {
      expect(await shards.getByName(`${group}-1`).limits()).toEqual({ max: 9 });
      expect(await shards.getByName(`${group}-2`).limits()).toEqual({ max: 9 });
    });
    expect(await shards.getByName(`${group}-0`).limits()).toEqual({ max: 5 });
  });

  it('rejects a snapshot another coordinator published under the same key', async () => {
    const group = crypto.randomUUID();
    const impostor = crypto.randomUUID();
    await coordinators.getByName(impostor).create(impostor, 1, { max: 1 });
    await env.TOPOLOGY.put(
      topologyKey(group),
      (await env.TOPOLOGY.get(topologyKey(impostor)))!.replace(
        `"group":"${impostor}"`,
        `"group":"${group}"`
      )
    );

    const error = await clientFor()
      .get(group)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TopologyUnavailableError);
    expect((error as TopologyUnavailableError).reason).toBe('invalid');
  });

  it('deletes the published key', async () => {
    const group = crypto.randomUUID();
    const coordinator = coordinators.getByName(group);
    await coordinator.create(group, 1, { max: 1 });

    expect(await coordinator.remove(group)).toEqual({ published: true });
    expect(await env.TOPOLOGY.get(topologyKey(group))).toBeNull();
  });
});
