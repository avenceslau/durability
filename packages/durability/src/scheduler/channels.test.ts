import { afterEach, describe, expect, it, vi } from 'vitest';
import { Durability, DurabilityScheduler } from '../index';
import { engineFor } from './index';
import { contextFor, FakeStorage } from '../test-fakes';
import { DurabilitySemaphoreServer } from '../semaphore/server';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared scheduler channels', () => {
  it.each([false, true])(
    'does not repeatedly time active operations with liveTimers=%s',
    async (liveTimers) => {
      vi.useFakeTimers();
      const storage = new FakeStorage();
      const context = contextFor(storage);
      const scheduler = new DurabilityScheduler({ context, liveTimers });
      new DurabilitySemaphoreServer({ scheduler, limit: 1 });
      const work = new Durability({
        scheduler,
        handlers: {
          slow: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            return 'done';
          },
        },
      });
      const alarms = vi.spyOn(engineFor({ scheduler }), 'alarm');
      await work.slow({ id: 'a', payload: null });

      await vi.advanceTimersByTimeAsync(200);
      expect(alarms.mock.calls.length).toBeLessThan(10);
      expect(storage.alarmAt).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await work.slow.getResult('a')).toMatchObject({
        status: 'completed',
      });
      expect(storage.alarmAt).toBeNull();
    }
  );

  it('drains existing permits before granting waiters after lowering an omitted limit', async () => {
    const context = contextFor(new FakeStorage());
    const scheduler = new DurabilityScheduler({ context });
    const engine = engineFor({ scheduler });
    const held = Array.from({ length: 10 }, () => engine.tryAcquirePermit()!);
    const admitted = vi.fn();
    const waiting = engine.acquirePermit().then((release) => {
      admitted();
      return release;
    });
    void new DurabilityScheduler({ context, alarmConcurrency: 1 });
    for (const release of held.slice(0, 9)) {
      release();
    }
    await Promise.resolve();
    expect(admitted).not.toHaveBeenCalled();
    expect(engine.tryAcquirePermit()).toBeUndefined();
    held[9]!();
    const release = await waiting;
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(engine.tryAcquirePermit()).toBeUndefined();
    release();
    release();
    const available = engine.tryAcquirePermit();
    expect(available).toBeTypeOf('function');
    expect(engine.tryAcquirePermit()).toBeUndefined();
    available?.();
  });

  it('grants queued waiters when a later handle increases an omitted limit', async () => {
    const context = contextFor(new FakeStorage());
    const scheduler = new DurabilityScheduler({ context });
    const engine = engineFor({ scheduler });
    const held = Array.from({ length: 10 }, () => engine.tryAcquirePermit()!);
    const admitted = vi.fn();
    const waiting = engine.acquirePermit().then((release) => {
      admitted();
      return release;
    });
    void new DurabilityScheduler({ context, alarmConcurrency: 11 });
    await Promise.resolve();
    expect(admitted).toHaveBeenCalledTimes(1);
    const release = await waiting;
    expect(engine.tryAcquirePermit()).toBeUndefined();
    release();
    for (const finish of held) {
      finish();
    }
  });

  it.each(['reject', 'blocked'] as const)(
    'postpones missing channels before an attached channel is %s',
    async (mode) => {
      vi.useFakeTimers();
      const storage = new FakeStorage();
      const context = contextFor(storage);
      Durability.migrate(context);
      const scheduler = new DurabilityScheduler({
        context,
        alarmHandoffMs: 100,
      });
      const engine = engineFor({ scheduler });
      let finish!: () => void;
      const blocked = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const runDue = vi.fn(async () => {
        if (mode === 'reject') {
          throw new Error('claim failed');
        }
        await blocked;
      });
      engine.registerChannel({
        table: { name: 'durability_calls', key: 'id' },
        channel: 'default',
        helper: 'Durability',
        runDue,
      });
      storage.sql.exec(
        `INSERT INTO durability_calls
       (channel, id, operation, payload, status, attempt, next_attempt_at)
       VALUES ('removed', 'a', 'work', '{"kind":"value","value":null}', 'pending', 0, 0)`
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const start = Date.now();
      const execution = scheduler.alarm();
      await vi.advanceTimersByTimeAsync(100);
      await execution;
      expect(runDue).toHaveBeenCalledTimes(1);
      expect(
        storage.sql
          .exec('SELECT status, attempt, next_attempt_at FROM durability_calls')
          .toArray()
      ).toEqual([
        { status: 'pending', attempt: 0, next_attempt_at: start + 60_000 },
      ]);
      finish();
      await vi.advanceTimersByTimeAsync(0);
    }
  );
});
