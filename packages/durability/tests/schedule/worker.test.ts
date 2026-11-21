import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { LiveScheduleObject, ScheduleObject } from './worker';

declare global {
  namespace Cloudflare {
    interface Env {
      SCHEDULE_TEST: DurableObjectNamespace<ScheduleObject>;
      LIVE_SCHEDULE_TEST: DurableObjectNamespace<LiveScheduleObject>;
    }
  }
}

type Stub = DurableObjectStub<ScheduleObject>;

const expectScheduleFinished = async (stub: Stub) => {
  await expect
    .poll(
      async () =>
        (await stub.nextAt()) === undefined && (await stub.pendingRuns()) === 0,
      { timeout: 10_000 }
    )
    .toBe(true);
};

const expectFourRowsPerRun = async (stub: Stub, runs: number) => {
  expect(await stub.rowsWritten()).toBe(
    4 * runs + (await stub.queuedRunCount())
  );
};

/**
 * Runs the window to the end and returns its firings. A schedule collapses
 * ticks whose firing time has passed into one run, so a slow host can skip
 * ticks, but only ticks already due when the run before them was reserved,
 * which is no later than that run started.
 */
const runScheduleWindow = async (
  stub: Stub,
  window: { every: number; count: number; runMs: number; jitterMs?: number }
) => {
  const { every, count, runMs, jitterMs = 0 } = window;
  const first = await stub.start(every, count, runMs, false, jitterMs);
  await expectScheduleFinished(stub);

  const firings = await stub.firings();

  const ticks = Array.from(
    { length: count },
    (_, index) => first + index * every
  );

  expect(firings[0]?.scheduled_time).toBe(first);

  for (const [index, firing] of firings.entries()) {
    const nextFired = firings[index + 1]?.scheduled_time ?? Infinity;

    const covered = ticks.filter(
      (tick) => tick >= firing.scheduled_time && tick < nextFired
    );

    expect(ticks).toContain(firing.scheduled_time);
    expect(firing.due_at).toBe(firing.scheduled_time + jitterMs);

    for (const tick of covered) {
      expect(firing.started_at).toBeGreaterThanOrEqual(tick + jitterMs);
    }
  }

  return firings;
};

