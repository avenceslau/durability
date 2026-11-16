import { DurableObject } from 'cloudflare:workers';
import { DurabilityAlarms } from 'durability';
import type {
  LoadCounts,
  LoadOptions,
  LoadStatus,
} from '@queues-example/queue/load';
import {
  active,
  generator,
  generatorCount,
  isLoadQueue,
  maxGenerators,
  queueOf,
  type Env,
  type Report,
  type Run,
} from './run';

// Generators are woken again this often, which revives any whose loop died.
const watchMs = 30_000;
// A generator reports every ten seconds; one silent for longer has stopped.
const recentMs = 15_000;
const atOnce = 10;

const noCounts = (): LoadCounts => ({
  requests: 0,
  accepted: 0,
  rejected: 0,
  failed: 0,
});

/** The queue Worker answers an error of this name with 409 and its message. */
class QueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueError';
  }
}

const inGroups = async <Item>(
  items: readonly Item[],
  size: number,
  work: (item: Item) => Promise<unknown>
): Promise<void> => {
  for (let start = 0; start < items.length; start += size) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(items.slice(start, start + size).map(work));
  }
};

/**
 * Owns the run: prepares the tenants' queues, wakes the generators, and adds
 * up what they report for the dashboard.
 */
export class LoadController extends DurableObject<Env> {
  private run = this.ctx.storage.kv.get<Run>('run');
  private totals = this.ctx.storage.kv.get<LoadCounts>('totals') ?? noCounts();
  /** Each generator's last report; gone after a restart, back within a tick. */
  private readonly latest = new Map<number, { at: number; report: Report }>();

  private readonly alarms = new DurabilityAlarms({
    context: this.ctx,
    handlers: { watch: () => this.watch() },
  });

  async start(options: LoadOptions): Promise<LoadStatus> {
    if (active(this.run, Date.now())) {
      throw new QueueError('A load test is already running; stop it first');
    }
    const generators = generatorCount(options);
    if (generators > maxGenerators) {
      throw new QueueError(
        `That needs ${generators} generators and the limit is ${maxGenerators}; lower the tenants or the requests per second`
      );
    }

    await this.prepareQueues(options);
    const now = Date.now();
    const run: Run = {
      runId: crypto.randomUUID(),
      revision: now,
      startedAt: now,
      endsAt: now + options.seconds * 1_000,
      options,
    };
    // Scheduled before the run is stored, so a stored run is always watched.
    await this.alarms.watch(now + watchMs);
    this.store(run);
    this.totals = noCounts();
    this.ctx.storage.kv.put('totals', this.totals);
    this.latest.clear();
    await this.wake(run);
    return this.status();
  }

  async stop(): Promise<LoadStatus> {
    const run = this.run;
    if (active(run, Date.now())) {
      const stopped: Run = { ...run, stopped: true, revision: Date.now() };
      this.store(stopped);
      await this.wake(stopped);
    }
    return this.status();
  }

  status(): LoadStatus {
    const now = Date.now();
    const run = this.run;
    const recent = [...this.latest.values()].filter(
      (entry) => now - entry.at < recentMs && entry.report.seconds > 0
    );
    const perSecond = noCounts();
    let completed = 0;
    let latencySumMs = 0;
    let latencyMaxMs = 0;
    for (const { report } of recent) {
      perSecond.requests += report.requests / report.seconds;
      perSecond.accepted += report.accepted / report.seconds;
      perSecond.rejected += report.rejected / report.seconds;
      perSecond.failed += report.failed / report.seconds;
      completed += report.completed;
      latencySumMs += report.latencySumMs;
      latencyMaxMs = Math.max(latencyMaxMs, report.latencyMaxMs);
    }

    let phase: LoadStatus['phase'] = 'idle';
    if (run) {
      phase = active(run, now) ? 'running' : 'finished';
      if (run.stopped) {
        phase = 'stopped';
      }
    }
    return {
      phase,
      ...(run
        ? {
            options: run.options,
            startedAt: run.startedAt,
            endsAt: run.endsAt,
          }
        : {}),
      generators: recent.length,
      perSecond,
      latencyMs: {
        average: completed === 0 ? 0 : latencySumMs / completed,
        max: latencyMaxMs,
      },
      totals: this.totals,
    };
  }

  /** Called by each generator after a tick. */
  report(index: number, report: Report): void {
    this.totals = {
      requests: this.totals.requests + report.requests,
      accepted: this.totals.accepted + report.accepted,
      rejected: this.totals.rejected + report.rejected,
      failed: this.totals.failed + report.failed,
    };
    this.ctx.storage.kv.put('totals', this.totals);
    this.latest.set(index, { at: Date.now(), report });
  }

  async deleteQueues(): Promise<number> {
    if (active(this.run, Date.now())) {
      throw new QueueError('Stop the load test before deleting its queues');
    }
    const queues = (await this.env.QUEUE_ADMIN.list())
      .map((entry) => entry.name)
      .filter(isLoadQueue);
    await inGroups(queues, atOnce, (queue) =>
      this.env.QUEUE_ADMIN.delete(queue)
    );
    return queues.length;
  }

  /** One queue per tenant, each with a target that acknowledges everything. */
  private async prepareQueues(options: LoadOptions): Promise<void> {
    const existing = new Set(
      (await this.env.QUEUE_ADMIN.list()).map((entry) => entry.name)
    );
    const tenants = Array.from({ length: options.tenants }, (_, tenant) =>
      queueOf(tenant)
    );
    await inGroups(tenants, atOnce, async (queue) => {
      const settings = { partitions: options.partitions };
      await (existing.has(queue)
        ? this.env.QUEUE_ADMIN.updateSettings(queue, settings)
        : this.env.QUEUE_ADMIN.create(queue, settings));
      await this.env.QUEUE_ADMIN.putTarget(queue, 'sink', {
        // The queue's service binding to this Worker's `Sink`.
        destination: { type: 'rpc', binding: 'LOAD_SINK' },
        maxBatchSize: 100,
      });
    });
  }

  private store(run: Run): void {
    this.run = run;
    this.ctx.storage.kv.put('run', run);
  }

  /** Hands the run to every generator. One that cannot be reached is woken by the next check. */
  private async wake(run: Run): Promise<void> {
    const indexes = Array.from(
      { length: generatorCount(run.options) },
      (_, index) => index
    );
    await inGroups(indexes, 100, (index) =>
      generator(index)
        .start(run)
        .catch((error: unknown) =>
          console.error({ event: 'loadgen.wake.failed', index, error })
        )
    );
  }

  private async watch(): Promise<void> {
    const run = this.run;
    const now = Date.now();
    if (!active(run, now)) {
      return;
    }
    await this.alarms.watch(now + watchMs);
    await this.wake(run);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.alarms.alarm(info);
  }
}
