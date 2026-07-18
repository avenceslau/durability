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
    await scheduler.wait(30);
    await runDurableObjectAlarm(recovered);

    const recorded = await recovered.getRecorded();
    expect(recorded?.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(recorded?.[1]?.idempotencyKey).toBe(recorded?.[0]?.idempotencyKey);
    expect(await runDurableObjectAlarm(recovered)).toBe(false);
  });

  it('recovers an operation after eviction without exceeding max attempts', async () => {
    const id = env.ALARM_TEST.newUniqueId();
    const stub = env.ALARM_TEST.get(id);

    await stub.registerRecover('recover');
    await scheduler.wait(10);
    expect(await stub.recoverResult('recover')).toMatchObject({
      status: 'pending',
      attempt: 1,
    });

    await evictDurableObject(stub);
    const recovered = env.ALARM_TEST.get(id);
    await scheduler.wait(30);
    await runDurableObjectAlarm(recovered);
    expect(await recovered.recoverResult('recover')).toMatchObject({
      status: 'completed',
      result: 'recover',
    });
  });

  it('recovers a claimed operation after isolate eviction without max plus one', async () => {
    const id = env.ALARM_TEST.newUniqueId();
    const stub = env.ALARM_TEST.get(id);

    await stub.registerCrashAfterClaim('crash-window');
    await scheduler.wait(10);
    expect(await stub.crashAfterClaimResult('crash-window')).toMatchObject({
      status: 'pending',
      attempt: 1,
    });
    expect(await stub.getCrashInvocations()).toBe(1);

    await stub.resetAfterClaim().catch(() => undefined);
    const recovered = env.ALARM_TEST.get(id);
    expect(await runDurableObjectAlarm(recovered)).toBe(true);
    expect(await recovered.crashAfterClaimResult('crash-window')).toMatchObject(
      { status: 'completed', result: 'recovered' }
    );
    expect(await recovered.getCrashInvocations()).toBe(2);
    expect(await runDurableObjectAlarm(recovered)).toBe(false);
    expect(await recovered.getCrashInvocations()).toBe(2);
  });

  it('never invokes an operation beyond its hard attempt limit', async () => {
    const stub = env.ALARM_TEST.get(env.ALARM_TEST.newUniqueId());

    await stub.registerFailure('hard-max');
    await scheduler.wait(30);
    await runDurableObjectAlarm(stub);
    expect(await stub.failureResult('hard-max')).toMatchObject({
      status: 'failed',
      attempt: 2,
    });
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it('deduplicates concurrent registration and bounds eager handlers', async () => {
    const stub = env.ALARM_TEST.get(env.ALARM_TEST.newUniqueId());

    await Promise.all([
      stub.registerOnce('same-id'),
      stub.registerOnce('same-id'),
    ]);
    await scheduler.wait(10);
    expect(await stub.getOnceInvocations()).toBe(1);

    await Promise.all([
      stub.registerBounded('bounded:1'),
      stub.registerBounded('bounded:2'),
      stub.registerBounded('bounded:3'),
    ]);
    await scheduler.wait(10);
    expect(await stub.boundedStats()).toEqual({ active: 1, maxActive: 1 });
    await stub.releaseOne();
    await scheduler.wait(10);
    expect(await stub.boundedStats()).toEqual({ active: 1, maxActive: 1 });
    await stub.releaseOne();
    await scheduler.wait(10);
    await stub.releaseOne();
  });

  it('does not overlap an abort-ignoring timed-out handler', async () => {
    const stub = env.ALARM_TEST.get(env.ALARM_TEST.newUniqueId());

    await stub.registerIgnoreAbort('ignore-abort');
    await scheduler.wait(30);
    expect(await stub.ignoreAbortResult('ignore-abort')).toMatchObject({
      status: 'pending',
      attempt: 1,
    });
    await stub.registerIgnoreAbort('ignore-abort');
    expect(await stub.ignoreAbortStats()).toEqual({
      active: 1,
      invocations: 1,
      maxActive: 1,
    });

    await stub.releaseIgnoreAbort();
    await scheduler.wait(10);
    expect(await stub.ignoreAbortStats()).toEqual({
      active: 1,
      invocations: 2,
      maxActive: 1,
    });
    await stub.releaseIgnoreAbort();
    await scheduler.wait(10);
    expect(await stub.ignoreAbortResult('ignore-abort')).toMatchObject({
      status: 'completed',
    });
  });

  it('keeps live cancellation and retry stable until the handler settles', async () => {
    const stub = env.ALARM_TEST.get(env.ALARM_TEST.newUniqueId());

    await stub.registerIgnoreAbort('cancel-blocked');
    await scheduler.wait(10);
    expect(await stub.cancelIgnoreAbort('cancel-blocked')).toEqual({
      status: 'updated',
    });
    expect(await stub.retryIgnoreAbort('cancel-blocked')).toEqual({
      status: 'unchanged',
    });
    await stub.releaseIgnoreAbort();
    await scheduler.wait(10);
    expect(await stub.retryIgnoreAbort('cancel-blocked')).toEqual({
      status: 'updated',
    });
    await scheduler.wait(10);
    expect(await stub.ignoreAbortStats()).toMatchObject({
      active: 1,
      invocations: 2,
      maxActive: 1,
    });
    await stub.releaseIgnoreAbort();
    await scheduler.wait(10);
    expect(await stub.ignoreAbortResult('cancel-blocked')).toMatchObject({
      status: 'completed',
    });
  });

  it('protects a reused ID from a late generation purged while active', async () => {
    const stub = env.ALARM_TEST.get(env.ALARM_TEST.newUniqueId());

    await stub.registerIgnoreAbort('purged-active');
    await scheduler.wait(10);
    expect(await stub.purgeBefore(Date.now() + 1)).toMatchObject({
      operations: 1,
      total: 1,
    });
    await stub.registerIgnoreAbort('purged-active');
    expect(await stub.ignoreAbortStats()).toMatchObject({
      active: 1,
      invocations: 1,
    });

    await stub.releaseIgnoreAbort();
    await scheduler.wait(10);
    await runDurableObjectAlarm(stub);
    expect(await stub.ignoreAbortResult('purged-active')).toMatchObject({
      status: 'pending',
      attempt: 1,
    });
    expect(await stub.ignoreAbortStats()).toMatchObject({
      active: 1,
      invocations: 2,
      maxActive: 1,
    });
    await stub.releaseIgnoreAbort();
    await scheduler.wait(10);
    expect(await stub.ignoreAbortResult('purged-active')).toMatchObject({
      status: 'completed',
    });
  });

  it('supports versions, administrative deletion, and purge', async () => {
    const stub = env.ALARM_TEST.get(env.ALARM_TEST.newUniqueId());

    await stub.registerVersion('accepted', '1', '1');
    await stub.registerVersion('mismatch', '0', '1');
    await scheduler.wait(10);
    expect(await stub.versionResult('accepted')).toMatchObject({
      status: 'completed',
      operationVersion: '1',
      payloadVersion: '1',
    });
    expect(await stub.versionResult('mismatch')).toMatchObject({
      status: 'failed',
      error: { name: 'DurableVersionMismatchError' },
    });

    await stub.registerFailure('delete-me');
    await scheduler.wait(10);
    expect(await stub.deleteFailure('delete-me')).toEqual({
      status: 'deleted',
    });
    expect(await stub.failureResult('delete-me')).toEqual({
      status: 'not_found',
    });

    await stub.registerFailure('purge-me');
    await scheduler.wait(10);
    expect(await stub.purgeBefore(Date.now() + 1)).toMatchObject({
      operations: 3,
      total: 3,
    });
  });
});
