import { DurableObject, env } from 'cloudflare:workers';
import { timeout } from '@durability/transforms';
import {
  DurabilityAlarms,
  DurabilityLog,
  DurabilityScheduler,
  LogTruncatedError,
  type EnqueueResult,
  type LogLease,
} from 'durability';
import {
  DurabilityOutbox,
  type TopologyStateUpdate,
} from 'durability/experimental';
import { DurabilitySemaphoreQueue } from 'durability/experimental/semaphore';
import { DurabilityRouting } from 'durability/routing';
import { exponential, jitter } from 'durability/utils';
import { limiterFor, partitionName } from './layout';
import { limiterClient } from './limiter';
import {
  noTargetName,
  type Layout,
  type Message,
  type PartitionConfig,
  type PartitionIdentity,
  type PartitionSample,
  type PartitionTarget,
} from './model';
import { orchestrators } from './namespaces';
import { batchKey, deliver, type Delivery } from './targets';

export type AppendInput = {
  identity: PartitionIdentity;
  messages: Message[];
};

export type AppendResult = EnqueueResult<
  number[],
  {
    name: string;
    message: string;
    /** Present when a resize replaced the partition: where its keys hash now. */
    next?: Layout;
  }
>;

type Counters = {
  rejected: number;
  targets: Record<
    string,
    {
      retries: number;
      deadLettered: number;
      lastError?: string;
    }
  >;
};

const retentionMs = 4 * 24 * 60 * 60 * 1_000;
const retentionBytes = 512 * 1024 * 1024;
const retentionSweepMs = 60_000;
/** Must outlast the longest target timeout, or a batch is redelivered while it runs. */
const leaseMs = 60_000;
/** One alarm run delivers for this long, then hands over to the next run. */
const deliveryRunMs = 20_000;
/** A permit is returned after this long so other partitions get a turn. */
const permitHoldMs = 10_000;
const sampleIntervalMs = 1_000;
const deadLetterRetryMs = 30_000;
const shortWaitMs = 500;
const deadLetterBatchSize = 100;
const defaultPullRetentionMs = 7 * 24 * 60 * 60 * 1_000;
const pullLogSweepSize = 500;

const deliveryOf = (
  identity: PartitionIdentity,
  target: string,
  lease: Pick<LogLease<Message>, 'attempt' | 'records'>
): Delivery => ({
  queue: identity.queue,
  target,
  partition: partitionName(identity),
  attempt: lease.attempt,
  messages: lease.records.map((record) => ({
    id: record.body.id,
    key: record.body.key,
    offset: record.offset,
    body: record.body.body,
    sentAt: record.body.sentAt,
  })),
});

/**
 * One partition of one queue: an ordered log that accepts messages and hands
 * them to every target in offset order. Each target has its own position, so a
 * slow or failing target only holds back itself.
 */
export class Partition extends DurableObject<Cloudflare.Env> {
  private readonly scheduler = new DurabilityScheduler({
    context: this.ctx,
    alarmMinDelayMs: 1_000,
  });
  private readonly routing = new DurabilityRouting();

