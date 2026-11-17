import { DurableObject } from 'cloudflare:workers';
import { DurabilityAlarms, DurabilityScheduler } from 'durability';
import {
  DurabilityTopology,
  type TopologyMemberInput,
} from 'durability/experimental';
import { DurabilitySocket, event } from 'durability/socket';
import * as v from 'valibot';
import { neverGiveUp } from './alarm-policy';
import {
  limiterName,
  partitionName,
  partitionsOf,
  topologyKey,
} from './layout';
import {
  pullTargetName,
  settingsInputSchema,
  targetInputSchema,
  targetNameSchema,
  type Layout,
  type LimiterSample,
  type Overview,
  type PartitionConfig,
  type PartitionIdentity,
  type PartitionSample,
  type PartitionTarget,
  type Point,
  type QueueEvent,
  type QueueSummary,
  maxPartitions,
  type QueueSettings,
  type Shares,
  type TargetSettings,
  type TargetTotals,
} from './model';
import { limiters, partition } from './namespaces';
import {
  planLimiters,
  fitsInHalf,
  planPartitions,
  planShares,
  type ShareState,
} from './scaling';
import type { PartitionMeta } from './send';
import { storesBatches } from './targets';

type LimiterState = ShareState & {
  active: string[];
  draining: string[];
  /** Limiter names are numbered and never reused. */
  created: number;
  revision: number;
  lastChangeAt: number;
};

/** Counters of partitions that left the queue, so totals never go backwards. */
type RemovedEpochTotals = {
  accepted: number;
  rejected: number;
  withoutTarget: number;
  targets: Record<
    string,
    Pick<TargetTotals, 'settled' | 'retries' | 'deadLettered'>
  >;
};

export class QueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueError';
  }
}

const tickMs = 2_000;
/**
 * How long one attempt at a resize keeps asking the old partitions to stop,
 * and how soon it asks one again that did not answer. The next tick resumes
 * an attempt that ran out of time; a partition that has stopped answers at once.
 */
const stopWithinMs = 20_000;
const stopRetryMs = 500;
/** Ticks stop this long after the last partition reported. */
const idleAfterMs = 30_000;
/** Short, so that a queue that is refusing sends grows within seconds. */
const rateWindowMs = 5_000;
const summaryStaleMs = 15_000;
/**
 * A resize does not wait for the one before it: accepting has to be able to
 * grow while a slow target still works through older partitions. Every
 * resize that has not drained keeps its partitions, so their number is bounded.
 */
const maxLiveEpochs = 8;
/** How far back the dashboard's charts go. */
const pointsKeptMs = 30 * 60_000;
const eventsKept = 100;
const dayMs = 24 * 60 * 60 * 1_000;
const pullBatchSize = 100;

const noLimiters: LimiterState = {
  active: [],
  draining: [],
  created: 0,
  revision: 0,
  lastChangeAt: 0,
  shares: {},
  loweredAtRevision: {},
  beforeLowering: {},
};

/**
 * As many partitions as the orchestrator calls at once. With ten thousand
 * calls in flight it ran out of memory.
 */
const partitionCallsAtOnce = 500;

/** Runs `work` for every item, `atOnce` at a time, and keeps the order. */
const forEach = async <Item, Result>(
  items: readonly Item[],
  atOnce: number,
  work: (item: Item) => Promise<Result>
): Promise<Result[]> => {
  const results: Result[] = [];
  let next = 0;
  const takeItems = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(atOnce, items.length) }, takeItems)
  );
  return results;
};

/** A queue without a limit of its own grows to what one orchestrator can hold. */
const mostPartitions = (settings: QueueSettings): number =>
  settings.partitions.max ?? maxPartitions;

const memberOf = (
  identity: PartitionIdentity
): TopologyMemberInput<PartitionMeta> => ({
  id: partitionName(identity),
  state: 'active',
  meta: {
    epoch: identity.epoch,
    index: identity.index,
  },
});

const checkTarget = (
  queue: string,
  settings: QueueSettings,
  name: string,
  target: TargetSettings
): void => {
  if (name === pullTargetName) {
    throw new QueueError(
      `"${pullTargetName}" is the queue's own target; turn pull consumers on or off in the settings`
    );
  }
  if (target.maxConcurrency !== undefined && settings.maxConcurrency === null) {
    throw new QueueError(
      'A target ceiling needs the queue to have maxConcurrency set'
    );
  }
  if (
    target.destination.type === 'queue' &&
    target.destination.queue === queue
  ) {
    throw new QueueError('A queue cannot be its own target');
  }
};

/**
 * The control plane of one queue. It decides which partitions and limiters
 * exist, pushes configuration to them, and keeps the numbers the dashboard
 * shows. No message passes through it.
 */
export class Orchestrator extends DurableObject<Cloudflare.Env> {
  private readonly sql = this.ctx.storage.sql;
  private readonly kv = this.ctx.storage.kv;
  private readonly scheduler = new DurabilityScheduler({
    context: this.ctx,
    alarmMinDelayMs: 1_000,
  });

