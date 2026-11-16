import { DurableObject, env } from 'cloudflare:workers';
import { timeout } from '@durability/transforms';
import {
  DurabilityAlarms,
  DurabilityLog,
  DurabilityScheduler,
  LogTruncatedError,
  type EnqueueResult,
  type LogLease,
  type LogRecord,
} from 'durability';
import {
  DurabilityOutbox,
  type TopologyStateUpdate,
} from 'durability/experimental';
import { DurabilitySemaphoreQueue } from 'durability/experimental/semaphore';
import { DurabilityRouting, type LoadSnapshot } from 'durability/routing';
import { exponential, jitter } from 'durability/utils';
import { neverGiveUp } from './alarm-policy';
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
import {
  batchKey,
  deliver,
  retryAll,
  store,
  storesBatches,
  type ConsumerDestination,
  type Delivery,
  type Settlement,
  type StorageDestination,
} from './targets';

export type AppendInput = {
  identity: PartitionIdentity;
  messages: Message[];
};

/** One call from the Worker: the sends it merged, and what it knows. */
export type AppendCall = {
  inputs: AppendInput[];
  /** When the Worker made the call, so the partition can tell how long it waited. */
  issuedAt: number;
  /** Messages the Worker refused for this partition since its last call. */
  refused: number;
};

/** On success, the offsets of each input's messages, in the inputs' order. */
export type AppendResult = EnqueueResult<
  number[][],
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
/**
 * What a partition keeps in its own storage. Past it, the oldest messages
 * move to R2: those every target has received are dropped on the way, the
 * rest are read back when delivery reaches them.
 */
const retentionBytes = 512 * 1024 * 1024;
/** Returned for a run of messages nobody needs, so nothing is written for it. */
const droppedSegment = 'dropped';
const retentionSweepMs = 60_000;
/** Must outlast the longest target timeout, or a batch is redelivered while it runs. */
const leaseMs = 60_000;
/** One alarm run delivers for this long, then hands over to the next run. */
const deliveryRunMs = 20_000;
/** A permit is returned after this long so other partitions get a turn. */
const permitHoldMs = 10_000;
const sampleIntervalMs = 1_000;
/**
 * A call that waited longer than this before the partition got to it is
 * refused without touching storage. Long enough that a brief stall refuses
 * nothing. An overloaded partition works through
 * what is queued for it quickly that way, and stays able to answer the
 * orchestrator, report, and deliver.
 */
const maxAppendLatenessMs = 5_000;
const deadLetterRetryMs = 30_000;
const shortWaitMs = 500;
const deadLetterBatchSize = 100;
/** How long after its timeout an unsettled batch is taken to be lost and delivered again. */
const inFlightGraceMs = 5_000;
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
  messages: lease.records.map((record) => ({
    id: record.body.id,
    key: record.body.key,
    offset: record.offset,
    body: record.body.body,
    sentAt: record.body.sentAt,
    attempts: lease.attempt,
  })),
});

/** A message a target was handed and has not settled, or one held behind such a message of its key. */
type PendingRow = {
  target: string;
  message_offset: number;
  key: string;
  /** Deliveries so far; 0 for a message that is only held. */
  attempts: number;
  /** When it may be delivered: a retry's delay, or the end of the delivery it is in. */
  retry_at: number;
};

/** In a query over `pending AS first`: no earlier message of the same key is waiting for the same target. */
const firstOfItsKey = `NOT EXISTS (
  SELECT 1 FROM pending AS earlier
  WHERE earlier.target = first.target
    AND earlier.key = first.key
    AND earlier.message_offset < first.message_offset
)`;

/**
 * One partition of one queue: an ordered log that accepts messages and hands
 * them to every target in offset order. Each target has its own position, so a
 * slow or failing target only holds back itself.
 */
