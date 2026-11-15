import { DurableObject, env } from 'cloudflare:workers';
import { DurabilityAlarms } from 'durability';
import { neverGiveUp } from './alarm-policy';
import { noTargetName, type RedriveStatus } from './model';
import { orchestrators } from './namespaces';
import { send } from './send';
import type { Delivery } from './targets';

type Job = {
  queue: string;
  /** Set when the redrive is for one target rather than the whole queue. */
  target?: string;
  /** Targets still to replay; the first one is in progress. */
  remaining: string[];
  /** The last dead letter handled for the target in progress. */
  after?: string;
  startedAt: number;
  finishedAt?: number;
  redriven: number;
  left: number;
  lastError?: string;
};

export class UnknownTargetError extends Error {
  constructor(target: string) {
    super(`No target named "${target}"`);
    this.name = 'UnknownTargetError';
  }
}

/** Dead letters handled per alarm run, which keeps a run far below the subrequest limit. */
const pageSize = 100;
const retryMs = 5_000;

const statusOf = (job: Job): RedriveStatus => ({
  running: job.finishedAt === undefined,
  startedAt: job.startedAt,
  redriven: job.redriven,
  left: job.left,
  ...(job.target === undefined ? {} : { target: job.target }),
  ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
  ...(job.lastError === undefined ? {} : { lastError: job.lastError }),
});

/**
 * Replays a queue's dead letters. It is its own object so that reading and
 * re-sending a large set takes nothing from the partitions' delivery or from
 * the orchestrator: a redrive is a job this object works through, one page of
 * dead letters per alarm run.
 */
export class Redriver extends DurableObject<Cloudflare.Env> {
  private readonly alarms = new DurabilityAlarms({
    context: this.ctx,
    alarmMinDelayMs: 1_000,
    handlers: { replay: () => this.replay() },
    methods: { replay: neverGiveUp },
  });

  private get job(): Job | undefined {
    return this.ctx.storage.kv.get<Job>('job');
  }

  private get runningJob(): Job | undefined {
    const job = this.job;
    return job?.finishedAt === undefined ? job : undefined;
  }

  /**
   * Starts replaying every dead letter of the queue, or of one target. One
   * redrive runs at a time: a call made during a run reports that run.
   */
  async start(queue: string, target?: string): Promise<RedriveStatus> {
    if (this.runningJob) {
      return statusOf(this.runningJob);
    }
    const targets = await orchestrators().getByName(queue).targetNames();
    if (target !== undefined && !targets.includes(target)) {
      throw new UnknownTargetError(target);
    }
    // Another call may have started a run while this one asked for the targets.
    if (this.runningJob) {
      return statusOf(this.runningJob);
    }

    // Dead letters written while the queue had no target belong to every
    // target. With still none, replaying them would only write them again.
    const everything = targets.length > 0 ? [...targets, noTargetName] : [];
    const job: Job = {
      queue,
      remaining: target === undefined ? everything : [target],
      startedAt: Date.now(),
      redriven: 0,
      left: 0,
      ...(target === undefined ? {} : { target }),
    };
    // The alarm first: a stored job without one would report running for ever.
    await this.alarms.replay(Date.now());
    this.ctx.storage.kv.put('job', job);
    return statusOf(job);
  }

  /** The current or most recent redrive; undefined when there never was one. */
  status(): RedriveStatus | undefined {
    const job = this.job;
    return job && statusOf(job);
  }

  private async replay(): Promise<void> {
    const job = this.runningJob;
    if (!job) {
      return;
    }

    try {
      await this.replayPage(job);
    } catch (error) {
      // The alarm gives up after a few failures; a redrive must not, so the
      // failure is recorded and the page tried again.
      job.lastError = error instanceof Error ? error.message : String(error);
      this.ctx.storage.kv.put('job', job);
      await this.alarms.replay(Date.now() + retryMs);
      return;
    }

    if (job.remaining.length === 0) {
      job.finishedAt = Date.now();
      this.ctx.storage.kv.put('job', job);
      return;
    }
    await this.alarms.replay(Date.now());
  }

  /** Replays the next page of the target in progress and stores how far it got. */
  private async replayPage(job: Job): Promise<void> {
    const target = job.remaining[0];
    if (target === undefined) {
      return;
    }
    const page = await env.STORAGE.list({
      prefix: `dead-letters/${job.queue}/${target}/`,
      limit: pageSize,
      ...(job.after === undefined ? {} : { startAfter: job.after }),
    });

    for (const object of page.objects) {
      // eslint-disable-next-line no-await-in-loop
      const messages = await this.replayEntry(job, target, object.key);
      job.redriven += messages.redriven;
      job.left += messages.left;
      // Stored per entry: after a crash at most one entry is sent twice.
      job.after = object.key;
      this.ctx.storage.kv.put('job', job);
    }

    if (!page.truncated) {
      job.remaining = job.remaining.slice(1);
      delete job.after;
    }
    delete job.lastError;
    this.ctx.storage.kv.put('job', job);
  }

  /**
   * Sends one dead-lettered batch through the queue again: for its target
   * only, or for every target when it was written while the queue had none.
   * The entry is deleted once its messages were accepted, so a crash in
   * between can deliver a message twice but never loses one.
   */
  private async replayEntry(
    job: Job,
    target: string,
    key: string
  ): Promise<{ redriven: number; left: number }> {
    const stored = await env.STORAGE.get(key);
    if (!stored) {
      return { redriven: 0, left: 0 };
    }
    const entry = await stored.json<Delivery & { failedAt: number }>();
    // A message that fails again during the run is a new dead letter.
    // Replaying those too could go round forever. The partition stamped the
    // entry, so this compares the queue's own clocks, not R2's.
    if (entry.failedAt >= job.startedAt) {
      return { redriven: 0, left: 0 };
    }
    const outcome = await send(
      job.queue,
      entry.messages.map((message) => ({
        key: message.key,
        body: message.body,
        id: message.id,
        // The same on a repeat of this entry, so it is stored once.
        dedupeId: `redrive/${key}/${message.offset}`,
      })),
      target === noTargetName ? undefined : [target]
    );
    if (outcome.rejected.length > 0) {
      return { redriven: 0, left: entry.messages.length };
    }

    await env.STORAGE.delete(key);
    return { redriven: entry.messages.length, left: 0 };
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.alarms.alarm(info);
  }
}
