import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { LiveScheduleObject, ScheduleObject } from './schedule-worker';

declare global {
  namespace Cloudflare {
    interface Env {
      SCHEDULE_TEST: DurableObjectNamespace<ScheduleObject>;
      LIVE_SCHEDULE_TEST: DurableObjectNamespace<LiveScheduleObject>;
    }
  }
}

describe('schedule in workerd', () => {
  it('writes four rows per run and keeps nothing once outcomes are delivered', async () => {
    const stub = env.SCHEDULE_TEST.get(env.SCHEDULE_TEST.newUniqueId());
    const runs = 5;

    const first = await stub.start(40, runs, 5);
    await expect
      .poll(() => stub.outcomes(), { timeout: 5_000 })
      .toHaveLength(runs);
    await expect.poll(() => stub.pendingRuns()).toBe(0);

    expect(await stub.nextAt()).toBeUndefined();
    expect((await stub.outcomes()).map((row) => row.scheduled_time)).toEqual(
      Array.from({ length: runs }, (_, index) => first + index * 40)
    );
    expect(
      (await stub.outcomes()).every((row) => row.status === 'complete')
    ).toBe(true);
    expect((await stub.rowsWritten()) / runs).toBe(4);
  });

  it('arms the physical alarm once per run when ticks are further apart than alarmMinDelayMs', async () => {
    const stub = env.SCHEDULE_TEST.get(env.SCHEDULE_TEST.newUniqueId());
    const runs = 3;

    await stub.start(1_500, runs, 5);
    await expect
      .poll(() => stub.outcomes(), { timeout: 10_000 })
      .toHaveLength(runs);
    await expect.poll(() => stub.pendingRuns()).toBe(0);

    expect(await stub.setAlarmCalls()).toBe(runs);
    expect((await stub.rowsWritten()) / runs).toBe(4);
  });

  it('fires each tick at its nominal time plus jitterMs with four rows per run', async () => {
    const stub = env.SCHEDULE_TEST.get(env.SCHEDULE_TEST.newUniqueId());
    const runs = 4;
    const every = 60;
    const jitterMs = 35;

    const first = await stub.start(every, runs, 5, false, jitterMs);
    await expect
      .poll(() => stub.outcomes(), { timeout: 5_000 })
      .toHaveLength(runs);
    await expect.poll(() => stub.pendingRuns()).toBe(0);

    const firings = await stub.firings();
    expect(
      firings.map(({ scheduled_time, due_at }) => [scheduled_time, due_at])
    ).toEqual(
      Array.from({ length: runs }, (_, index) => [
        first + index * every,
        first + index * every + jitterMs,
      ])
    );
    for (const { due_at, started_at } of firings) {
      expect(started_at).toBeGreaterThanOrEqual(due_at);
    }
    expect((await stub.outcomes()).map((row) => row.scheduled_time)).toEqual(
      firings.map((row) => row.scheduled_time)
    );
    expect((await stub.rowsWritten()) / runs).toBe(4);
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
    const runs = 6;

    await stub.start(30, runs, 120);
    await expect
      .poll(() => stub.outcomes(), { timeout: 5_000 })
      .toHaveLength(runs);
    await expect.poll(() => stub.pendingRuns()).toBe(0);

    expect(await stub.observedMaxActive()).toBe(2);
    expect(
      (await stub.outcomes()).map(({ status, attempt }) => ({
        status,
        attempt,
      }))
    ).toEqual(Array(runs).fill({ status: 'complete', attempt: 1 }));
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
      await expect.poll(() => stub.runs(), { timeout: 3_000 }).toHaveLength(1);
      // While the run is in flight the next tick is its eviction fallback.
      expect(await stub.physicalAlarm()).toBe(first + every);

      const aborted = await stub.abort().then(
        () => false,
        () => true
      );
      expect(aborted).toBe(true);
      const recovered = namespace.get(id);
      await runDurableObjectAlarm(recovered);

      await expect
        .poll(() => recovered.outcomes(), { timeout: 5_000 })
        .toEqual([
          {
            scheduled_time: first,
            attempt: 1,
            status: 'errored',
            error_name: 'ScheduledRunInterruptedError',
          },
          {
            scheduled_time: first + every,
            attempt: 1,
            status: 'complete',
            error_name: null,
          },
        ]);
      expect(
        (await recovered.runs()).map(({ scheduled_time }) => scheduled_time)
      ).toEqual([first, first + every]);
      await expect.poll(() => recovered.pendingRuns()).toBe(0);
      expect(await runDurableObjectAlarm(recovered)).toBe(false);
    }
  );
});