export class Partition extends DurableObject<Cloudflare.Env> {
  private readonly sql = this.ctx.storage.sql;
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
    cold: {
      write: (segment) => this.moveToBacklogBucket(segment.records),
      read: (locator) => this.readFromBacklogBucket(locator),
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
      sample: () => this.sampleNow(),
    },
    methods: {
      deliver: neverGiveUp,
      enforceRetention: neverGiveUp,
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
      // Requested first: a failure here is retried with the items still
      // admitted. After a permit nobody waits for is given back below, its
      // item is gone and nothing would call this again, and the target, which
      // may be waiting for that very permit, would never run.
      await this.requestDelivery();
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
  private sampleScheduled = false;
  /** Refused since the last sample; counting them must not cost a write each. */
  private refusedSinceSample = 0;
  private lastLoad: { at: number; load: LoadSnapshot } | undefined;

  constructor(ctx: DurableObjectState, bindings: Cloudflare.Env) {
    super(ctx, bindings);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS pending (
         target TEXT NOT NULL,
         message_offset INTEGER NOT NULL,
         key TEXT NOT NULL,
         attempts INTEGER NOT NULL,
         retry_at INTEGER NOT NULL,
         PRIMARY KEY (target, message_offset)
       )`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS pending_by_key
       ON pending (target, key, message_offset)`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS pull_batches (
         object_key TEXT PRIMARY KEY,
         written_at INTEGER NOT NULL
       )`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS pull_batches_by_time
       ON pull_batches (written_at)`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS backlog_segments (
         first_offset INTEGER PRIMARY KEY,
         last_offset INTEGER NOT NULL,
         object_key TEXT NOT NULL,
         newest_at INTEGER NOT NULL
       )`
    );
  }

  /**
   * The lowest offset a target of the queue may still need: below it every
   * target has received the message, or given up on it.
   */
  private async neededFrom(): Promise<number> {
    const config = this.config;
    if (!config) {
      return 0;
    }
    const names = Object.keys(config.targets);
    const targets = names.length > 0 ? names : [noTargetName];
    const positions = await this.log.cursors();
    // A target's position is past messages it is still retrying or holding.
    const firstWaiting = (name: string): number =>
      this.sql
        .exec<{ first: number | null }>(
          'SELECT MIN(message_offset) AS first FROM pending WHERE target = ?',
          name
        )
        .one().first ?? Infinity;
    return Math.min(
      ...targets.map((name) =>
        Math.min(positions[name] ?? 0, firstWaiting(name))
      )
    );
  }

  /**
   * Called by the log for its oldest messages once the partition holds more
   * than it should, or they are older than a message may get. What some
   * target still needs is written to R2; the rest is dropped here.
   */
  private async moveToBacklogBucket(
    records: LogRecord<Message>[]
  ): Promise<string> {
    const identity = this.identity;
    if (!identity) {
      throw new Error('A partition that has stored messages knows its name');
    }
    const neededFrom = await this.neededFrom();
    const cutoff = Date.now() - retentionMs;
    const kept = records.filter(
      (record) => record.offset >= neededFrom && record.appendedAt >= cutoff
    );
    const newest = kept[kept.length - 1];
    if (!newest) {
      return droppedSegment;
    }

    // Named after the whole run, so the same run handed over again after a
    // crash finds the copy already written and leaves it.
    const first = records[0]!.offset;
    const last = records[records.length - 1]!.offset;
    const key = `backlog/${partitionName(identity)}/${first}-${last}`;
    await env.STORAGE.put(key, JSON.stringify(kept), {
      onlyIf: { etagDoesNotMatch: '*' },
    });
    this.sql.exec(
      `INSERT OR REPLACE INTO backlog_segments
         (first_offset, last_offset, object_key, newest_at)
       VALUES (?, ?, ?, ?)`,
      first,
      last,
      key,
      newest.appendedAt
    );
    return key;
  }

  /** The segment delivery read last: a batch is a small part of one. */
  private lastSegment:
    | { key: string; records: LogRecord<Message>[] }
    | undefined;

  private async readFromBacklogBucket(
    key: string
  ): Promise<LogRecord<Message>[] | undefined> {
    if (key === droppedSegment) {
      return undefined;
    }
    if (this.lastSegment?.key === key) {
      return this.lastSegment.records;
    }
    const stored = await env.STORAGE.get(key);
    if (!stored) {
      return undefined;
    }
    const records = await stored.json<LogRecord<Message>[]>();
    this.lastSegment = { key, records };
    return records;
  }

  /**
   * Deletes the segments every target is past and those too old to keep,
   * then tells the log where what it can still read begins. Resolves to when
   * the next segment becomes too old.
   */
  private async dropBacklogSegments(): Promise<number | undefined> {
    const neededFrom = await this.neededFrom();
    const done = this.sql
      .exec<{ first_offset: number; object_key: string }>(
        `SELECT first_offset, object_key FROM backlog_segments
         WHERE last_offset < ? OR newest_at < ?
         ORDER BY first_offset LIMIT 1000`,
        neededFrom,
        Date.now() - retentionMs
      )
      .toArray();
    if (done.length > 0) {
      await env.STORAGE.delete(done.map((segment) => segment.object_key));
      for (const segment of done) {
        this.sql.exec(
          'DELETE FROM backlog_segments WHERE first_offset = ?',
          segment.first_offset
        );
      }
    }

    const oldest = this.sql
      .exec<{ first_offset: number; newest_at: number }>(
        `SELECT first_offset, newest_at FROM backlog_segments
         ORDER BY first_offset LIMIT 1`
      )
      .toArray()[0];
    // What was dropped is always older than what was kept, so everything
    // before the oldest kept segment is gone.
    const { hotOffset } = await this.log.bounds();
    await this.log.forgetColdBefore(oldest?.first_offset ?? hotOffset);
    return oldest === undefined
      ? undefined
      : oldest.newest_at + retentionMs + 1;
  }

  /**
   * Where reading can resume after `offset` turned out to be gone: the next
   * segment in R2, or what the partition still holds itself.
   */
  private async readableFrom(offset: number): Promise<number> {
    const next = this.sql
      .exec<{ first_offset: number }>(
        `SELECT first_offset FROM backlog_segments
         WHERE first_offset > ? ORDER BY first_offset LIMIT 1`,
        offset
      )
      .toArray()[0];
    const { hotOffset } = await this.log.bounds();
    return Math.max(offset + 1, next?.first_offset ?? hotOffset);
  }

  /**
   * `unsettled()` as of the last change, for the check every append makes:
   * counting the table each time would cost most when a target is far behind,
   * which is when appends can least afford it. Dropped whenever it may be off.
   */
  private unsettledCounts: Map<string, number> | undefined;

  private countUnsettled(target: string, change: number): void {
    const counts = this.unsettledCounts;
    counts?.set(target, (counts.get(target) ?? 0) + change);
  }

  /** Messages each target has been handed or is holding, and has not settled. */
  private unsettled(): Map<string, number> {
    return new Map(
      this.sql
        .exec<{ target: string; count: number }>(
          'SELECT target, COUNT(*) AS count FROM pending GROUP BY target'
        )
        .toArray()
        .map((row) => [row.target, row.count])
    );
  }

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

  /**
   * Stores the messages of one or more sends, which the Worker merges while
   * they wait for this partition. They are stored in one transaction, all of
   * them or none, so the answer is the same for every send in the call.
   */
  async append(call: AppendCall): Promise<AppendResult> {
    const { inputs } = call;
    const first = inputs[0];
    if (!first) {
      throw new RangeError('Nothing to append');
    }
    this.remember(first.identity);
    const messages = inputs.flatMap((input) => input.messages);
    this.refusedSinceSample += call.refused;

    if (Date.now() - call.issuedAt > maxAppendLatenessMs) {
      this.refusedSinceSample += messages.length;
      // Owed, so the orchestrator hears of the refusals even if nothing else
      // makes this partition report.
      await this.stageSample(true);
      return {
        success: false,
        error: {
          name: 'Backpressure',
          message: 'The partition is behind; retry later',
        },
        load: await this.recentLoad(),
      };
    }

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
      this.refusedSinceSample += messages.length;
      // Owed, so the orchestrator hears of the refusals even if nothing else
      // makes this partition report.
      await this.stageSample(true);
      return {
        success: false,
        error: {
          name: 'Backpressure',
          message: 'A target is too far behind; retry later',
        },
        load: await this.log.load(),
      };
    }

    // Scheduled before the messages are stored: if scheduling fails nothing
    // was accepted, whereas a stored message without a delivery run would
    // wait until something else happened to wake the partition.
    await this.requestDelivery();
    await this.sweepBy(Date.now() + retentionSweepMs);
    const result = await this.log.append(
      messages.map((message) => ({
        body: message,
        deduplicationKey: message.dedupeId ?? message.id,
      }))
    );
    if (!result.success) {
      return result;
    }
    await this.stageSample();
    let taken = 0;
    return {
      ...result,
      value: inputs.map((input) =>
        result.value.slice(taken, (taken += input.messages.length))
      ),
    };
  }

  /**
   * The offset of the first message stored at or after `time`, or the end of
   * the log. Messages are stored in time order, so it is found by halving.
   */
  private async firstOffsetSince(time: number | undefined): Promise<number> {
    const { oldestOffset, nextOffset } = await this.log.bounds();
    if (time === undefined) {
      return nextOffset;
    }
    let from = oldestOffset;
    let to = nextOffset;
    while (from < to) {
      const middle = Math.floor((from + to) / 2);
      // eslint-disable-next-line no-await-in-loop
      const record = await this.recordAt(middle);
      // A message that is gone was stored before everything still here.
      if (record && record.appendedAt >= time) {
        to = middle;
      } else {
        from = middle + 1;
      }
    }
    return from;
  }

  /** The log's load, read at most once a second: a refusal should cost nothing. */
  private async recentLoad(): Promise<LoadSnapshot> {
    const now = Date.now();
    if (!this.lastLoad || now - this.lastLoad.at > 1_000) {
      this.lastLoad = { at: now, load: await this.log.load() };
    }
    return this.lastLoad.load;
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
    // The alarm first: a recorded time without an alarm would stop every
    // later sweep from being scheduled.
    await this.alarms.enforceRetention(time);
    this.ctx.storage.kv.put('sweepAt', time);
  }

  /**
   * Trims the log and the partition's batches in the pull bucket, then
   * schedules the next sweep for whichever of the two is due first.
   */
  private async enforceRetention(): Promise<void> {
    this.ctx.storage.kv.delete('sweepAt');
    await this.log.trim();
    const segmentsDue = await this.dropBacklogSegments();
    // A sweep that throws is retried a few times and then dropped, which
    // would leave the pull bucket unswept; try again with the next sweep.
    const pullLogDue = await this.expirePullLog().catch((error: unknown) => {
      console.error({ event: 'fifo_queue.pull_log.sweep_failed', error });
      return Date.now() + retentionSweepMs;
    });
    // The size limit is enforced by the sweep every append asks for. An idle
    // partition only has to wake when its oldest message becomes too old.
    const { hotOffset } = await this.log.bounds();
    const { records } = await this.log.read({ from: hotOffset, limit: 1 });
    const oldest = records[0];
    const logDue =
      oldest === undefined
        ? undefined
        : Math.max(oldest.appendedAt + retentionMs, Date.now()) + 1;

    const next = Math.min(
      logDue ?? Infinity,
      pullLogDue ?? Infinity,
      segmentsDue ?? Infinity
    );
    if (Number.isFinite(next)) {
      await this.sweepBy(next);
    }
  }

  /**
   * Deletes this partition's batches whose time in the pull bucket is over,
   * and resolves to when the next one ends. The partition keeps the time it
   * wrote each batch, so retention runs on its own clock and needs no listing.
   */
  private async expirePullLog(): Promise<number | undefined> {
    const keepMs = this.config?.pullRetentionMs ?? defaultPullRetentionMs;
    const expired = this.sql
      .exec<{ object_key: string }>(
        `SELECT object_key FROM pull_batches
         WHERE written_at <= ? ORDER BY written_at LIMIT ?`,
        Date.now() - keepMs,
        pullLogSweepSize
      )
      .toArray()
      .map((row) => row.object_key);
    if (expired.length > 0) {
      await env.PULL.delete(expired);
      for (const key of expired) {
        this.sql.exec('DELETE FROM pull_batches WHERE object_key = ?', key);
      }
    }

    const oldest = this.sql
      .exec<{ at: number | null }>(
        'SELECT MIN(written_at) AS at FROM pull_batches'
      )
      .one().at;
    // A batch that is already due means the page was full and more follows.
    return oldest === null ? undefined : Math.max(oldest + keepMs, Date.now());
  }

  /**
   * Retention ignores positions, so a partition that kept accepting while a
   * target fell behind would eventually drop messages the target never saw.
   */
  private async overBacklog(): Promise<boolean> {
    const config = this.config;
    const limit = config?.maxBacklog ?? null;
    if (!config || limit === null) {
      return false;
    }
    const { nextOffset } = await this.log.bounds();
    const positions = await this.log.cursors();
    const unsettled = (this.unsettledCounts ??= this.unsettled());
    return Object.entries(config.targets).some(
      ([name, target]) =>
        !target.paused &&
        nextOffset - (positions[name] ?? 0) + (unsettled.get(name) ?? 0) >=
          limit
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
      // what was accepted before it, and "before" is by when the target was
      // added, not by when this partition heard: a send that followed the
      // target may well have arrived here first.
      const start =
        previous && target.startAt === 'latest'
          ? // eslint-disable-next-line no-await-in-loop
            await this.firstOffsetSince(target.addedAt)
          : oldestOffset;
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

    // A removed target's waiting messages are given up with it. Kept, they
    // would count as unsettled for ever and hold back the next resize.
    const tracked = this.sql
      .exec<{ target: string }>('SELECT DISTINCT target FROM pending')
      .toArray();
    for (const { target } of tracked) {
      if (!(target in update.value.targets)) {
        this.sql.exec('DELETE FROM pending WHERE target = ?', target);
        this.unsettledCounts = undefined;
      }
    }

    // Requested before the version is recorded: a repeat of this update is
    // ignored once it is, so a failure here must leave it unrecorded. The run
    // starts after this call returns and sees the new config.
    await this.requestDelivery();
    this.ctx.storage.kv.put('config', update.value);
    this.ctx.storage.kv.put('config:version', update.version);
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
    try {
      await this.alarms.deliver(at);
    } catch (error) {
      // Remembering a run that was never scheduled would suppress the next request.
      this.deliveryScheduledFor = undefined;
      throw error;
    }
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

    if (this.requestedWhileDelivering) {
      resumeAt = Date.now();
    }
    if (resumeAt !== undefined) {
      await this.requestDelivery(resumeAt);
    }
    const segments = this.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM backlog_segments')
      .one().count;
    if (segments > 0) {
      // Delivery may have passed some of them; the sweep deletes those.
      await this.sweepBy(Date.now() + retentionSweepMs);
    }
    await this.stageSample(true);
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
      // A transaction that failed part of the way was rolled back.
      this.unsettledCounts = undefined;
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

    const waiting = await this.nothingDueUntil(name, target, now);
    if (waiting !== 'now') {
      await this.returnPermit(name);
      return waiting === 'never' ? undefined : waiting;
    }

    const limiter = limiterFor(partitionName(identity), config.limiters);
    if (limiter === undefined) {
      await this.returnPermit(name);
    } else if (!(await this.holdPermit(name, limiter))) {
      // `admit` requests a delivery run once the limiter answers.
      return undefined;
    }

    const { destination } = target;
    const wait = storesBatches(destination)
      ? await this.storeNextBatch(identity, name, target, destination)
      : await this.deliverNextBatch(identity, name, target, destination);
    return wait ?? 'more';
  }

  /**
   * When the target next has something to do: `now`, the time its earliest
   * retry becomes due, or `never` while nothing is waiting for it.
   */
  private async nothingDueUntil(
    name: string,
    target: PartitionTarget,
    now: number
  ): Promise<'now' | 'never' | number> {
    const { nextOffset } = await this.log.bounds();
    if (((await this.log.cursor(name)) ?? 0) < nextOffset) {
      return 'now';
    }
    if (storesBatches(target.destination)) {
      return 'never';
    }
    const earliest = this.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(first.retry_at) AS at FROM pending AS first
         WHERE first.target = ? AND ${firstOfItsKey}`,
        name
      )
      .one().at;
    if (earliest === null) {
      return 'never';
    }
    return earliest <= now ? 'now' : earliest;
  }

