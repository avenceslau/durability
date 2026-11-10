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

  /** A second pool on the same object, reached through its own RPC method. */
  private readonly batch = new DurabilitySemaphore({
    scheduler: this.scheduler,
    channel: 'batch',
    limit: 1,
    roundWaitMs: 50,
    roundPeriodMs: 100,
  });

  permits(message: SemaphoreRequest) {
    return this.semaphore.handle(message);
  }

  batchPermits(message: SemaphoreRequest) {
    return this.batch.handle(message);
  }

  usage() {
    return this.semaphore.usage();
  }

  batchUsage() {
    return this.batch.usage();
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

export const batchLimits = DurabilitySemaphore.client({
  target: LimitObject,
  exportName: 'LimitObject',
  invoke: (stub, message) => stub.batchPermits(message),
});

/** Queue channels of one shard; the side channel holds NUL and a dot. */
export const queueChannels = {
  main: 'default',
  side: 'side\u0000.queue',
  batch: 'batch',
} as const;
type QueueName = keyof typeof queueChannels;

/** A client shard: queues jobs per account and records admissions. */
export class JobShard extends DurableObject {
  protected readonly scheduler = new DurabilityScheduler(
    this.schedulerConfig()
  );
  // Every queue shares this shard's clientId; the side queue also shares the
  // default holder pool with the main one.
  private readonly queues: Record<QueueName, DurabilitySemaphoreQueue<string>> =
    {
      main: this.queue('main', limits),
      side: this.queue('side', limits),
      batch: this.queue('batch', batchLimits),
    };

  private queue(
    name: QueueName,
    server: typeof limits
  ): DurabilitySemaphoreQueue<string> {
    const storageKey = name === 'main' ? 'admitted' : `admitted:${name}`;
    return new DurabilitySemaphoreQueue<string>({
      scheduler: this.scheduler,
      channel: queueChannels[name],
      clientId: this.ctx.id.toString(),
      server: server.with(timeout, 5_000),
      admit: async (items) => {
        const admitted =
          (await this.ctx.storage.get<string[]>(storageKey)) ?? [];
        admitted.push(...items.map((item) => item.id));
        await this.ctx.storage.put(storageKey, admitted);
      },
    });
  }

  submit(
    account: string,
    jobs: { id: string; group?: string }[],
    name: QueueName = 'main'
  ) {
    return this.queues[name].enqueue(
      jobs.map((job) => ({
        id: job.id,
        key: account,
        body: job.id,
        ...(job.group === undefined ? {} : { group: job.group }),
      }))
    );
  }

  finish(id: string, name: QueueName = 'main') {
    return this.queues[name].release(id);
  }

  status(id: string, name: QueueName = 'main') {
    return this.queues[name].status(id);
  }

  admitted(name: QueueName = 'main') {
    return this.ctx.storage.get<string[]>(
      name === 'main' ? 'admitted' : `admitted:${name}`
    );
  }

  usage(name: QueueName = 'main') {
    return this.queues[name].usage();
  }

  protected schedulerConfig(): ConstructorParameters<
    typeof DurabilityScheduler
  >[0] {
    return { context: this.ctx };
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}