  private readonly log = new DurabilityLog<Message>({
    scheduler: this.scheduler,
    routing: this.routing,
    retention: {
      maxAgeMs: retentionMs,
      maxBytes: retentionBytes,
    },
    // One range per target at a time is what keeps delivery in order.
    leases: {
      maxParallelism: 1,
      leaseMs,
    },
    maxBatchSize: 1_000,
  });

  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: {
      deliver: () => this.deliver(),
      enforceRetention: () => this.enforceRetention(),
    },
  });

  /** Latest positions for the orchestrator; only the newest sample is sent. */
  private readonly samples = new DurabilityOutbox<PartitionSample>({
    scheduler: this.scheduler,
    channel: 'samples',
    batchDelayMs: sampleIntervalMs,
    publish: async (entries) => {
      const sample = entries[entries.length - 1]!.value;
      await orchestrators().getByName(sample.queue).report([sample]);
    },
  });

  private readonly permits = new DurabilitySemaphoreQueue<null>({
    scheduler: this.scheduler,
    clientId: this.ctx.id.toString(),
    server: limiterClient.with(timeout, 5_000),
    admit: async (items) => {
      for (const item of items) {
        if (
          this.ctx.storage.kv.get<string>(`permit:${item.group}`) === item.id
        ) {
          this.heldSince.set(item.id, Date.now());
          continue;
        }
        // The target stopped waiting while the limiter was answering.
        // eslint-disable-next-line no-await-in-loop
        await this.permits.release(item.id);
      }
      await this.requestDelivery();
    },
    // After a restart nothing in memory holds a permit admitted before it.
    finished: (items) => items.filter((item) => !this.heldSince.has(item)),
  });

  /**
   * When each held permit was taken, by semaphore item. Which item a target
   * waits for or holds is stored under `permit:<target>`, so it survives a
   * restart; this only times how long a permit has been kept.
   */
  private readonly heldSince = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();
  private readonly rateLimitedUntil = new Map<string, number>();
  private delivering = false;
  private requestedWhileDelivering = false;
  private deliveryScheduledFor: number | undefined;
  private sampledAt = 0;

  private get identity(): PartitionIdentity | undefined {
    return this.ctx.storage.kv.get<PartitionIdentity>('identity');
  }

  private get config(): PartitionConfig | undefined {
    return this.ctx.storage.kv.get<PartitionConfig>('config');
  }

  private get counters(): Counters {
    return (
      this.ctx.storage.kv.get<Counters>('counters') ?? {
        rejected: 0,
        targets: {},
      }
    );
  }

  /** Callers say which partition this is; the object does not parse its own name. */
  private remember(identity: PartitionIdentity): void {
    if (!this.identity) {
      this.ctx.storage.kv.put('identity', identity);
    }
  }

  async append(input: AppendInput): Promise<AppendResult> {
    this.remember(input.identity);

    if (this.ctx.storage.kv.get<boolean>('queueDeleted')) {
      return {
        success: false,
        error: {
          name: 'QueueDeleted',
          message: 'The queue this partition belonged to was deleted',
        },
        load: await this.log.load(),
      };
    }

    const replacedBy = this.ctx.storage.kv.get<Layout>('replacedBy');
    if (replacedBy) {
      return {
        success: false,
        error: {
          name: 'PartitionReplaced',
          message: `Partition was replaced by epoch ${replacedBy.epoch}`,
          next: replacedBy,
        },
        load: await this.log.load(),
      };
    }

    if (await this.overBacklog()) {
      this.ctx.storage.kv.put('counters', {
        ...this.counters,
        rejected: this.counters.rejected + input.messages.length,
      });
      await this.stageSample();
      return {
        success: false,
        error: {
          name: 'Backpressure',
          message: 'A target is too far behind; retry later',
        },
        load: await this.log.load(),
      };
    }

    const result = await this.log.append(
      input.messages.map((message) => ({
        body: message,
        deduplicationKey: message.id,
      }))
    );
    if (!result.success) {
      return result;
    }

    await this.sweepBy(Date.now() + retentionSweepMs);
    await this.requestDelivery();
    await this.stageSample();
    return result;
  }

  /**
   * Makes sure a retention sweep runs by `time`. Scheduling replaces the
   * pending sweep, so one that is already due sooner is left alone.
   */
  private async sweepBy(time: number): Promise<void> {
    const pending = this.ctx.storage.kv.get<number>('sweepAt');
    if (pending !== undefined && pending <= time) {
      return;
    }
    this.ctx.storage.kv.put('sweepAt', time);
    await this.alarms.enforceRetention(time);
  }

  /**
   * Trims the log and the partition's batches in the pull bucket, then
   * schedules the next sweep for whichever of the two is due first.
   */
  private async enforceRetention(): Promise<void> {
    this.ctx.storage.kv.delete('sweepAt');
    await this.log.trim();
    // A sweep that throws is retried a few times and then dropped, which
    // would leave the pull bucket unswept; try again with the next sweep.
    const pullLogDue = await this.expirePullLog().catch((error: unknown) => {
      console.error({ event: 'fifo_queue.pull_log.sweep_failed', error });
      return Date.now() + retentionSweepMs;
    });
    const { hotOffset, nextOffset } = await this.log.bounds();
    const logDue =
      hotOffset < nextOffset ? Date.now() + retentionSweepMs : undefined;

    const next = Math.min(logDue ?? Infinity, pullLogDue ?? Infinity);
    if (Number.isFinite(next)) {
      await this.sweepBy(next);
    }
  }

  /**
   * Deletes this partition's batches whose time in the pull bucket is over.
   * Resolves to when the oldest remaining one ends, so the bucket is listed
   * only when something can have expired.
   */
  private async expirePullLog(): Promise<number | undefined> {
    const identity = this.identity;
    const expiresAt = this.ctx.storage.kv.get<number>('pullLogExpiresAt');
    const now = Date.now();
    if (!identity || expiresAt === undefined || expiresAt > now) {
      return expiresAt;
    }

    const keepMs = this.config?.pullRetentionMs ?? defaultPullRetentionMs;
    const page = await env.PULL.list({
      prefix: `${partitionName(identity)}/`,
      limit: pullLogSweepSize,
    });
    // Keys sort by offset, so the listing is oldest first.
    const kept = page.objects.findIndex(
      (object) => object.uploaded.getTime() + keepMs > now
    );
    const expired = kept === -1 ? page.objects : page.objects.slice(0, kept);
    if (expired.length > 0) {
      await env.PULL.delete(expired.map((object) => object.key));
    }

    const oldest = page.objects[expired.length];
    if (oldest) {
      const next = oldest.uploaded.getTime() + keepMs;
      this.ctx.storage.kv.put('pullLogExpiresAt', next);
      return next;
    }
    if (page.truncated) {
      // The whole page had expired and more follows.
      return now;
    }
    this.ctx.storage.kv.delete('pullLogExpiresAt');
    return undefined;
  }

  /**
   * Retention ignores positions, so a partition that kept accepting while a
   * target fell behind would eventually drop messages the target never saw.
   */
  private async overBacklog(): Promise<boolean> {
    const config = this.config;
    if (!config) {
      return false;
    }
    const { nextOffset } = await this.log.bounds();
    const positions = await this.log.cursors();
    return Object.entries(config.targets).some(
      ([name, target]) =>
        !target.paused &&
        nextOffset - (positions[name] ?? 0) >= config.maxBacklog
    );
  }

  /** Pushed by the orchestrator; a late delivery of an older config is ignored. */
  async configure(
    identity: PartitionIdentity,
    update: TopologyStateUpdate<PartitionConfig>
  ): Promise<void> {
    this.remember(identity);
    const applied = this.ctx.storage.kv.get<number>('config:version') ?? 0;
    if (update.version <= applied) {
      return;
    }

    const previous = this.config;
    const { oldestOffset, nextOffset } = await this.log.bounds();
    for (const [name, target] of Object.entries(update.value.targets)) {
      // eslint-disable-next-line no-await-in-loop
      if ((await this.log.cursor(name)) !== undefined) {
        continue;
      }
      // A partition's first config lists targets that existed before it did,
      // so everything it holds is theirs. Only a target added later may skip
      // what was accepted before it.
      const start =
        previous && target.startAt === 'latest' ? nextOffset : oldestOffset;
      // eslint-disable-next-line no-await-in-loop
      await this.log.commit(name, start);
    }

    // What a queue without targets accepts goes to the dead letters. Messages
    // accepted while it had targets were theirs, so that starts from here.
    const hadTargets = Object.keys(previous?.targets ?? {}).length > 0;
    const hasTargets = Object.keys(update.value.targets).length > 0;
    const unset = (await this.log.cursor(noTargetName)) === undefined;
    if (!hasTargets && (hadTargets || unset)) {
      await this.log.commit(
        noTargetName,
        hadTargets ? nextOffset : oldestOffset
      );
    }

    this.ctx.storage.kv.put('config', update.value);
    this.ctx.storage.kv.put('config:version', update.version);

    await this.requestDelivery();
    await this.stageSample(true);
  }

  /**
   * Stops accepting for good. Later sends are told where the queue's keys hash
   * now, so a producer with an old partition list cannot write behind a resize.
   */
  async stopAccepting(
    identity: PartitionIdentity,
    next: Layout
  ): Promise<PartitionSample> {
    this.remember(identity);
    if (!this.ctx.storage.kv.get<Layout>('replacedBy')) {
      this.ctx.storage.kv.put('replacedBy', next);
    }
    const sample = await this.sample(identity);
    await this.samples.stage('sample', sample);
    return sample;
  }

  /** The queue was deleted: stop delivering, reporting, and accepting. */
  stopForDeletedQueue(): void {
    this.ctx.storage.kv.put('queueDeleted', true);
  }

  /**
   * Asks for a delivery run at `at`. A request made while a run is in
   * progress must cause another run: the current one may already have looked
   * at the target the request is about.
   */
  private async requestDelivery(at = Date.now()): Promise<void> {
    if (this.delivering) {
      this.requestedWhileDelivering = true;
      return;
    }
    if (
      this.deliveryScheduledFor !== undefined &&
      this.deliveryScheduledFor <= at
    ) {
      return;
    }
    this.deliveryScheduledFor = at;
    await this.alarms.deliver(at);
  }

  /** Runs every target until none can make progress, then says when to resume. */
  private async deliver(): Promise<void> {
    this.delivering = true;
    this.requestedWhileDelivering = false;
    this.deliveryScheduledFor = undefined;

    let resumeAt: number | undefined;
    try {
      const stopAt = Date.now() + deliveryRunMs;
      // A target removed from the config may still hold or await a permit;
      // running it once more is what gives the permit back.
      const names = new Set([
        noTargetName,
        ...Object.keys(this.config?.targets ?? {}),
        ...[...this.ctx.storage.kv.list({ prefix: 'permit:' })].map(([key]) =>
          key.slice('permit:'.length)
        ),
      ]);
      const waits = await Promise.all(
        [...names].map((name) => this.deliverTo(name, stopAt))
      );
      for (const wait of waits) {
        if (wait !== undefined && (resumeAt === undefined || wait < resumeAt)) {
          resumeAt = wait;
        }
      }
    } finally {
      this.delivering = false;
    }

    await this.stageSample(true);
    if (this.requestedWhileDelivering) {
      resumeAt = Date.now();
    }
    if (resumeAt !== undefined) {
      await this.requestDelivery(resumeAt);
    }
  }

  /** Resolves to when this target can next make progress; undefined when idle. */
  private async deliverTo(
    name: string,
    stopAt: number
  ): Promise<number | undefined> {
    try {
      while (Date.now() < stopAt) {
        // eslint-disable-next-line no-await-in-loop
        const wait = await this.deliverNext(name);
        if (wait !== 'more') {
          return wait;
        }
      }
      return Date.now();
    } catch (error) {
      console.error({
        event: 'fifo_queue.delivery.failed',
        partition: this.identity,
        target: name,
        error,
      });
      return Date.now() + 1_000;
    }
  }

  private async deliverNext(
    name: string
  ): Promise<'more' | number | undefined> {
    if (name === noTargetName) {
      return this.deadLetterWithoutTarget();
    }
    const identity = this.identity;
    const config = this.config;
    const target = config?.targets[name];
    if (
      !identity ||
      !config ||
      !target ||
      target.paused ||
      target.deliverFromEpoch !== identity.epoch ||
      this.ctx.storage.kv.get<boolean>('queueDeleted')
    ) {
      await this.returnPermit(name);
      return undefined;
    }

    const now = Date.now();
    const notBefore = Math.ceil(
      Math.max(
        this.ctx.storage.kv.get<number>(`retry:${name}`) ?? 0,
        this.rateLimitedUntil.get(name) ?? 0
      )
    );
    if (notBefore - now > shortWaitMs) {
      await this.returnPermit(name);
      return notBefore;
    }
    if (notBefore > now) {
      // Too short to be worth an alarm or a new permit: wait here.
      await new Promise((resolve) => setTimeout(resolve, notBefore - now));
      return 'more';
    }

    const { nextOffset } = await this.log.bounds();
    if (((await this.log.cursor(name)) ?? 0) >= nextOffset) {
      await this.returnPermit(name);
      return undefined;
    }

    const limiter = limiterFor(partitionName(identity), config.limiters);
    if (limiter === undefined) {
      await this.returnPermit(name);
    } else if (!(await this.holdPermit(name, limiter))) {
      // `admit` requests a delivery run once the limiter answers.
      return undefined;
    }

    let lease: LogLease<Message> | undefined;
    try {
      lease = await this.log.lease(name, target.batchSize);
    } catch (error) {
      if (!(error instanceof LogTruncatedError)) {
        throw error;
      }
      // Retention removed messages this target never received.
      this.count(name, { lastError: error.message });
      return 'more';
    }
    if (!lease) {
      // A range leased before a restart is still held until it expires.
      return now + 1_000;
    }

    await this.deliverLease(identity, name, target, lease);
    return 'more';
  }

  private async deliverLease(
    identity: PartitionIdentity,
    name: string,
    target: PartitionTarget,
    lease: LogLease<Message>
  ): Promise<void> {
    const delivery = deliveryOf(identity, name, {
      ...lease,
      records: lease.records.filter(
        (record) => record.body.only?.includes(name) ?? true
      ),
    });
    if (delivery.messages.length === 0) {
      await this.log.ack(name, lease.batchId);
      return;
    }
    // A failed dead-letter write leaves the range past its last attempt.
    if (lease.attempt > target.maxAttempts) {
      await this.deadLetter(name, lease, delivery, 'Attempts exhausted');
      return;
    }

    this.inFlight.set(name, delivery.messages.length);
    // Sampled here rather than after the batch, so the sample shows it in flight.
    await this.stageSample();
    const finish = this.routing.begin('outbound');
    const outcome = await deliver(
      target.destination,
      delivery,
      target.attemptTimeoutMs
    )
      .catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        finish();
        this.inFlight.delete(name);
      });

    if (outcome.ok) {
      await this.log.ack(name, lease.batchId);
      this.ctx.storage.kv.delete(`retry:${name}`);
      if (
        target.destination.type === 'pull' &&
        this.ctx.storage.kv.get<number>('pullLogExpiresAt') === undefined
      ) {
        // The first batch in the pull bucket is the first that can expire.
        const expiresAt =
          Date.now() + (this.config?.pullRetentionMs ?? defaultPullRetentionMs);
        this.ctx.storage.kv.put('pullLogExpiresAt', expiresAt);
        await this.sweepBy(expiresAt);
      }
      if (target.maxPerSecond !== undefined) {
        const spacing =
          (delivery.messages.length * 1_000) / target.maxPerSecond;
        this.rateLimitedUntil.set(name, Date.now() + spacing);
      }
      return;
    }

    if (lease.attempt >= target.maxAttempts) {
      await this.deadLetter(name, lease, delivery, outcome.error);
      return;
    }
    this.count(name, { retries: 1, lastError: outcome.error });
    await this.log.nack(name, lease.batchId);
    const delay =
      'retryAfterMs' in outcome && outcome.retryAfterMs !== undefined
        ? outcome.retryAfterMs
        : jitter(exponential(lease.attempt));
    this.ctx.storage.kv.put(`retry:${name}`, Date.now() + delay);
  }

  /**
   * A queue without targets has nobody to deliver to, and messages left in
   * the log would only wait for retention to remove them. They go to the dead
   * letters instead, where a redrive finds them once the queue has a target.
   */
  private async deadLetterWithoutTarget(): Promise<
    'more' | number | undefined
  > {
    const identity = this.identity;
    const config = this.config;
    if (
      !identity ||
      !config ||
      Object.keys(config.targets).length > 0 ||
      this.ctx.storage.kv.get<boolean>('queueDeleted')
    ) {
      return undefined;
    }
    const now = Date.now();
    const retryAt = this.ctx.storage.kv.get<number>(`retry:${noTargetName}`);
    if (retryAt !== undefined && retryAt > now) {
      return retryAt;
    }

    const lease = await this.log.lease(noTargetName, deadLetterBatchSize);
    if (!lease) {
      const { nextOffset } = await this.log.bounds();
      const position = (await this.log.cursor(noTargetName)) ?? 0;
      // Either nothing is left, or a range leased before a restart is still held.
      return position >= nextOffset ? undefined : now + 1_000;
    }
    await this.deadLetter(
      noTargetName,
      lease,
      deliveryOf(identity, noTargetName, lease),
      'The queue has no targets'
    );
    return 'more';
  }

  private async deadLetter(
    name: string,
    lease: LogLease<Message>,
    delivery: Delivery,
    error: string
  ): Promise<void> {
    try {
      await env.STORAGE.put(
        `dead-letters/${delivery.queue}/${name}/${batchKey(delivery)}`,
        JSON.stringify({ ...delivery, error, failedAt: Date.now() }),
        // A repeated write must not replace the entry a redrive may be reading.
        { onlyIf: { etagDoesNotMatch: '*' } }
      );
    } catch (failure) {
      console.error({
        event: 'fifo_queue.dead_letter.failed',
        target: name,
        error: failure,
      });
      await this.log.nack(name, lease.batchId);
      this.ctx.storage.kv.put(`retry:${name}`, Date.now() + deadLetterRetryMs);
      return;
    }

    await this.log.ack(name, lease.batchId);
    this.ctx.storage.kv.delete(`retry:${name}`);
    this.count(name, {
      deadLettered: delivery.messages.length,
      lastError: error,
    });
  }

  private count(
    name: string,
    change: { retries?: number; deadLettered?: number; lastError: string }
  ): void {
    const counters = this.counters;
    const before = counters.targets[name] ?? { retries: 0, deadLettered: 0 };
    counters.targets[name] = {
      retries: before.retries + (change.retries ?? 0),
      deadLettered: before.deadLettered + (change.deadLettered ?? 0),
      lastError: change.lastError,
    };
    this.ctx.storage.kv.put('counters', counters);
  }

  /** True once this target holds a permit; otherwise one has been asked for. */
  private async holdPermit(name: string, limiter: string): Promise<boolean> {
    // The limiter is part of the item, so a partition that moved to another
    // limiter asks the new one instead of waiting at the old one.
    const item = `${limiter}\n${name}`;
    const previous = this.ctx.storage.kv.get<string>(`permit:${name}`);
    const heldSince = this.heldSince.get(item);
    const keptLongEnough =
      heldSince !== undefined && Date.now() - heldSince >= permitHoldMs;
    if ((previous !== undefined && previous !== item) || keptLongEnough) {
      await this.returnPermit(name);
    } else if (heldSince !== undefined) {
      return true;
    }

    const status = await this.permits.status(item);
    if (status?.state === 'admitted') {
      this.heldSince.set(item, Date.now());
      return true;
    }
    if (!status) {
      this.ctx.storage.kv.put(`permit:${name}`, item);
      await this.permits.enqueue([
        {
          id: item,
          key: limiter,
          group: name,
          body: null,
        },
      ]);
    }
    return false;
  }

  /** Gives back the target's permit, or withdraws its request for one. */
  private async returnPermit(name: string): Promise<void> {
    const item = this.ctx.storage.kv.get<string>(`permit:${name}`);
    if (item === undefined) {
      return;
    }
    this.heldSince.delete(item);
    this.ctx.storage.kv.delete(`permit:${name}`);
    // An item the limiter is confirming right now is neither; `admit`
    // releases it when it arrives.
    if (!(await this.permits.release(item))) {
      await this.permits.cancel(item);
    }
  }

  private async sample(identity: PartitionIdentity): Promise<PartitionSample> {
    const { nextOffset } = await this.log.bounds();
    const positions = await this.log.cursors();
    const counters = this.counters;
    const sequence =
      (this.ctx.storage.kv.get<number>('sampleSequence') ?? 0) + 1;
    this.ctx.storage.kv.put('sampleSequence', sequence);
    return {
      ...identity,
      at: Date.now(),
      sequence,
      accepted: nextOffset,
      rejected: counters.rejected,
      withoutTarget: counters.targets[noTargetName]?.deadLettered ?? 0,
      accepting: this.ctx.storage.kv.get<Layout>('replacedBy') === undefined,
      targets: Object.fromEntries(
        Object.keys(this.config?.targets ?? {}).map((name) => [
          name,
          {
            settled: positions[name] ?? 0,
            inFlight: this.inFlight.get(name) ?? 0,
            retries: 0,
            deadLettered: 0,
            ...counters.targets[name],
          },
        ])
      ),
    };
  }

  private async stageSample(force = false): Promise<void> {
    const identity = this.identity;
    const now = Date.now();
    if (
      !identity ||
      this.ctx.storage.kv.get<boolean>('queueDeleted') ||
      (!force && now - this.sampledAt < sampleIntervalMs)
    ) {
      return;
    }
    this.sampledAt = now;
    await this.samples.stage('sample', await this.sample(identity));
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}