  /**
   * For a target that answers per message. Messages after the target's
   * position are either delivered or, when an earlier message of their key is
   * still waiting to be retried, held behind it; either way they get a row in
   * `pending` and the position moves on. A key's messages therefore stay in
   * order while a retry holds nothing else back.
   */
  private async deliverNextBatch(
    identity: PartitionIdentity,
    name: string,
    target: PartitionTarget,
    destination: ConsumerDestination
  ): Promise<void> {
    const claimed = await this.claim(name, target);
    const delivery = (messages: Delivery['messages']): Delivery => ({
      queue: identity.queue,
      target: name,
      partition: partitionName(identity),
      messages,
    });
    if (claimed.exhausted.length > 0) {
      await this.deadLetterMessages(
        name,
        delivery(claimed.exhausted),
        'Retries exhausted'
      );
    }
    if (claimed.messages.length === 0) {
      return;
    }

    const batch = delivery(claimed.messages);
    this.inFlight.set(name, batch.messages.length);
    // Sampled here rather than after the batch, so the sample shows it in flight.
    await this.stageSample();
    const finish = this.routing.begin('outbound');
    let failure: string | undefined;
    const settlement = await deliver(
      destination,
      batch,
      target.attemptTimeoutMs
    )
      .catch((error: unknown) => {
        // Nothing is known about a call that failed: every message is retried.
        failure = error instanceof Error ? error.message : String(error);
        return retryAll(batch);
      })
      .finally(() => {
        finish();
        this.inFlight.delete(name);
      });

    await this.settle(name, target, batch, settlement, failure);
    this.pace(name, target, batch.messages.length);
  }

