import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { NamedAlarmTestObject } from './named-alarm-worker';

declare global {
  namespace Cloudflare {
    interface Env {
      ALARM_TEST: DurableObjectNamespace<NamedAlarmTestObject>;
    }
  }
}

describe('named alarms in workerd', () => {
  it('retries with the same idempotency key after eviction', async () => {
    const id = env.ALARM_TEST.newUniqueId();
    const stub = env.ALARM_TEST.get(id);
    const scheduledTime = Date.now() + 50;

    await stub.scheduleCleanup(scheduledTime);
    await scheduler.wait(60);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getRecorded()).toEqual([
      {
        attempt: 1,
        idempotencyKey: expect.stringMatching(/^durability-alarm:v1:/),
        scheduledTime,
      },
    ]);

    await evictDurableObject(stub);
    const recovered = env.ALARM_TEST.get(id);
    await scheduler.wait(60);
    await runDurableObjectAlarm(recovered);

    const recorded = await recovered.getRecorded();
    expect(recorded?.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(recorded?.[1]?.idempotencyKey).toBe(recorded?.[0]?.idempotencyKey);
    expect(await runDurableObjectAlarm(recovered)).toBe(false);
  });
});
