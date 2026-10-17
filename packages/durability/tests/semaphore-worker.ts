import { DurableObject } from 'cloudflare:workers';
import { DurabilityScheduler } from '../src';
import { DurabilitySemaphore, type SemaphoreRequest } from '../src/semaphore';

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
