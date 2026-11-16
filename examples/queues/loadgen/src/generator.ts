import { DurableObject } from 'cloudflare:workers';
import { DurabilityAlarms } from 'durability';
import { exponential } from 'durability/utils';
import {
  active,
  assignment,
  controller,
  type Env,
  type Report,
  type Run,
} from './run';

// The alarm run stays open until the tick has started all its requests. A
// long tick keeps the gap between two ticks a small part of the whole.
const tickMs = 10_000;
// Requests are spread in short slices so the queue sees a steady rate, not
// one burst per tick.
const sliceMs = 100;
const slicesPerTick = tickMs / sliceMs;
const requestTimeoutMs = 10_000;
// A gap longer than a tick follows a restart; the cap stops it becoming a spike.
const maxCatchUpMs = tickMs + 5_000;

const nothing = (): Omit<Report, 'seconds' | 'requests'> => ({
  accepted: 0,
  rejected: 0,
  failed: 0,
  completed: 0,
  latencySumMs: 0,
  latencyMaxMs: 0,
});

/**
 * Sends to one queue at a steady rate. It is an open loop: a request outlives
 * the tick that started it, so a slow queue does not slow the load down, and
 * what the queue cannot take shows up as rejections and latency.
 */
export class LoadGenerator extends DurableObject<Env> {
  private run = this.ctx.storage.kv.get<Run>('run');
  private readonly index = Number(
    this.ctx.id.name?.replace('generator-', '') ?? 0
  );
  private lastTickAt: number | undefined;
  /** The part of a request the rate left over from the previous tick. */
  private owed = 0;
  private sequence = 0;
  private inFlight = 0;
  private outcomes = nothing();

  private readonly alarms = new DurabilityAlarms({
    context: this.ctx,
    handlers: { tick: () => this.tick() },
    attemptTimeoutMs: tickMs + 5_000,
    methods: {
      // A reset mid-tick must not end the loop. A retry may send part of a
      // tick twice, which a load test does not mind.
      tick: {
        retryTimeouts: true,
        retries: {
          maxAttempts: 3,
          delay: (attempt: number) => exponential(attempt, 250, 1_000),
        },
      },
    },
  });

  /**
   * Called by the controller for every start, stop and regular check. It
   * always schedules a tick, so it also revives a generator whose loop died.
   */
  async start(run: Run): Promise<void> {
    if (!this.run || run.revision > this.run.revision) {
      this.run = run;
      this.ctx.storage.kv.put('run', run);
    }
    await this.alarms.tick(Date.now());
  }

  private async tick(): Promise<void> {
    const run = this.run;
    const now = Date.now();
    if (!active(run, now)) {
      await this.finish();
      return;
    }

    // Scheduled first so that a tick that fails cannot end the loop.
    await this.alarms.tick(now + tickMs);
    const elapsedMs = Math.min(
      maxCatchUpMs,
      now - (this.lastTickAt ?? now - tickMs)
    );
    this.lastTickAt = now;

    const { queue, rate } = assignment(run.options, this.index);
    this.owed += (rate * elapsedMs) / 1_000;
    const requests = Math.floor(this.owed);
    this.owed -= requests;
    const sent = await this.send(run, queue, requests);
    this.report(sent, elapsedMs / 1_000);
  }

  /** Reports what was still on its way when the run ended, once it has all come back. */
  private async finish(): Promise<void> {
    this.lastTickAt = undefined;
    this.owed = 0;
    if (this.inFlight > 0) {
      await this.alarms.tick(Date.now() + 1_000);
      return;
    }
    if (this.outcomes.completed > 0) {
      this.report(0, 0);
    }
  }

  private report(requests: number, seconds: number): void {
    const report: Report = { ...this.outcomes, requests, seconds };
    this.outcomes = nothing();
    this.ctx.waitUntil(
      controller()
        .report(this.index, report)
        .catch((error: unknown) =>
          console.error({ event: 'loadgen.report.failed', error })
        )
    );
  }

  /**
   * Starts `count` requests paced across the tick, without awaiting their
   * answers, and resolves to how many it started: fewer when the run ends or
   * is stopped part of the way through.
   */
  private async send(run: Run, queue: string, count: number): Promise<number> {
    let sent = 0;
    for (let slice = 0; slice < slicesPerTick; slice += 1) {
      if (!active(this.run, Date.now())) {
        break;
      }
      const inSlice =
        Math.floor((count * (slice + 1)) / slicesPerTick) -
        Math.floor((count * slice) / slicesPerTick);
      sent += inSlice;
      for (let index = 0; index < inSlice; index += 1) {
        this.inFlight += 1;
        this.ctx.waitUntil(
          this.sendOne(run, queue).finally(() => {
            this.inFlight -= 1;
          })
        );
      }
      if (slice < slicesPerTick - 1) {
        // eslint-disable-next-line no-await-in-loop
        await scheduler.wait(sliceMs);
      }
    }
    return sent;
  }

  private async sendOne(run: Run, queue: string): Promise<void> {
    const startedAt = Date.now();
    const { minMessages, maxMessages, keys } = run.options;
    const count =
      minMessages + Math.floor(Math.random() * (maxMessages - minMessages + 1));
    const messages = Array.from({ length: count }, () => ({
      key: `key-${Math.floor(Math.random() * keys)}`,
      body: {
        generator: this.index,
        sequence: (this.sequence += 1),
        sentAt: startedAt,
      },
    }));

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        this.env.QUEUE.send(queue, messages),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('The send timed out')),
            requestTimeoutMs
          );
        }),
      ]);
      this.outcomes.accepted += outcome.accepted.length;
      this.outcomes.rejected += outcome.rejected.reduce(
        (all, rejection) => all + rejection.ids.length,
        0
      );
    } catch {
      this.outcomes.failed += 1;
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - startedAt;
    this.outcomes.completed += 1;
    this.outcomes.latencySumMs += latencyMs;
    this.outcomes.latencyMaxMs = Math.max(
      this.outcomes.latencyMaxMs,
      latencyMs
    );
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.alarms.alarm(info);
  }
}
