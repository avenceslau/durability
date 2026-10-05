import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type {
  KvAlarmTestObject,
  NamedAlarmTestObject,
} from './named-alarm-worker';

declare global {
  namespace Cloudflare {
    interface Env {
      ALARM_TEST: DurableObjectNamespace<NamedAlarmTestObject>;
      KV_ALARM_TEST: DurableObjectNamespace<KvAlarmTestObject>;
    }
  }
}

const waitFor = async (
  assertion: () => Promise<void>,
  remaining = 20
): Promise<void> => {
  try {
    await assertion();
  } catch (error) {
    if (remaining === 0) {
      throw error;
    }
    await scheduler.wait(5);
    await waitFor(assertion, remaining - 1);
  }
};

describe('KV-backed durability in workerd', () => {
  it('retries an operation after eviction without SQLite', async () => {
    const stub = env.KV_ALARM_TEST.get(env.KV_ALARM_TEST.newUniqueId());
    await stub.startWork();
    await waitFor(async () => {
      expect(await stub.getWorkAttempts()).toEqual([1]);
    });

    await evictDurableObject(stub);
    await scheduler.wait(10);
    const recovered = env.KV_ALARM_TEST.get(stub.id);
    await runDurableObjectAlarm(recovered);

    await waitFor(async () => {
      expect(await recovered.getWorkResult()).toEqual({
        status: 'completed',
        result: 'done',
      });
    });
    expect(await recovered.getWorkAttempts()).toEqual([1, 2]);
  });

  it('runs named alarms from KV-backed storage', async () => {
    const stub = env.KV_ALARM_TEST.get(env.KV_ALARM_TEST.newUniqueId());
    const scheduledTime = Date.now() + 50;

    await stub.scheduleCleanup(scheduledTime);
    await scheduler.wait(60);
    await runDurableObjectAlarm(stub);
    await waitFor(async () => {
      expect(await stub.getRecorded()).toEqual([
        {
          attempt: 1,
          idempotencyKey: expect.stringMatching(/^durability-alarm:v1:/),
          scheduledTime,
        },
      ]);
    });
  });
});

describe('durability in workerd', () => {
  it('retries a named alarm with the same idempotency key after eviction', async () => {
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

  it('does not claim maxAttempts plus one after repeated eviction', async () => {
    const id = env.ALARM_TEST.newUniqueId();
    const stub = env.ALARM_TEST.get(id);
    await stub.startCrash();
    await waitFor(async () => {
      expect(await stub.getCrashAttempts()).toEqual([1]);
    });

    await stub.armNow();
    await evictDurableObject(stub);
    await scheduler.wait(10);
    const second = env.ALARM_TEST.get(id);
    await runDurableObjectAlarm(second);
    await waitFor(async () => {
      expect(await second.getCrashAttempts()).toEqual([1, 2]);
    });
    await waitFor(async () => {
      expect(await second.getCrashResult()).toMatchObject({
        status: 'failed',
        attempt: 2,
      });
    });

    await second.resetCrash();
    await evictDurableObject(second);
    await scheduler.wait(10);
    const exhausted = env.ALARM_TEST.get(id);
    await runDurableObjectAlarm(exhausted);
    await expect(exhausted.getCrashResult()).resolves.toMatchObject({
      status: 'failed',
      attempt: 2,
      error: { name: 'DurableAttemptsExhaustedError' },
    });
    expect(await exhausted.getCrashAttempts()).toEqual([1, 2]);
    expect(await runDurableObjectAlarm(exhausted)).toBe(false);
  });

  it('prevents overlap when a timed-out handler ignores abort', async () => {
    const stub = env.ALARM_TEST.get(env.ALARM_TEST.newUniqueId());
    await stub.startTimeout();
    await waitFor(async () => {
      expect(await stub.getTimeoutAttempts()).toEqual([1]);
    });
    await scheduler.wait(60);

    await stub.armNow();
    await scheduler.wait(10);
    await runDurableObjectAlarm(stub);
    expect(await stub.getTimeoutAttempts()).toEqual([1]);

    await stub.releaseTimeout();
    await scheduler.wait(1);
    await stub.armNow();
    await scheduler.wait(10);
    await runDurableObjectAlarm(stub);
    await waitFor(async () => {
      expect(await stub.getTimeoutAttempts()).toEqual([1, 2]);
    });
  });

  it('retries operation timeouts by default in workerd', async () => {
    const stub = env.ALARM_TEST.get(env.ALARM_TEST.newUniqueId());
    await stub.startTerminalTimeout();
    await waitFor(async () => {
      expect(await stub.getTerminalTimeoutAttempts()).toEqual([1, 2, 3]);
    });
    await waitFor(async () => {
      expect(await stub.getTerminalTimeoutResult()).toMatchObject({
        status: 'failed',
        attempt: 3,
        error: { name: 'DurableAttemptTimeoutError' },
      });
    });
  });

  it('bounds eager and alarm-driven handlers with shared concurrency', async () => {
    const stub = env.ALARM_TEST.get(env.ALARM_TEST.newUniqueId());
    await stub.startBounded(5);
    await waitFor(async () => {
      expect(await stub.getBoundedState()).toEqual({ max: 2, completed: 0 });
    });

    await stub.releaseBounded();
    await waitFor(async () => {
      expect(await stub.getBoundedState()).toEqual({ max: 2, completed: 5 });
    });
  });

  it('protects a reused ID from a purged handler settling late', async () => {
    const stub = env.ALARM_TEST.get(env.ALARM_TEST.newUniqueId());
    await stub.startReuse();
    await waitFor(async () => {
      expect(await stub.getReuseResult()).toMatchObject({
        status: 'pending',
        attempt: 1,
      });
    });

    expect(await stub.purgeAll()).toBe(1);
    await stub.startReuse();
    await waitFor(async () => {
      expect(await stub.getReuseResult()).toEqual({
        status: 'completed',
        result: 'new',
      });
    });

    await stub.releaseReuse();
    await scheduler.wait(1);
    expect(await stub.getReuseResult()).toEqual({
      status: 'completed',
      result: 'new',
    });
  });
});