  /** Spaces the target's next batch so it stays within `maxPerSecond`. */
  private pace(name: string, target: PartitionTarget, messages: number): void {
    if (target.maxPerSecond !== undefined) {
      const spacing = (messages * 1_000) / target.maxPerSecond;
      this.rateLimitedUntil.set(name, Date.now() + spacing);
    }
  }

  /**
   * Chooses the target's next batch and records it as in flight, so that a
   * crash before it is settled delivers it again.
   *
   * Retries that are due come first, each followed by the held messages of
   * its key. New messages fill what is left; one whose key still has a
   * message waiting outside this batch is held instead.
   */
  private async claim(
    name: string,
    target: PartitionTarget
  ): Promise<{
    messages: Delivery['messages'];
    exhausted: Delivery['messages'];
  }> {
    const now = Date.now();
    const limit = target.maxBatchSize;
    const waiting: PendingRow[] = [];
    const exhausted: PendingRow[] = [];
    const due = this.sql
      .exec<PendingRow>(
        `SELECT * FROM pending AS first
         WHERE first.target = ? AND first.retry_at <= ? AND ${firstOfItsKey}
         ORDER BY first.message_offset LIMIT ?`,
        name,
        now,
        limit
      )
      .toArray();
    for (const first of due) {
      if (first.attempts > target.maxRetries) {
        exhausted.push(first);
        continue;
      }
      if (waiting.length < limit) {
        waiting.push(
          ...this.sql
            .exec<PendingRow>(
              `SELECT * FROM pending WHERE target = ? AND key = ?
               ORDER BY message_offset LIMIT ?`,
              name,
              first.key,
              limit - waiting.length
            )
            .toArray()
        );
      }
    }

    const position = (await this.log.cursor(name)) ?? 0;
    const { oldestOffset } = await this.log.bounds();
    const records = new Map<number, LogRecord<Message>>();
    const joining: PendingRow[] = [];
    const held: PendingRow[] = [];
    const closedKeys = new Set<string>();
    // Retention may have removed messages this target never received. The
    // position moves past them even when none is left to read: a target that
    // stayed behind them would be asked for its next batch over and over.
    let scanned = Math.max(position, oldestOffset);
    if (scanned > position) {
      this.count(name, {
        lastError: 'Retention removed messages before they were delivered',
      });
    }
    const page = await this.log
      .read({ from: scanned, limit })
      .catch(async (error: unknown) => {
        if (!(error instanceof LogTruncatedError)) {
          throw error;
        }
        // A segment in R2 is gone. The position moves to what can be read.
        scanned = await this.readableFrom(scanned);
        this.count(name, {
          lastError: 'Retention removed messages before they were delivered',
        });
        return { records: [] };
      });
    for (const record of page.records) {
      const { key, only } = record.body;
      const row = {
        target: name,
        message_offset: record.offset,
        key,
        attempts: 0,
        retry_at: 0,
      };
      // A redriven message is for one target, and a crash after the rows were
      // written but before the position moved shows a message twice.
      const skipped =
        (only !== undefined && !only.includes(name)) ||
        this.sql
          .exec(
            'SELECT 1 FROM pending WHERE target = ? AND message_offset = ?',
            name,
            record.offset
          )
          .toArray().length > 0;
      if (skipped) {
        scanned = record.offset + 1;
        continue;
      }

      const waitingOutside =
        this.sql
          .exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending WHERE target = ? AND key = ?',
            name,
            key
          )
          .one().count > waiting.filter((other) => other.key === key).length;
      if (waitingOutside || closedKeys.has(key)) {
        held.push(row);
        closedKeys.add(key);
        scanned = record.offset + 1;
        continue;
      }
      if (waiting.length + joining.length >= limit) {
        break;
      }
      joining.push(row);
      records.set(record.offset, record);
      scanned = record.offset + 1;
    }