  /** Partitions: published to KV for the Worker, and configured by push. */
  private readonly topology = new DurabilityTopology<
    PartitionMeta,
    { config: PartitionConfig }
  >({
    scheduler: this.scheduler,
    publish: {
      // No expiry: the entry is rewritten only when the partitions change.
      write: (snapshot, encoded) =>
        this.env.TOPOLOGY.put(topologyKey(snapshot.group), encoded),
      delete: (queue) => this.env.TOPOLOGY.delete(topologyKey(queue)),
    },
    states: {
      config: {
        // Draining partitions still deliver, so they need target changes too.
        members: 'read',
        deliver: (member, update) => {
          const identity = { queue: update.group, ...member.meta };
          return partition(identity).configure(identity, update);
        },
      },
    },
  });

  /** Limiters: known only to this object and, by name, to the partitions. */
  private readonly limiterTopology = new DurabilityTopology<
    undefined,
    { shares: Shares }
  >({
    scheduler: this.scheduler,
    channel: 'limiters',
    states: {
      shares: {
        members: 'read',
        deliver: (member, update) =>
          limiters().getByName(member.id).applyShares(member.id, update),
      },
    },
  });

  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: { tick: () => this.tick() },
    methods: { tick: neverGiveUp },
  });

  readonly socket = new DurabilitySocket({
    context: this.ctx,
    inbound: {
      overview: () => this.overview(),
      /** The parts of the overview that change with traffic, for polling. */
      live: () => {
        const overview = this.overview();
        return {
          partitions: overview.partitions,
          limiters: overview.limiters,
        };
      },
      putTarget: {
        input: v.object({
          name: targetNameSchema,
          target: targetInputSchema,
        }),
        handle: (input: { name: string; target: TargetSettings }) =>
          this.putTarget(input.name, input.target),
      },
      removeTarget: {
        input: targetNameSchema,
        handle: (name: string) => this.removeTarget(name),
      },
      pauseTarget: {
        input: v.object({
          name: targetNameSchema,
          paused: v.boolean(),
        }),
        handle: (input: { name: string; paused: boolean }) =>
          this.pauseTarget(input.name, input.paused),
      },
      updateSettings: {
        input: settingsInputSchema,
        handle: (settings: QueueSettings) => this.updateSettings(settings),
      },
      resize: {
        input: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        handle: (count: number) => this.resize(count),
      },
    },
    outbound: {
      point: event<Point>(),
      /** Settings, targets, partitions, or limiters changed: read the overview again. */
      changed: event<QueueEvent>(),
    },
  });

  /** Changes run one at a time: each reads state, calls out, then writes. */
  private lastChange: Promise<unknown> = Promise.resolve();
  private tickScheduled = false;
  private lastReportAt = 0;
  private limiterSamples: LimiterSample[] = [];

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS samples (
         partition TEXT PRIMARY KEY,
         epoch INTEGER NOT NULL,
         sequence INTEGER NOT NULL,
         body TEXT NOT NULL
       )`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS points (
         resolution TEXT NOT NULL,
         at INTEGER NOT NULL,
         body TEXT NOT NULL,
         PRIMARY KEY (resolution, at)
       )`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         body TEXT NOT NULL
       )`
    );
  }

  private get queue(): string {
    const queue = this.kv.get<string>('queue');
    if (queue === undefined || this.kv.get<boolean>('deleting')) {
      throw new QueueError('Queue does not exist');
    }
    return queue;
  }

  private get settings(): QueueSettings {
    return this.kv.get<QueueSettings>('settings')!;
  }

  private get targets(): Record<string, PartitionTarget> {
    return this.kv.get<Record<string, PartitionTarget>>('targets') ?? {};
  }

  private get epochs(): Layout[] {
    return this.kv.get<Layout[]>('epochs') ?? [];
  }

  private get limiterState(): LimiterState {
    return this.kv.get<LimiterState>('limiters') ?? noLimiters;
  }

  private exclusive<T>(change: () => Promise<T>): Promise<T> {
    const result = this.lastChange.then(change, change);
    this.lastChange = result.catch(() => undefined);
    return result;
  }

  private partitionConfig(): PartitionConfig {
    const partitionsAlive = this.epochs.reduce(
      (all, layout) => all + layout.count,
      0
    );
    return {
      targets: this.targets,
      limiters: this.limiterState.active,
      maxBacklog: this.settings.maxBacklog,
      pullRetentionMs: this.settings.pullRetentionDays * dayMs,
      // A second each up to a hundred partitions, then longer, so that this
      // object hears about a hundred reports a second however many there are.
      sampleIntervalMs: Math.max(1_000, partitionsAlive * 10),
    };
  }

  /**
   * A queue with pull consumers has one target of its own, which writes every
   * batch to the pull bucket. It is stored like any other target, so order
   * across a resize, retries, and the dashboard treat it the same way.
   */
  private syncPullTarget(): void {
    const { [pullTargetName]: existing, ...others } = this.targets;
    if (!this.settings.pullConsumers) {
      this.kv.put('targets', others);
      return;
    }
    if (existing) {
      return;
    }
    const epochs = this.epochs;
    this.kv.put('targets', {
      ...others,
      [pullTargetName]: {
        destination: { type: 'pull' },
        maxBatchSize: pullBatchSize,
        // The pull bucket is the only copy consumers read, so do not give up early.
        maxRetries: 100,
        retryDelaySeconds: 0,
        attemptTimeoutMs: 10_000,
        paused: false,
        startAt: 'latest',
        deliverFromEpoch: epochs[epochs.length - 1]!.epoch,
        addedAt: Date.now(),
      } satisfies PartitionTarget,
    });
  }

  private async publishConfig(): Promise<void> {
    await this.topology.update(this.queue, () => ({
      states: { config: this.partitionConfig() },
    }));
  }

  private record(kind: QueueEvent['kind'], detail: string): void {
    const entry: QueueEvent = { at: Date.now(), kind, detail };
    this.sql.exec(
      'INSERT INTO events (body) VALUES (?)',
      JSON.stringify(entry)
    );
    this.sql.exec(
      `DELETE FROM events
       WHERE id <= (SELECT MAX(id) FROM events) - ?`,
      eventsKept
    );
    this.socket.changed(entry);
  }

  /**
   * `targets` are part of the queue from its first moment. Added afterwards,
   * a partition could hear of the queue before it heard of them, and treat
   * what it accepted in between as having no target.
   */
  create(
    queue: string,
    settings: QueueSettings,
    targets: Record<string, TargetSettings> = {}
  ): Promise<void> {
    return this.exclusive(async () => {
      if (this.kv.get<string>('queue') !== undefined) {
        throw new QueueError(`Queue "${queue}" already exists`);
      }
      if (settings.partitions.min > mostPartitions(settings)) {
        throw new QueueError('partitions.min must not exceed partitions.max');
      }
      for (const [name, target] of Object.entries(targets)) {
        checkTarget(queue, settings, name, target);
      }

      // A deleted queue's partitions keep their names, so a queue created
      // again under the same name must not reuse their epochs.
      const first: Layout = {
        epoch: (this.kv.get<number>('lastEpoch') ?? 0) + 1,
        count: settings.partitions.min,
      };
      this.kv.put('queue', queue);
      this.kv.put('settings', settings);
      this.kv.put(
        'targets',
        Object.fromEntries(
          Object.entries(targets).map(([name, target]) => [
            name,
            { ...target, deliverFromEpoch: first.epoch, addedAt: Date.now() },
          ])
        )
      );
      this.kv.put('epochs', [first]);
      this.kv.put('lastEpoch', first.epoch);
      this.kv.put('resizedAt', Date.now());
      this.syncPullTarget();

      await this.topology.update(queue, () => ({
        members: partitionsOf(queue, first).map(memberOf),
        states: { config: this.partitionConfig() },
      }));
      await this.balanceLimiters();
      this.record('created', `${first.count} partitions`);
    });
  }

  /** Stops every partition and forgets the queue. Stored messages are dropped by retention. */
  delete(): Promise<void> {
    return this.exclusive(async () => {
      // Already gone, for a caller that repeats a deletion it saw fail.
      if (this.kv.get<string>('queue') === undefined) {
        return;
      }
      // Stored first, with a tick scheduled: a deletion interrupted halfway
      // would otherwise leave a queue whose partitions refuse every send.
      this.kv.put('deleting', true);
      await this.scheduleTick();
      await this.finishDeletion();
    });
  }

  /** Every step can be repeated. */
  private async finishDeletion(): Promise<void> {
    const queue = this.kv.get<string>('queue')!;
    await forEach(
      this.epochs.flatMap((layout) => partitionsOf(queue, layout)),
      partitionCallsAtOnce,
      (identity) => partition(identity).stopForDeletedQueue()
    );
    await this.topology.delete(queue);
    const { active, draining, created } = this.limiterState;
    if (active.length + draining.length > 0) {
      await this.limiterTopology.delete(queue);
    }

    this.ctx.storage.transactionSync(() => {
      for (const key of [
        'queue',
        'settings',
        'targets',
        'epochs',
        'resize',
        'removedEpochTotals',
        'deleting',
      ]) {
        this.kv.delete(key);
      }
      // Limiter names stay numbered past the ones this queue used.
      this.kv.put('limiters', { ...noLimiters, created });
      this.sql.exec('DELETE FROM samples');
      this.sql.exec('DELETE FROM points');
      this.sql.exec('DELETE FROM events');
    });
  }

  putTarget(name: string, target: TargetSettings): Promise<void> {
    return this.exclusive(async () => {
      checkTarget(this.queue, this.settings, name, target);

      const epochs = this.epochs;
      const start =
        target.startAt === 'earliest' ? epochs[0]! : epochs[epochs.length - 1]!;
      const existing = this.targets[name];
      // The two kinds track what is left to deliver differently, so messages
      // waiting under one would never be delivered under the other.
      if (
        existing &&
        storesBatches(existing.destination) !==
          storesBatches(target.destination)
      ) {
        throw new QueueError(
          `Target "${name}" cannot change between an archive and a consumer; remove it and add it again`
        );
      }
      this.kv.put('targets', {
        ...this.targets,
        [name]: {
          ...target,
          deliverFromEpoch: existing?.deliverFromEpoch ?? start.epoch,
          addedAt: existing?.addedAt ?? Date.now(),
        },
      });

      await this.publishConfig();
      await this.pushShares();
      this.record('settings', `Target "${name}" saved`);
    });
  }

  removeTarget(name: string): Promise<void> {
    return this.exclusive(async () => {
      if (name === pullTargetName) {
        throw new QueueError(
          `"${pullTargetName}" is the queue's own target; turn pull consumers off in the settings`
        );
      }
      const { [name]: removed, ...rest } = this.targets;
      if (!removed) {
        throw new QueueError(`No target named "${name}"`);
      }
      this.kv.put('targets', rest);
      await this.publishConfig();
      await this.pushShares();
      await this.advanceEpochs();
      this.record('settings', `Target "${name}" removed`);
    });
  }

  pauseTarget(name: string, paused: boolean): Promise<void> {
    return this.exclusive(async () => {
      const target = this.targets[name];
      if (!target) {
        throw new QueueError(`No target named "${name}"`);
      }
      this.kv.put('targets', {
        ...this.targets,
        [name]: { ...target, paused },
      });
      await this.publishConfig();
      this.record(
        'settings',
        `Target "${name}" ${paused ? 'paused' : 'resumed'}`
      );
    });
  }

  updateSettings(settings: QueueSettings): Promise<void> {
    return this.exclusive(async () => {
      if (settings.partitions.min > mostPartitions(settings)) {
        throw new QueueError('partitions.min must not exceed partitions.max');
      }
      const capped = Object.entries(this.targets).find(
        ([, target]) => target.maxConcurrency !== undefined
      );
      if (settings.maxConcurrency === null && capped) {
        throw new QueueError(
          `Target "${capped[0]}" has a ceiling; remove it before removing the queue limit`
        );
      }

      this.kv.put('settings', settings);
      this.syncPullTarget();
      await this.balanceLimiters();
      await this.publishConfig();
      this.record('settings', 'Queue settings saved');

      const epochs = this.epochs;
      const { min } = settings.partitions;
      const active = epochs[epochs.length - 1]!.count;
      const count = Math.min(mostPartitions(settings), Math.max(min, active));
      if (count !== active && epochs.length < maxLiveEpochs) {
        await this.startResize(count);
      }
    });
  }

  /** Moves the queue to `count` partitions without waiting for the autoscaler. */
  resize(count: number): Promise<void> {
    return this.exclusive(async () => {
      const { min } = this.settings.partitions;
      const max = mostPartitions(this.settings);
      if (!Number.isSafeInteger(count) || count < min || count > max) {
        throw new QueueError(`Partitions must stay between ${min} and ${max}`);
      }
      await this.startResize(count);
    });
  }

  private async startResize(count: number): Promise<void> {
    const epochs = this.epochs;
    const active = epochs[epochs.length - 1]!;
    if (this.kv.get<Layout>('resize')) {
      throw new QueueError('A resize is already in progress');
    }
    if (epochs.length >= maxLiveEpochs) {
      throw new QueueError(
        `${epochs.length - 1} earlier resizes are still draining; wait for one to finish`
      );
    }
    if (count === active.count) {
      return;
    }
    // Written first so a crash mid-resize is picked up by the next tick.
    this.kv.put('resize', { epoch: active.epoch + 1, count });
    await this.finishResize();
  }

  /**
   * Stops the current partitions accepting, then publishes the next ones. The
   * order is what keeps keys in order: once every old partition refuses
   * sends, nothing can be accepted behind messages that already went to the
   * new ones. Every step can be repeated.
   */
  private async finishResize(): Promise<void> {
    const next = this.kv.get<Layout>('resize');
    if (!next) {
      return;
    }
    const queue = this.queue;
    const active = this.epochs.find(
      (layout) => layout.epoch === next.epoch - 1
    )!;

    // Each partition is asked on its own until it answers. A partition under
    // load turns calls away, and asking them all again in rounds would make
    // every round wait for the slowest of them.
    const until = Date.now() + stopWithinMs;
    const samples = await forEach(
      partitionsOf(queue, active),
      partitionCallsAtOnce,
      (identity) => this.stop(identity, next, until)
    );
    this.store(samples);

    await this.topology.update(queue, ({ members }) => ({
      members: [
        ...members
          .filter((member) => member.meta.epoch !== next.epoch)
          .map((member) => ({ ...member, state: 'draining' as const })),
        ...partitionsOf(queue, next).map(memberOf),
      ],
    }));

    this.ctx.storage.transactionSync(() => {
      this.kv.put('epochs', [
        ...this.epochs.filter((layout) => layout.epoch !== next.epoch),
        next,
      ]);
      this.kv.put('lastEpoch', next.epoch);
      this.kv.put('resizedAt', Date.now());
      this.kv.delete('resize');
    });
    this.record(
      'scaled',
      `${active.count} to ${next.count} partitions (epoch ${next.epoch})`
    );
    await this.advanceEpochs();
  }

  private async stop(
    identity: PartitionIdentity,
    next: Layout,
    until: number
  ): Promise<PartitionSample> {
    try {
      return await partition(identity).stopAccepting(identity, next);
    } catch (error) {
      if (Date.now() >= until) {
        throw error;
      }
    }
    // An overloaded object should normally be left alone. This one call is
    // what takes the load off it, among the hundreds of sends it is offered.
    await scheduler.wait(stopRetryMs);
    return this.stop(identity, next, until);
  }

  /** True once every partition of the epoch has handed the target all it holds. */
  private drained(target: string, layout: Layout): boolean {
    const samples = this.samplesOf(layout.epoch);
    return (
      samples.length === layout.count &&
      samples.every(
        (sample) =>
          !sample.accepting &&
          (sample.accepted === 0 ||
            sample.targets[target]?.settled === sample.accepted)
      )
    );
  }

  /**
   * Lets each target move on to the next epoch once the previous one has
   * nothing left for it, and drops epochs no target still reads.
   */
  private async advanceEpochs(): Promise<void> {
    const epochs = this.epochs;
    if (epochs.length < 2) {
      return;
    }
    const active = epochs[epochs.length - 1]!;
    const targets = this.targets;
    let moved = false;

    for (const [name, target] of Object.entries(targets)) {
      let epoch = Math.max(target.deliverFromEpoch, epochs[0]!.epoch);
      for (const layout of epochs) {
        if (
          layout.epoch === epoch &&
          layout.epoch !== active.epoch &&
          this.drained(name, layout)
        ) {
          epoch = layout.epoch + 1;
        }
      }
      if (epoch !== target.deliverFromEpoch) {
        target.deliverFromEpoch = epoch;
        moved = true;
      }
    }
    if (moved) {
      this.kv.put('targets', targets);
      await this.publishConfig();
    }

    const live = epochs.filter(
      (layout) =>
        layout.epoch === active.epoch ||
        Object.values(targets).some(
          (target) => target.deliverFromEpoch <= layout.epoch
        )
    );
    if (live.length === epochs.length) {
      return;
    }

    const dropped = epochs.filter((layout) => !live.includes(layout));
    await this.topology.update(this.queue, ({ members }) => ({
      members: members.filter((member) =>
        live.some((layout) => layout.epoch === member.meta.epoch)
      ),
    }));
    this.ctx.storage.transactionSync(() => {
      for (const layout of dropped) {
        this.addToRemovedEpochTotals(layout.epoch);
      }
      this.kv.put('epochs', live);
    });
    this.record(
      'epoch_drained',
      `Epoch ${dropped.map((layout) => layout.epoch).join(', ')} drained`
    );
  }

  /** Keeps a removed epoch's counters in the queue totals and forgets its samples. */
  private addToRemovedEpochTotals(epoch: number): void {
    const removed = this.kv.get<RemovedEpochTotals>('removedEpochTotals') ?? {
      accepted: 0,
      rejected: 0,
      withoutTarget: 0,
      targets: {},
    };
    for (const sample of this.samplesOf(epoch)) {
      removed.accepted += sample.accepted;
      removed.rejected += sample.rejected;
      removed.withoutTarget += sample.withoutTarget;
      for (const [name, progress] of Object.entries(sample.targets)) {
        const before = removed.targets[name] ?? {
          settled: 0,
          retries: 0,
          deadLettered: 0,
        };
        removed.targets[name] = {
          settled: before.settled + progress.settled,
          retries: before.retries + progress.retries,
          deadLettered: before.deadLettered + progress.deadLettered,
        };
      }
    }
    this.kv.put('removedEpochTotals', removed);
    this.sql.exec('DELETE FROM samples WHERE epoch = ?', epoch);
  }

  private store(samples: readonly PartitionSample[]): void {
    for (const sample of samples) {
      // Samples can arrive out of order; only a later one replaces the row.
      this.sql.exec(
        `INSERT INTO samples (partition, epoch, sequence, body)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(partition) DO UPDATE SET
           sequence = excluded.sequence,
           body = excluded.body
         WHERE excluded.sequence > samples.sequence`,
        partitionName(sample),
        sample.epoch,
        sample.sequence,
        JSON.stringify(sample)
      );
    }
  }

  private samplesOf(epoch?: number): PartitionSample[] {
    const rows =
      epoch === undefined
        ? this.sql.exec<{ body: string }>('SELECT body FROM samples')
        : this.sql.exec<{ body: string }>(
            'SELECT body FROM samples WHERE epoch = ?',
            epoch
          );
    return rows.toArray().map((row) => JSON.parse(row.body) as PartitionSample);
  }

  /** Called by partitions with their latest positions. */
  async report(samples: PartitionSample[]): Promise<void> {
    if (
      this.kv.get<string>('queue') === undefined ||
      this.kv.get<boolean>('deleting')
    ) {
      return;
    }
    const live = new Set(this.epochs.map((layout) => layout.epoch));
    this.store(samples.filter((sample) => live.has(sample.epoch)));
    this.lastReportAt = Date.now();

    await this.scheduleTick();
  }

  private async scheduleTick(): Promise<void> {
    if (this.tickScheduled) {
      return;
    }
    this.tickScheduled = true;
    try {
      await this.alarms.tick(Date.now() + tickMs);
    } catch (error) {
      // Remembering a tick that was never scheduled would stop every later one.
      this.tickScheduled = false;
      throw error;
    }
  }

  private async tick(): Promise<void> {
    this.tickScheduled = false;
    if (this.kv.get<string>('queue') === undefined) {
      return;
    }

    // A failed tick must not stop the ones after it, so it is only logged.
    await this.exclusive(async () => {
      if (this.kv.get<boolean>('deleting')) {
        await this.finishDeletion();
        return;
      }
      // Both repeat what was last stored; a change interrupted between
      // storing and pushing is completed here.
      await this.publishConfig();
      await this.pushShares();

      await this.finishResize();
      await this.advanceEpochs();
      this.limiterSamples = await this.balanceLimiters();
      const point = this.recordPoint(this.limiterSamples);
      this.socket.point(point);
      await this.autoscale(point);
    }).catch((error: unknown) => {
      console.error({ event: 'fifo_queue.tick.failed', error });
    });

    const busy =
      Date.now() - this.lastReportAt < idleAfterMs ||
      this.kv.get<Layout>('resize') !== undefined ||
      this.kv.get<boolean>('deleting') === true;
    if (busy) {
      await this.scheduleTick();
    }
  }

  private recordPoint(limiterSamples: readonly LimiterSample[]): Point {
    const removed = this.kv.get<RemovedEpochTotals>('removedEpochTotals');
    const epochs = this.epochs;
    const point: Point = {
      at: Date.now(),
      accepted: removed?.accepted ?? 0,
      rejected: removed?.rejected ?? 0,
      withoutTarget: removed?.withoutTarget ?? 0,
      partitions: epochs[epochs.length - 1]!.count,
      targets: Object.fromEntries(
        Object.keys(this.targets).map((name) => [
          name,
          {
            pending: 0,
            inFlight: 0,
            settled: 0,
            retries: 0,
            deadLettered: 0,
            ...removed?.targets[name],
          },
        ])
      ),
    };

    const samples = this.samplesOf();
    point.held = samples.reduce((all, sample) => all + (sample.held ?? 0), 0);
    point.backlogObjects = samples.reduce(
      (all, sample) => all + (sample.backlogObjects ?? 0),
      0
    );
    for (const sample of samples) {
      point.accepted += sample.accepted;
      point.rejected += sample.rejected;
      point.withoutTarget += sample.withoutTarget;
      for (const [name, progress] of Object.entries(sample.targets)) {
        const totals = point.targets[name];
        if (!totals) {
          continue;
        }
        totals.settled += progress.settled;
        totals.pending += sample.accepted - progress.settled;
        totals.inFlight += progress.inFlight;
        totals.retries += progress.retries;
        totals.deadLettered += progress.deadLettered;
      }
    }

    if (limiterSamples.length > 0) {
      point.permits = {
        limit: this.settings.maxConcurrency ?? 0,
        granted: limiterSamples.reduce((all, s) => all + s.granted, 0),
        blocked: limiterSamples.reduce((all, s) => all + s.blocked, 0),
      };
    }

    const body = JSON.stringify(point);
    this.sql.exec(
      `INSERT OR REPLACE INTO points (resolution, at, body)
       VALUES ('raw', ?, ?)`,
      point.at,
      body
    );
    this.sql.exec('DELETE FROM points WHERE at < ?', point.at - pointsKeptMs);
    return point;
  }

  private points(): Point[] {
    return this.sql
      .exec<{ body: string }>(
        "SELECT body FROM points WHERE resolution = 'raw' ORDER BY at"
      )
      .toArray()
      .map((row) => JSON.parse(row.body) as Point);
  }

  private async autoscale(point: Point): Promise<void> {
    const epochs = this.epochs;
    if (epochs.length >= maxLiveEpochs || this.kv.get<Layout>('resize')) {
      return;
    }
    const earlier = this.sql
      .exec<{ body: string }>(
        `SELECT body FROM points
         WHERE resolution = 'raw' AND at <= ?
         ORDER BY at DESC LIMIT 1`,
        point.at - rateWindowMs
      )
      .toArray()[0];
    // After an idle stretch the nearest older point says nothing about now.
    if (!earlier) {
      return;
    }
    const before = JSON.parse(earlier.body) as Point;
    if (point.at - before.at > 3 * rateWindowMs) {
      return;
    }

    const seconds = (point.at - before.at) / 1_000;
    const drainSeconds = Object.entries(point.targets)
      // A target that is paused or failing is behind for a reason more
      // partitions would not fix.
      .filter(
        ([name, totals]) =>
          totals.pending > 0 &&
          !this.targets[name]?.paused &&
          totals.retries === (before.targets[name]?.retries ?? 0)
      )
      .map(([name, totals]) => {
        const settledPerSecond =
          (totals.settled - (before.targets[name]?.settled ?? 0)) / seconds;
        return totals.pending / Math.max(settledPerSecond, 1);
      })
      .reduce<number | undefined>(
        (slowest, value) =>
          slowest === undefined ? value : Math.max(slowest, value),
        undefined
      );

    const { partitions: range } = this.settings;
    const load = {
      current: epochs[epochs.length - 1]!.count,
      min: range.min,
      max: mostPartitions(this.settings),
      targetRate: range.targetRate,
      // What was refused is demand as well: a queue too small to accept
      // would otherwise look quiet and stay small.
      acceptRate:
        (point.accepted + point.rejected - before.accepted - before.rejected) /
        seconds,
      drainSeconds,
      waitingForPermits: (point.permits?.blocked ?? 0) > 0,
      now: point.at,
      lastResizeAt: this.kv.get<number>('resizedAt') ?? 0,
    };
    const count = planPartitions({
      ...load,
      quietSince: this.quietSince(load),
    });
    if (count !== undefined) {
      await this.startResize(count);
    }
  }

  /**
   * Since when the queue has fitted in half its partitions without a break.
   * Stored, because shrinking waits far longer than this object stays in memory.
   */
  private quietSince(load: Parameters<typeof fitsInHalf>[0] & { now: number }) {
    const since = this.kv.get<number>('quietSince');
    if (!fitsInHalf(load)) {
      if (since !== undefined) {
        this.kv.delete('quietSince');
      }
      return undefined;
    }
    if (since === undefined) {
      this.kv.put('quietSince', load.now);
    }
    return since ?? load.now;
  }

  /**
   * Keeps the limiter set and each limiter's share in line with the queue
   * limit and with what the limiters report. Returns their samples.
   */
  private async balanceLimiters(): Promise<LimiterSample[]> {
    const limit = this.settings.maxConcurrency;
    let state = this.limiterState;

    if (limit === null) {
      if (state.active.length + state.draining.length > 0) {
        this.kv.put('limiters', { ...noLimiters, created: state.created });
        await this.limiterTopology.delete(this.queue);
        await this.publishConfig();
        this.record('limiters', 'Concurrency limit removed');
      }
      return [];
    }

    if (state.active.length === 0) {
      const first = limiterName(this.queue, state.created + 1);
      state = {
        ...state,
        active: [first],
        created: state.created + 1,
        shares: { [first]: limit },
        lastChangeAt: Date.now(),
      };
      await this.publishShares(state);
      await this.publishConfig();
      this.record('limiters', `Limit of ${limit} held by 1 limiter`);
      return [];
    }

    const samples = await Promise.all(
      [...state.active, ...state.draining].map((name) =>
        limiters().getByName(name).sample(name)
      )
    );
    const usage = new Map(samples.map((sample) => [sample.limiter, sample]));

    // A draining limiter leaves once it has applied a share of zero and every
    // permit it handed out has come back.
    const emptied = state.draining.filter((name) => {
      const sample = usage.get(name);
      return (
        sample !== undefined &&
        sample.granted === 0 &&
        sample.revision >= (state.loweredAtRevision[name] ?? 0) &&
        state.shares[name] === 0
      );
    });
    let membershipChanged = emptied.length > 0;
    if (membershipChanged) {
      state = {
        ...state,
        draining: state.draining.filter((name) => !emptied.includes(name)),
        shares: Object.fromEntries(
          Object.entries(state.shares).filter(
            ([name]) => !emptied.includes(name)
          )
        ),
      };
    }

    const wanted = planLimiters({
      current: state.active.length,
      requestsPerSecond: samples
        .filter((sample) => state.active.includes(sample.limiter))
        .reduce((all, sample) => all + sample.requestsPerSecond, 0),
      targetRate: this.settings.limiterTargetRate,
      now: Date.now(),
      lastChangeAt: state.lastChangeAt,
    });
    if (wanted > state.active.length) {
      const added = limiterName(this.queue, state.created + 1);
      state = {
        ...state,
        active: [...state.active, added],
        created: state.created + 1,
        shares: { ...state.shares, [added]: 0 },
        lastChangeAt: Date.now(),
      };
      membershipChanged = true;
    }
    if (wanted < state.active.length) {
      const removed = state.active[state.active.length - 1]!;
      state = {
        ...state,
        active: state.active.slice(0, -1),
        draining: [...state.draining, removed],
        lastChangeAt: Date.now(),
      };
      membershipChanged = true;
    }

    const plan = planShares({
      limit,
      mode: this.settings.limitMode,
      active: state.active,
      draining: state.draining,
      state,
      samples,
      revision: state.revision + 1,
    });
    if (!plan.changed && !membershipChanged) {
      return samples;
    }

    await this.publishShares({
      ...state,
      shares: plan.shares,
      loweredAtRevision: plan.loweredAtRevision,
      beforeLowering: plan.beforeLowering,
    });
    if (membershipChanged) {
      await this.publishConfig();
      this.record(
        'limiters',
        `${state.active.length} active, ${state.draining.length} draining`
      );
    }
    return samples;
  }

  private async publishShares(state: LimiterState): Promise<void> {
    this.kv.put('limiters', { ...state, revision: state.revision + 1 });
    await this.pushShares();
  }

  /**
   * Pushes the stored shares to every limiter. Pushing what a limiter already
   * has delivers nothing, so every tick repeats it: a crash after the shares
   * were stored cannot leave a limiter without them.
   */
  private async pushShares(): Promise<void> {
    const state = this.limiterState;
    const everyone = [...state.active, ...state.draining];
    if (everyone.length === 0) {
      return;
    }
    const limit = this.settings.maxConcurrency ?? 0;
    const capped = Object.entries(this.targets).filter(
      ([, target]) => target.maxConcurrency !== undefined
    );
    const shares: Shares = {
      revision: state.revision,
      limiters: Object.fromEntries(
        everyone.map((name) => {
          const permits = state.shares[name] ?? 0;
          // A target's ceiling is split in the same proportion as the limit.
          const ceiling = (maxConcurrency: number) =>
            permits === 0
              ? 0
              : Math.max(1, Math.floor((maxConcurrency * permits) / limit));
          return [
            name,
            {
              permits,
              targets: Object.fromEntries(
                capped.map(([target, { maxConcurrency }]) => [
                  target,
                  ceiling(maxConcurrency!),
                ])
              ),
            },
          ];
        })
      ),
    };

    await this.limiterTopology.update(this.queue, () => ({
      members: [
        ...state.active.map((id) => ({ id, state: 'active' as const })),
        ...state.draining.map((id) => ({ id, state: 'draining' as const })),
      ],
      states: { shares },
    }));
  }

  targetNames(): string[] {
    if (
      this.kv.get<string>('queue') === undefined ||
      this.kv.get<boolean>('deleting')
    ) {
      throw new QueueError('Queue does not exist');
    }
    return Object.keys(this.targets);
  }

  /**
   * Rates are taken over the last few points. A queue that has gone quiet
   * stops recording points, so an old newest point means no traffic.
   */
  summary(): QueueSummary {
    const recent = this.sql
      .exec<{ body: string }>(
        `SELECT body FROM points WHERE resolution = 'raw'
         ORDER BY at DESC LIMIT 6`
      )
      .toArray()
      .map((row) => JSON.parse(row.body) as Point);
    const last = recent[0];
    const epochs = this.epochs;
    const summary: QueueSummary = {
      queue: this.queue,
      partitions: epochs[epochs.length - 1]!.count,
      epochs: epochs.length,
      acceptedPerSecond: 0,
      rejectedPerSecond: 0,
      deliveredPerSecond: 0,
      backlog: 0,
      deadLettered: 0,
      held: last?.held ?? 0,
      backlogObjects: last?.backlogObjects ?? 0,
    };
    if (!last) {
      return summary;
    }

    const targets = Object.entries(last.targets);
    const slowest = targets.reduce<[string, TargetTotals] | undefined>(
      (behind, entry) =>
        behind === undefined || entry[1].pending > behind[1].pending
          ? entry
          : behind,
      undefined
    );
    summary.backlog = slowest?.[1].pending ?? 0;
    summary.deadLettered =
      last.withoutTarget +
      targets.reduce((all, [, totals]) => all + totals.deadLettered, 0);

    const before = recent[recent.length - 1]!;
    const seconds = (last.at - before.at) / 1_000;
    if (seconds <= 0 || Date.now() - last.at > summaryStaleMs) {
      return summary;
    }
    const perSecond = (now: number, earlier: number): number =>
      Math.max(0, now - earlier) / seconds;
    summary.acceptedPerSecond = perSecond(last.accepted, before.accepted);
    summary.rejectedPerSecond = perSecond(last.rejected, before.rejected);
    if (slowest) {
      summary.deliveredPerSecond = perSecond(
        slowest[1].settled,
        before.targets[slowest[0]]?.settled ?? slowest[1].settled
      );
    }
    return summary;
  }

  overview(): Overview {
    const state = this.limiterState;
    return {
      queue: this.queue,
      settings: this.settings,
      targets: this.targets,
      epochs: this.epochs,
      partitions: this.samplesOf(),
      limiters: {
        active: state.active,
        draining: state.draining,
        shares: state.shares,
        samples: this.limiterSamples,
      },
      points: this.points(),
      events: this.sql
        .exec<{ body: string }>('SELECT body FROM events ORDER BY id DESC')
        .toArray()
        .map((row) => JSON.parse(row.body) as QueueEvent),
    };
  }

  override fetch(request: Request) {
    return this.socket.fetch(request);
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    return this.socket.webSocketMessage(ws, message);
  }

  override webSocketClose(ws: WebSocket) {
    this.socket.webSocketClose(ws);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}
