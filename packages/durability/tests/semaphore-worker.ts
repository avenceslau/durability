import { DurableObject } from 'cloudflare:workers';
import { timeout } from '@durability/transforms';
import { DurabilityScheduler } from '../src';
import {
  DurabilitySemaphore,
  DurabilitySemaphoreQueue,
  type SemaphoreRequest,
} from '../src/semaphore';

/** Holds one account's limit; keyed by account id. */
export class LimitObject extends DurableObject {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly semaphore = new DurabilitySemaphore({
    scheduler: this.scheduler,
    limit: 3,
    groupLimit: (group) => (group === 'capped' ? 1 : undefined),
    roundWaitMs: 50,
    roundPeriodMs: 100,
  });

  permits(message: SemaphoreRequest) {
    return this.semaphore.handle(message);
  }

  usage() {
    return this.semaphore.usage();
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export const limits = DurabilitySemaphore.client({
  target: LimitObject,
  exportName: 'LimitObject',
  invoke: (stub, message) => stub.permits(message),
  locationHint: () => 'weur',
});

/** A client shard: queues jobs per account and records admissions. */
export class JobShard extends DurableObject {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly permits = new DurabilitySemaphoreQueue<string>({
    scheduler: this.scheduler,
    clientId: this.ctx.id.toString(),
    server: limits.with(timeout, 5_000),
    admit: async (items) => {
      const admitted = (await this.ctx.storage.get<string[]>('admitted')) ?? [];
      admitted.push(...items.map((item) => item.id));
      await this.ctx.storage.put('admitted', admitted);
    },
  });

  submit(account: string, jobs: { id: string; group?: string }[]) {
    return this.permits.enqueue(
      jobs.map((job) => ({
        id: job.id,
        key: account,
        body: job.id,
        ...(job.group === undefined ? {} : { group: job.group }),
      }))
    );
  }

  finish(id: string) {
    return this.permits.release(id);
  }

  admitted() {
    return this.ctx.storage.get<string[]>('admitted');
  }

  usage() {
    return this.permits.usage();
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}