    // Until then the batch is in flight; after it, nobody settled it.
    const visibleAgainAt = now + target.attemptTimeoutMs + inFlightGraceMs;
    this.ctx.storage.transactionSync(() => {
      for (const row of [...held, ...joining]) {
        // `rowsWritten` would count the index rows as well.
        const inserted = this.sql.exec(
          `INSERT OR IGNORE INTO pending
             (target, message_offset, key, attempts, retry_at)
           VALUES (?, ?, ?, ?, ?)
           RETURNING message_offset`,
          row.target,
          row.message_offset,
          row.key,
          row.attempts,
          row.retry_at
        );
        this.countUnsettled(name, inserted.toArray().length);
      }
      for (const row of [...waiting, ...joining]) {
        this.sql.exec(
          `UPDATE pending SET attempts = attempts + 1, retry_at = ?
           WHERE target = ? AND message_offset = ?`,
          visibleAgainAt,
          name,
          row.message_offset
        );
      }
    });
    if (scanned > position) {
      await this.log.commit(name, scanned);
    }

    const messagesOf = async (
      rows: PendingRow[],
      delivered: number
    ): Promise<Delivery['messages']> => {
      const messages: Delivery['messages'] = [];
      for (const row of rows) {
        const record =
          records.get(row.message_offset) ??
          // eslint-disable-next-line no-await-in-loop
          (await this.recordAt(row.message_offset));
        if (!record) {
          // Retention removed the message while it waited.
          this.forget(name, row.message_offset);
          this.count(name, { lastError: 'A message expired before delivery' });
          continue;
        }
        messages.push({
          id: record.body.id,
          key: record.body.key,
          offset: record.offset,
          body: record.body.body,
          sentAt: record.body.sentAt,
          attempts: row.attempts + delivered,
        });
      }
      return messages;
    };
    return {
      messages: await messagesOf(
        [...waiting, ...joining].sort(
          (a, b) => a.message_offset - b.message_offset
        ),
        1
      ),
      exhausted: await messagesOf(exhausted, 0),
    };
  }

  /**
   * Applies what the consumer answered. Once a message of a key is retried,
   * the later messages of that key in the batch are held behind it whatever
   * was answered for them, and this delivery does not count against them.
   */
  private async settle(
    name: string,
    target: PartitionTarget,
    delivery: Delivery,
    settlement: Settlement,
    failure: string | undefined
  ): Promise<void> {
    const retried = new Map(
      settlement.retried.map((entry) => [entry.id, entry])
    );
    const failedKeys = new Set<string>();
    const exhausted: Delivery['messages'] = [];
    const now = Date.now();
    let retries = 0;

    this.ctx.storage.transactionSync(() => {
      for (const message of delivery.messages) {
        if (failedKeys.has(message.key)) {
          this.sql.exec(
            `UPDATE pending SET attempts = attempts - 1, retry_at = 0
             WHERE target = ? AND message_offset = ?`,
            name,
            message.offset
          );
          continue;
        }
        const retry = retried.get(message.id);
        if (!retry) {
          this.forget(name, message.offset);
          continue;
        }

        failedKeys.add(message.key);
        retries += 1;
        if (message.attempts > target.maxRetries) {
          exhausted.push(message);
          continue;
        }
        const delaySeconds = retry.delaySeconds ?? target.retryDelaySeconds;
        this.sql.exec(
          `UPDATE pending SET retry_at = ?
           WHERE target = ? AND message_offset = ?`,
          Math.ceil(now + delaySeconds * 1_000),
          name,
          message.offset
        );
      }
    });

    if (retries > 0) {
      this.count(name, {
        retries,
        lastError:
          failure ??
          `The consumer retried ${retries} of ${delivery.messages.length} messages`,
      });
    }
    if (exhausted.length > 0) {
      await this.deadLetterMessages(
        name,
        { ...delivery, messages: exhausted },
        failure ?? 'Retries exhausted'
      );
    }
  }

  /**
   * Writes each message a consumer gave up on to the dead letters, one entry
   * per message, then stops tracking it. That frees the messages of its key
   * held behind it; order no longer covers the dead-lettered one.
   */
  private async deadLetterMessages(
    name: string,
    delivery: Delivery,
    error: string
  ): Promise<void> {
    for (const message of delivery.messages) {
      const entry = { ...delivery, messages: [message] };
      try {
        // eslint-disable-next-line no-await-in-loop
        await env.STORAGE.put(
          `dead-letters/${delivery.queue}/${name}/${batchKey(entry)}`,
          JSON.stringify({ ...entry, error, failedAt: Date.now() }),
          // A repeated write must not replace the entry a redrive may be reading.
          { onlyIf: { etagDoesNotMatch: '*' } }
        );
      } catch (failure) {
        console.error({
          event: 'fifo_queue.dead_letter.failed',
          target: name,
          error: failure,
        });
        // The message stays out of retries; the write is tried again later.
        this.sql.exec(
          `UPDATE pending SET retry_at = ?
           WHERE target = ? AND message_offset = ?`,
          Date.now() + deadLetterRetryMs,
          name,
          message.offset
        );
        continue;
      }
      this.forget(name, message.offset);
      this.count(name, { deadLettered: 1, lastError: error });
    }
  }

  private forget(name: string, offset: number): void {
    const removed = this.sql.exec(
      `DELETE FROM pending WHERE target = ? AND message_offset = ?
       RETURNING message_offset`,
      name,
      offset
    );
    this.countUnsettled(name, -removed.toArray().length);
  }

  private async recordAt(
    offset: number
  ): Promise<LogRecord<Message> | undefined> {
    const { oldestOffset } = await this.log.bounds();
    if (offset < oldestOffset) {
      return undefined;
    }
    const { records } = await this.log
      .read({ from: offset, limit: 1 })
      .catch((error: unknown) => {
        if (!(error instanceof LogTruncatedError)) {
          throw error;
        }
        return { records: [] };
      });
    return records[0]?.offset === offset ? records[0] : undefined;
  }

  /**
   * For a target that keeps whole batches. A batch is written or it is not,
   * and the next one waits for it, so batches land in offset order: pull
   * consumers read them in that order.
   */
  private async storeNextBatch(
    identity: PartitionIdentity,
    name: string,
    target: PartitionTarget,
    destination: StorageDestination
  ): Promise<number | undefined> {
    let lease: LogLease<Message> | undefined;
    try {
      lease = await this.log.lease(name, target.maxBatchSize);
    } catch (error) {
      if (!(error instanceof LogTruncatedError)) {
        throw error;
      }
      // Retention removed messages this target never received. Trying again
      // at once would spin until the log has moved the target past them.
      this.count(name, { lastError: error.message });
      return Date.now() + 1_000;
    }
    if (!lease) {
      // A range leased before a restart is still held until it expires.
      return Date.now() + 1_000;
    }

    const delivery = deliveryOf(identity, name, {
      ...lease,
      records: lease.records.filter(
        (record) => record.body.only?.includes(name) ?? true
      ),
    });
    if (delivery.messages.length === 0) {
      await this.log.ack(name, lease.batchId);
      return undefined;
    }
    // A failed dead-letter write leaves the range past its last attempt.
    if (lease.attempt > target.maxRetries + 1) {
      await this.deadLetterBatch(name, lease, delivery, 'Retries exhausted');
      return undefined;
    }

    this.inFlight.set(name, delivery.messages.length);
    await this.stageSample();
    const finish = this.routing.begin('outbound');
    const stored = await store(destination, delivery)
      .then(
        (key) => ({ key }),
        (error: unknown) => ({
          failure: error instanceof Error ? error.message : String(error),
        })
      )
      .finally(() => {
        finish();
        this.inFlight.delete(name);
      });

    if ('key' in stored) {
      if (destination.type === 'pull') {
        // Recorded with its time, so the sweep knows when to delete it.
        const writtenAt = Date.now();
        this.sql.exec(
          `INSERT OR IGNORE INTO pull_batches (object_key, written_at)
           VALUES (?, ?)`,
          stored.key,
          writtenAt
        );
        await this.sweepBy(
          writtenAt + (this.config?.pullRetentionMs ?? defaultPullRetentionMs)
        );
      }
      await this.log.ack(name, lease.batchId);
      this.ctx.storage.kv.delete(`retry:${name}`);
      this.pace(name, target, delivery.messages.length);
      return undefined;
    }
    const { failure } = stored;

    if (lease.attempt > target.maxRetries) {
      await this.deadLetterBatch(name, lease, delivery, failure);
      return undefined;
    }
    this.count(name, { retries: 1, lastError: failure });
    await this.log.nack(name, lease.batchId);
    this.ctx.storage.kv.put(
      `retry:${name}`,
      Date.now() + jitter(exponential(lease.attempt))
    );
    return undefined;
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
    await this.deadLetterBatch(
      noTargetName,
      lease,
      deliveryOf(identity, noTargetName, lease),
      'The queue has no targets'
    );
    return 'more';
  }

  /** Writes a whole batch to the dead letters, then moves past it. */
  private async deadLetterBatch(
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
      // Recorded again: a permit held without its record could never be returned.
      this.ctx.storage.kv.put(`permit:${name}`, item);
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
    // Given back before it is forgotten: if this fails, the record is what
    // makes the next run try again. An item the limiter is confirming right
    // now is neither held nor queued; `admit` releases it when it arrives.
    if (!(await this.permits.release(item))) {
      await this.permits.cancel(item);
    }
    this.heldSince.delete(item);
    this.ctx.storage.kv.delete(`permit:${name}`);
  }

  private async sample(identity: PartitionIdentity): Promise<PartitionSample> {
    const { nextOffset } = await this.log.bounds();
    const positions = await this.log.cursors();
    if (this.refusedSinceSample > 0) {
      this.ctx.storage.kv.put('counters', {
        ...this.counters,
        rejected: this.counters.rejected + this.refusedSinceSample,
      });
      this.refusedSinceSample = 0;
    }
    const counters = this.counters;
    const unsettled = this.unsettled();
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
            // The position is past messages that are still waiting to be retried.
            settled: (positions[name] ?? 0) - (unsettled.get(name) ?? 0),
            inFlight: this.inFlight.get(name) ?? 0,
            retries: 0,
            deadLettered: 0,
            ...counters.targets[name],
          },
        ])
      ),
    };
  }

  /**
   * Stages a sample for the orchestrator, at most one per interval. `owed`
   * says the state has to arrive even if one was just sent, as at the end of
   * a delivery run, which the orchestrator waits for before it calls an
   * epoch drained: such a sample is sent when the interval is over.
   */
  private async stageSample(owed = false): Promise<void> {
    const identity = this.identity;
    if (!identity || this.ctx.storage.kv.get<boolean>('queueDeleted')) {
      return;
    }
    const now = Date.now();
    const interval = this.config?.sampleIntervalMs ?? sampleIntervalMs;
    const wait = this.sampledAt + interval - now;
    if (wait > 0) {
      if (owed && !this.sampleScheduled) {
        this.sampleScheduled = true;
        await this.alarms.sample(now + wait).catch((error: unknown) => {
          this.sampleScheduled = false;
          throw error;
        });
      }
      return;
    }
    this.sampledAt = now;
    await this.samples.stage('sample', await this.sample(identity));
  }

  private async sampleNow(): Promise<void> {
    this.sampleScheduled = false;
    await this.stageSample(true);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}
