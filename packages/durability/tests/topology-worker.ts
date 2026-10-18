import { DurableObject, exports as workerExports } from 'cloudflare:workers';
import { DurabilityScheduler } from '../src';
import {
  DurabilityTopology,
  type TopologyStateUpdate,
} from '../src/experimental';

export type Limits = { max: number };

type Env = { TOPOLOGY: KVNamespace };

const namespaceFor = <T extends Rpc.DurableObjectBranded>(name: string) =>
  (workerExports as Record<string, unknown>)[name] as DurableObjectNamespace<T>;

export const topologyKey = (group: string) => `topology/${group}`;

export class TopologyCoordinator extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly topology = new DurabilityTopology({
    scheduler: this.scheduler,
    publish: {
      write: (snapshot, encoded) =>
        this.env.TOPOLOGY.put(topologyKey(snapshot.group), encoded),
      delete: (group) => this.env.TOPOLOGY.delete(topologyKey(group)),
    },
    states: {
      limits: {
        deliver: (member, update: TopologyStateUpdate<Limits>) =>
          namespaceFor<TopologyShard>('TopologyShard')
            .getByName(member.id)
            .applyLimits(update),
      },
    },
  });

  create(group: string, shards: number, limits: Limits) {
    return this.topology.update(group, () => ({
      members: Array.from({ length: shards }, (_, n) => ({
        id: `${group}-${n}`,
        state: 'active' as const,
      })),
      states: { limits },
    }));
  }

  rotate(group: string, shardId: string) {
    return this.topology.update(group, ({ members }) => ({
      members: [
        ...members.map((member) =>
          member.id === shardId
            ? { ...member, state: 'draining' as const }
            : member
        ),
        { id: `${group}-${members.length}`, state: 'active' },
      ],
    }));
  }

  setLimits(group: string, limits: Limits) {
    return this.topology.update(group, () => ({ states: { limits } }));
  }

  remove(group: string) {
    return this.topology.delete(group);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export class TopologyShard extends DurableObject<Env> {
  applyLimits(update: TopologyStateUpdate<Limits>) {
    this.ctx.storage.transactionSync(() => {
      const applied = this.ctx.storage.kv.get<number>('limits:version') ?? 0;
      if (update.version <= applied) {
        return;
      }
      this.ctx.storage.kv.put('limits', update.value);
      this.ctx.storage.kv.put('limits:version', update.version);
    });
  }

  limits() {
    return this.ctx.storage.kv.get<Limits>('limits');
  }
}
