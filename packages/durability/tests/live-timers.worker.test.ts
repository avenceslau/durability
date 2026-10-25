import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { LiveTimersObject } from './live-timers-worker';

declare global {
  namespace Cloudflare {
    interface Env {
      LIVE_TIMERS_TEST: DurableObjectNamespace<LiveTimersObject>;
    }
  }
}

describe('liveTimers in workerd', () => {
  it('recovers due work through the physical alarm after an object reset mid-run', async () => {
    const id = env.LIVE_TIMERS_TEST.newUniqueId();
    const stub = env.LIVE_TIMERS_TEST.get(id);

    await stub.startLong();
    await expect.poll(() => stub.runs()).toEqual([{ name: 'long', value: 1 }]);
    const tickAt = Date.now() + 200;
    await stub.scheduleTick(tickAt);

    // Eviction would wait for the hanging handler's waitUntil; abort resets at once.
    const aborted = await stub.abort().then(
      () => false,
      () => true
    );
    expect(aborted).toBe(true);
    const recovered = env.LIVE_TIMERS_TEST.get(id);
    // The in-memory timers died with the instance; only the physical alarm is left.
    expect(await recovered.physicalAlarm()).not.toBeNull();
    await scheduler.wait(250);
    expect(await recovered.runs()).toHaveLength(1);
    await runDurableObjectAlarm(recovered);

    await expect
      .poll(() => recovered.runs())
      .toEqual([
        { name: 'long', value: 1 },
        { name: 'tick', value: tickAt },
      ]);
    await expect
      .poll(() => recovered.longResult())
      .toMatchObject({
        status: 'failed',
        attempt: 1,
        error: { name: 'DurableAttemptsExhaustedError' },
      });
    expect(await runDurableObjectAlarm(recovered)).toBe(false);
    expect(await recovered.runs()).toHaveLength(2);
  });
});
