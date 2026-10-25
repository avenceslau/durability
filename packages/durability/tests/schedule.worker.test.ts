import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ScheduleObject } from './schedule-worker';

declare global {
  namespace Cloudflare {
    interface Env {
      SCHEDULE_TEST: DurableObjectNamespace<ScheduleObject>;
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
});