describe('schedule in workerd', { timeout: 20_000 }, () => {
  it('writes four rows per run and keeps nothing once outcomes are delivered', async () => {
    const stub = env.SCHEDULE_TEST.get(env.SCHEDULE_TEST.newUniqueId());

    const firings = await runScheduleWindow(stub, {
      every: 40,
      count: 5,
      runMs: 5,
    });

    const outcomes = await stub.outcomes();
    expect(outcomes.map((row) => row.scheduled_time)).toEqual(
      firings.map((row) => row.scheduled_time)
    );
    expect(outcomes.every((row) => row.status === 'complete')).toBe(true);
    await expectFourRowsPerRun(stub, firings.length);
  });

  it('arms the physical alarm once per run when ticks are further apart than alarmMinDelayMs', async () => {
    const stub = env.SCHEDULE_TEST.get(env.SCHEDULE_TEST.newUniqueId());

    await stub.start(1_500, 3, 5);
    await expectScheduleFinished(stub);

    const runs = (await stub.outcomes()).length;
    expect(await stub.setAlarmCalls()).toBe(runs);
    await expectFourRowsPerRun(stub, runs);
  });

  it('fires each tick at its nominal time plus jitterMs with four rows per run', async () => {
    const stub = env.SCHEDULE_TEST.get(env.SCHEDULE_TEST.newUniqueId());

    const firings = await runScheduleWindow(stub, {
      every: 60,
      count: 4,
      runMs: 5,
      jitterMs: 35,
    });

    expect((await stub.outcomes()).map((row) => row.scheduled_time)).toEqual(
      firings.map((row) => row.scheduled_time)
    );
    await expectFourRowsPerRun(stub, firings.length);
  });

  it('keeps a random jitter when the version is resent and re-rolls it for a new version', async () => {
    const stub = env.SCHEDULE_TEST.get(env.SCHEDULE_TEST.newUniqueId());
    const expression = JSON.stringify({ every: 60_000, until: 2 ** 50 });
    const jitterMs = { maxMs: 10 ** 9 };

    const first = await stub.configure({ expression, version: 1, jitterMs });
    const resent = await stub.configure({ expression, version: 1, jitterMs });
    const next = await stub.configure({ expression, version: 2, jitterMs });

    expect(first.applied).toBe(true);
    expect(resent).toEqual({ applied: false, state: first.state });
    expect(next.applied).toBe(true);
    expect(next.state?.jitterMs).not.toBe(first.state?.jitterMs);

    for (const { state } of [first, next]) {
      expect(state?.jitterMs).toBeGreaterThanOrEqual(0);
      expect(state?.jitterMs).toBeLessThanOrEqual(jitterMs.maxMs);
    }

    expect(await stub.physicalAlarm()).toBe(
      (next.state?.nextAt ?? 0) + (next.state?.jitterMs ?? 0)
    );
  });

  it('overlaps runs up to maxConcurrentRuns and reports every one', async () => {
    const stub = env.SCHEDULE_TEST.get(env.SCHEDULE_TEST.newUniqueId());
    const every = 30;
    const count = 6;
    const runMs = 200;

    expect(runMs).toBeGreaterThan((count - 1) * every);

    const firings = await runScheduleWindow(stub, { every, count, runMs });
    expect(await stub.observedMaxActive()).toBe(2);
    expect(
      (await stub.outcomes()).map(({ status, attempt }) => ({
        status,
        attempt,
      }))
    ).toEqual(Array(firings.length).fill({ status: 'complete', attempt: 1 }));
  });

  it('reports a run interrupted by an object reset as errored instead of re-running it', async () => {
    const id = env.SCHEDULE_TEST.newUniqueId();
    const stub = env.SCHEDULE_TEST.get(id);

    const first = await stub.start(50, 1, -1);
    await expect.poll(() => stub.runs(), { timeout: 2_000 }).toHaveLength(1);
    expect((await stub.runs())[0]).toEqual({
      scheduled_time: first,
      idempotency_key: `${id.toString()}:${first}`,
    });

    // Eviction would wait for the held alarm to drain; abort resets at once.
    const aborted = await stub.abort().then(
      () => false,
      () => true
    );

    expect(aborted).toBe(true);
    const recovered = env.SCHEDULE_TEST.get(id);
    await runDurableObjectAlarm(recovered);

    await expect
      .poll(() => recovered.outcomes())
      .toEqual([
        {
          scheduled_time: first,
          attempt: 1,
          status: 'errored',
          error_name: 'ScheduledRunInterruptedError',
        },
      ]);
    expect(await recovered.runs()).toHaveLength(1);
    expect(await recovered.pendingRuns()).toBe(0);
    expect(await runDurableObjectAlarm(recovered)).toBe(false);
  });

  it.each(['SCHEDULE_TEST', 'LIVE_SCHEDULE_TEST'] as const)(
    'reports a run interrupted mid-flight once and keeps ticking (%s)',
    async (binding) => {
      const namespace = env[binding];
      const id = namespace.newUniqueId();
      const stub = namespace.get(id);
      const every = 1_200;

      const first = await stub.start(every, 2, 5, true);
      await expect
        .poll(async () => (await stub.runs()).length, { timeout: 3_000 })
        .toBeGreaterThan(0);
      // While the run is in flight the next tick is its eviction fallback,
      // which the scheduler never arms sooner than alarmMinDelayMs from now.
      const fallback = await stub.physicalAlarm();
      expect(fallback).toBeGreaterThanOrEqual(first + every);
      expect(fallback).toBeLessThanOrEqual(
        Math.max(first + every, Date.now() + 1_000)
      );

      const aborted = await stub.abort().then(
        () => false,
        () => true
      );

      expect(aborted).toBe(true);
      const recovered = namespace.get(id);
      await runDurableObjectAlarm(recovered);

      await expectScheduleFinished(recovered);

      const interrupted = {
        attempt: 1,
        status: 'errored',
        error_name: 'ScheduledRunInterruptedError',
      };

      const completed = { attempt: 1, status: 'complete', error_name: null };

      // A slow host can start the second tick before the reset; it is then
      // interrupted too. Either way each run is reported once, in order.
      const outcomes = await recovered.outcomes();

      const interruptedCount = outcomes.filter(
        (row) => row.status === 'errored'
      ).length;

      expect(outcomes).toEqual(
        (await recovered.runs()).map(({ scheduled_time }, index) => ({
          scheduled_time,
          ...(index < interruptedCount ? interrupted : completed),
        }))
      );
      expect(outcomes[0]?.scheduled_time).toBe(first);
      expect(interruptedCount).toBeGreaterThan(0);
      expect(await runDurableObjectAlarm(recovered)).toBe(false);
    }
  );
});
