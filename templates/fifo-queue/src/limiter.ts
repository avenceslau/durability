import { DurableObject } from 'cloudflare:workers';
import { DurabilityScheduler, RoutingLoad } from 'durability';
import type { TopologyStateUpdate } from 'durability/experimental';
import {
  DurabilitySemaphore,
  type SemaphoreRequest,
} from 'durability/experimental/semaphore';
import type { LimiterSample, Shares } from './model';

type Share = Shares['limiters'][string];

const noShare: Share = { permits: 0, targets: {} };
const blockedMaxAgeMs = 5_000;

/**
 * Holds one share of a queue's concurrency limit. Partitions ask it for a
 * permit before delivering a batch; the orchestrator decides how large the
 * share is and how many limiters a queue has.
 */
export class Limiter extends DurableObject<Cloudflare.Env> {
  private readonly scheduler = new DurabilityScheduler({
    context: this.ctx,
    alarmMinDelayMs: 1_000,
  });
  private readonly requests = new RoutingLoad();
  private blocked = 0;
  private lastRoundAt = 0;

  private readonly semaphore = new DurabilitySemaphore({
    scheduler: this.scheduler,
    limit: () => this.share().permits,
    groupLimit: (target) => this.share().targets[target],
    // Permits are held across many batches, so rounds can be short without
    // the partitions asking often.
    roundWaitMs: 100,
    roundPeriodMs: 250,
    onLifecycleEvent: (event) => {
      if (event.type === 'round') {
        this.blocked = 0;
        this.lastRoundAt = event.timestamp;
      }
      if (event.type === 'blocked') {
        this.blocked += event.count;
      }
    },
  });

  private share(): Share {
    const name = this.ctx.storage.kv.get<string>('name');
    const shares = this.ctx.storage.kv.get<Shares>('shares');
    return (name === undefined ? undefined : shares?.limiters[name]) ?? noShare;
  }

  async permits(message: SemaphoreRequest) {
    const finish = this.requests.begin('inbound');
    try {
      return await this.semaphore.handle(message);
    } finally {
      finish();
    }
  }

  /** Pushed by the orchestrator; a late delivery of older shares is ignored. */
  applyShares(name: string, update: TopologyStateUpdate<Shares>): void {
    this.ctx.storage.transactionSync(() => {
      const applied = this.ctx.storage.kv.get<number>('shares:version') ?? 0;
      if (update.version <= applied) {
        return;
      }
      this.ctx.storage.kv.put('name', name);
      this.ctx.storage.kv.put('shares', update.value);
      this.ctx.storage.kv.put('shares:version', update.version);
    });
  }

  async sample(name: string): Promise<LimiterSample> {
    const usage = await this.semaphore.usage();
    const load = this.requests.snapshot(0);
    const now = Date.now();
    return {
      limiter: name,
      at: now,
      revision: this.ctx.storage.kv.get<Shares>('shares')?.revision ?? 0,
      requestsPerSecond: load.inbound.completed / (load.windowMs / 1_000),
      limit: usage.limit,
      granted: usage.granted,
      // Rounds only run while partitions ask, so an old count says nothing.
      blocked: now - this.lastRoundAt < blockedMaxAgeMs ? this.blocked : 0,
    };
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export const limiterClient = DurabilitySemaphore.client({
  target: Limiter,
  exportName: 'Limiter',
  invoke: (stub, message) => stub.permits(message),
});
