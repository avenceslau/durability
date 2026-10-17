import { DurableObject } from 'cloudflare:workers';
import { timeout } from '@durability/transforms';
import { Durability, DurabilityScheduler, type DurableCall } from 'durability';
import {
  DurabilitySemaphore,
  DurabilitySemaphoreQueue,
  type AdmittedItem,
  type SemaphoreRequest,
} from 'durability/semaphore';

type Env = {
  JOB_SHARDS: DurableObjectNamespace<JobShard>;
  JOB_API: Fetcher;
  /** Running jobs allowed per account. */
  ACCOUNT_CONCURRENCY: string;
};

type Job = {
  id: string;
  accountId: string;
  /** Jobs of one workflow may carry their own ceiling under the account's. */
  workflowId: string;
  payload: unknown;
};

/**
 * Holds one account's limit; the account ID is the semaphore key. Leases let
 * shards admit bursts without a round trip, and `strict` keeps grants plus
 * lease footprint under the limit at all times.
 */
export class AccountLimit extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly workflowLimits = new Map<string, number>();
  private readonly semaphore = new DurabilitySemaphore({
    scheduler: this.scheduler,
    limit: () => Number(this.env.ACCOUNT_CONCURRENCY),
    groupLimit: (workflowId) => this.workflowLimits.get(workflowId),
    leases: {
      provisioning: { mode: 'strict' },
      permitsPerLease: 16,
      ttlMs: 10 * 60_000,
    },
  });

  permits(message: SemaphoreRequest) {
    return this.semaphore.handle(message);
  }

  /** Administrative: cap one workflow. Takes effect at the next round. */
  limitWorkflow(workflowId: string, limit: number) {
    this.workflowLimits.set(workflowId, limit);
  }

  usage() {
    return this.semaphore.usage();
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export const limits = DurabilitySemaphore.client({
  target: AccountLimit,
  // Vite injects exportName from this application class and Wrangler's config.
  invoke: (stub, message) => stub.permits(message),
});

/**
 * Many shards, each queueing jobs for many accounts. Admitted jobs run as
 * durable operations; the permit returns when the operation reaches a
 * terminal state, success or failure.
 */
export class JobShard extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly jobs = new Durability({
    scheduler: this.scheduler,
    handlers: {
      run: async ({ id, payload, signal }: DurableCall<Job>) => {
        const response = await this.env.JOB_API.fetch('https://job-api/run', {
          method: 'POST',
          headers: { 'Idempotency-Key': id },
          body: JSON.stringify(payload.payload),
          signal,
        });
        if (!response.ok) {
          throw new Error(`Job API responded ${response.status}`);
        }
      },
    },
    retries: { maxAttempts: 3 },
    onLifecycleEvent: (event): Promise<void> | undefined => {
      const finished =
        event.type === 'terminal' ||
        (event.type === 'attempt_settled' && event.outcome === 'completed');
      if (finished && 'id' in event) {
        return this.permits.release(event.id).then(() => undefined);
      }
      return undefined;
    },
  });
  private readonly permits = new DurabilitySemaphoreQueue<Job>({
    scheduler: this.scheduler,
    clientId: this.ctx.id.toString(),
    server: limits.with(timeout, 5_000),
    // Operation IDs equal item IDs, so a repeated admit() is a no-op.
    admit: (items: AdmittedItem<Job>[]): Promise<void> =>
      Promise.all(
        items.map((item) => this.jobs.run({ id: item.id, payload: item.body }))
      ).then(() => undefined),
  });

  submit(jobs: Job[]) {
    return this.permits.enqueue(
      jobs.map((job) => ({
        id: job.id,
        key: job.accountId,
        group: job.workflowId,
        body: job,
      }))
    );
  }

  status(id: string) {
    return this.permits.status(id);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

/** Spread one account's jobs over a few shards; any stable function works. */
const shardFor = (accountId: string, width = 4): string => {
  let hash = 0;
  for (const char of accountId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `${accountId}-${hash % width}`;
};

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('POST a job array', { status: 405 });
    }
    // Demo input only: authenticate and validate untrusted payloads in an application.
    const jobs = await request.json<Job[]>();
    const byShard = new Map<string, Job[]>();
    for (const job of jobs) {
      const shard = shardFor(job.accountId);
      byShard.set(shard, [...(byShard.get(shard) ?? []), job]);
    }
    const results = await Promise.all(
      [...byShard].map(([shard, shardJobs]) =>
        env.JOB_SHARDS.getByName(shard).submit(shardJobs)
      )
    );
    return Response.json(results, { status: 202 });
  },
} satisfies ExportedHandler<Env>;
