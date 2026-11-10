import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Durability,
  DurabilityAlarms,
  DurabilityScheduler,
  NonRetryableError as DurabilityNonRetryableError,
  type DurableCall,
} from '../index';
import { DurabilityTracker } from '../experimental';
import { contextFor, FakeStorage } from '../test-fakes';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DurabilityScheduler', () => {
  it('bounds the configurable physical-alarm delay', () => {
    for (const alarmMinDelayMs of [999, 15_001]) {
      expect(
        () =>
          new DurabilityScheduler({
            context: contextFor(new FakeStorage()),
            alarmMinDelayMs,
          })
      ).toThrow('alarmMinDelayMs must be between 1000 and 15000');
    }
  });

  it('does not push the physical fallback later during reconciliation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: {
        cleanup: async () => undefined,
        refresh: async () => undefined,
      },
    });
    const fallbackAt = Date.now() + 15_000;

    await alarms.cleanup(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await alarms.refresh(Date.now() + 5_000);

    expect(storage.alarmAt).toBe(fallbackAt);
  });

  it('reconciles the earliest operation retry and named alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const scheduler = new DurabilityScheduler({
      context: contextFor(storage),
    });
    const durability = new Durability({
      scheduler: scheduler,
      handlers: {
        work: async (_call: DurableCall<null>) => {
          throw new Error('retry work');
        },
      },
      retries: { delay: () => 60_000 },
    });
    const alarms = new DurabilityAlarms({
      scheduler: scheduler,
      handlers: {
        cleanup: async () => undefined,
      },
    });

    await durability.work({ id: 'work:1', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('work:1')).resolves.toMatchObject({
        status: 'pending',
        lastError: 'retry work',
      });
    });
    const operationRetryAt = storage.alarmAt;
    expect(operationRetryAt).toBeGreaterThan(Date.now() + 30_000);

    await alarms.cleanup(Date.now() + 120_000);
    expect(storage.alarmAt).toBe(operationRetryAt);

    const earlierCleanupAt = Date.now() + 30_000;
    await alarms.cleanup(earlierCleanupAt);
    expect(storage.alarmAt).toBe(earlierCleanupAt);
  });

  it('runs both helpers from one alarm and shares the concurrency bound', async () => {
    const storage = new FakeStorage();
    const scheduler = new DurabilityScheduler({
      context: contextFor(storage),
      alarmConcurrency: 1,
    });
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    let activeHandlers = 0;
    let maxActive = 0;
    const enter = async () => {
      calls += 1;
      activeHandlers += 1;
      maxActive = Math.max(maxActive, activeHandlers);
      if (calls === 1) {
        await firstPending;
      }
      activeHandlers -= 1;
    };
    const durability = new Durability({
      scheduler: scheduler,
      handlers: { work: async () => enter() },
    });
    const alarms = new DurabilityAlarms({
      scheduler: scheduler,
      handlers: {
        cleanup: async () => enter(),
      },
    });

    await durability.work({ id: 'eager', payload: null });
    await vi.waitFor(() => expect(calls).toBe(1));
    await alarms.cleanup(0);
    storage.sql.exec(
      `INSERT INTO durability_calls
        (id, operation, payload, status, attempt, next_attempt_at)
       VALUES (?, 'work', ?, 'pending', 0, 0)`,
      'alarm',
      JSON.stringify({ kind: 'value', value: null })
    );
    storage.alarmAt = null;
    const alarm = scheduler.alarm();
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseFirst?.();
    await alarm;
    expect(calls).toBe(3);
    expect(maxActive).toBe(1);
  });

  it('shares one scheduler between helpers built from the same context', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    const later = vi.fn(async () => undefined);
    const alarms = new DurabilityAlarms({ context, handlers: { later } });
    const durability = new Durability({
      context,
      handlers: { work: async () => 'done' },
    });

    const at = Date.now() + 60_000;
    await alarms.later(at);
    await durability.work({ id: 'a', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('a')).resolves.toMatchObject({
        status: 'completed',
      });
    });
    expect(storage.alarmAt).toBe(at);

    vi.setSystemTime(at);
    await durability.alarm();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('joins a second scheduler for the same object to the first', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    const first = new DurabilityScheduler({ context });
    const second = new DurabilityScheduler({ context });
    const later = vi.fn(async () => undefined);
    const alarms = new DurabilityAlarms({
      scheduler: first,
      handlers: { later },
    });
    await alarms.later(Date.now());
    void new Durability({
      scheduler: first,
      handlers: { work: async () => undefined },
    });

    expect(
      () =>
        new Durability({
          scheduler: second,
          handlers: { other: async () => undefined },
        })
    ).toThrow('already attached');
    await second.alarm();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('merges scheduler options and rejects a conflicting one', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    let active = 0;
    let maxActive = 0;
    const handler = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    });
    const durability = new Durability({ context, handlers: { work: handler } });
    const scheduler = new DurabilityScheduler({
      context,
      alarmConcurrency: 2,
      alarmMinDelayMs: 1_000,
    });
    void new DurabilityAlarms({
      scheduler,
      handlers: { later: async () => undefined },
    });

    expect(
      () => new DurabilityScheduler({ context, alarmMinDelayMs: 1_000 })
    ).not.toThrow();
    expect(
      () => new DurabilityScheduler({ context, alarmMinDelayMs: 2_000 })
    ).toThrow(
      'Scheduler option "alarmMinDelayMs" is already set to a different value for this Durable Object'
    );

    for (let index = 0; index < 10; index += 1) {
      storage.sql.exec(
        `INSERT INTO durability_calls
          (id, operation, payload, status, attempt, next_attempt_at)
          VALUES (?, 'work', ?, 'pending', 0, 0)`,
        `alarm:${index}`,
        JSON.stringify({ kind: 'value', value: null })
      );
    }
    await durability.alarm();

    expect(handler).toHaveBeenCalledTimes(10);
    expect(maxActive).toBe(2);
  });

  it('rejects a second copy of durability on the same object', () => {
    const context = contextFor(new FakeStorage());
    const registry = (globalThis as { [key: symbol]: unknown })[
      Symbol.for('durability.object-schedulers')
    ] as WeakMap<object, unknown>;
    registry.set(context.storage, {
      engine: {},
      installation: Symbol('another installation'),
    });

    expect(() => new DurabilityScheduler({ context })).toThrow(
      'Another copy of durability is already attached to this Durable Object'
    );
  });

  it('keeps operations on different channels apart on one scheduler', async () => {
    const storage = new FakeStorage();
    const scheduler = new DurabilityScheduler({ context: contextFor(storage) });
    const app = new Durability({
      scheduler,
      handlers: { work: async ({ id }: DurableCall<null>) => `app:${id}` },
    });
    const library = new Durability({
      scheduler,
      channel: 'library',
      handlers: { work: async ({ id }: DurableCall<null>) => `library:${id}` },
    });
    const tracker = new DurabilityTracker({ sources: { app, library } });

    await app.work({ id: 'same', payload: null });
    await library.work({ id: 'same', payload: null });
    await vi.waitFor(async () => {
      await expect(app.work.getResult('same')).resolves.toEqual({
        status: 'completed',
        result: 'app:same',
      });
      await expect(library.work.getResult('same')).resolves.toEqual({
        status: 'completed',
        result: 'library:same',
      });
    });

    const listed = await tracker.records();
    expect(listed.records.map(({ source, id }) => [source, id])).toEqual([
      ['app', 'same'],
      ['library', 'same'],
    ]);
    await expect(library.purgeBefore(Date.now() + 1)).resolves.toBe(1);
    await expect(app.work.getResult('same')).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(library.work.getResult('same')).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('rejects a second operations helper on a channel already attached', () => {
    const scheduler = new DurabilityScheduler({
      context: contextFor(new FakeStorage()),
    });
    void new Durability({
      scheduler,
      channel: 'library',
      handlers: { work: async () => undefined },
    });

    expect(
      () =>
        new Durability({
          scheduler,
          channel: 'library',
          handlers: { other: async () => undefined },
        })
    ).toThrow(
      'Durability for channel "library" is already attached to this scheduler'
    );
    expect(
      () =>
        new Durability({
          scheduler,
          channel: '',
          handlers: { other: async () => undefined },
        })
    ).toThrow('Durability channel must be a non-empty string');
  });

  it('keeps and postpones calls of a channel no helper attached', async () => {
    const storage = new FakeStorage();
    const ran = vi.fn(async () => 'done');
    Durability.migrate(contextFor(storage));
    storage.sql.exec(
      `INSERT INTO durability_calls
        (id, channel, operation, payload, status, attempt, next_attempt_at)
        VALUES ('a', 'removed', 'work', ?, 'pending', 0, 0)`,
      JSON.stringify({ kind: 'value', value: null })
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // A restarted object whose deploy no longer constructs the removed channel.
    const restarted = new Durability({
      context: contextFor(storage),
      handlers: { work: ran },
    });
    await restarted.alarm();
    expect(ran).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'durability.channel_missing' })
    );
    const [row] = storage.sql
      .exec<{ next_attempt_at: number }>(
        "SELECT next_attempt_at FROM durability_calls WHERE channel = 'removed'"
      )
      .toArray();
    expect(row?.next_attempt_at).toBeGreaterThanOrEqual(Date.now() + 59_000);

    // The channel's helper comes back and runs it.
    const returned = vi.fn(async () => 'back');
    const recovered = new Durability({
      context: contextFor(storage),
      channel: 'removed',
      handlers: { work: returned },
    });
    storage.sql.exec(
      "UPDATE durability_calls SET next_attempt_at = 0 WHERE channel = 'removed'"
    );
    await recovered.alarm();
    await vi.waitFor(async () => {
      await expect(recovered.work.getResult('a')).resolves.toEqual({
        status: 'completed',
        result: 'back',
      });
    });
  });

  it('runs alarms of one name on different channels with their own policy and hooks', async () => {
    const storage = new FakeStorage();
    const scheduler = new DurabilityScheduler({ context: contextFor(storage) });
    const appEvents: string[] = [];
    const libraryEvents: string[] = [];
    const fail = async () => {
      throw new Error('unavailable');
    };
    const app = new DurabilityAlarms({
      scheduler,
      handlers: { check: fail },
      retries: { maxAttempts: 1 },
      onLifecycleEvent(event) {
        appEvents.push('outcome' in event ? event.outcome : event.type);
      },
    });
    const library = new DurabilityAlarms({
      scheduler,
      channel: 'library',
      handlers: { check: fail },
      retries: { maxAttempts: 3, delay: () => 60_000 },
      onLifecycleEvent(event) {
        libraryEvents.push('outcome' in event ? event.outcome : event.type);
      },
    });

    await app.check(Date.now());
    await library.check(Date.now());
    storage.alarmAt = null;
    await scheduler.alarm();

    const rows = storage.sql
      .exec<{ channel: string; name: string; status: string }>(
        'SELECT channel, name, status FROM durability_alarms ORDER BY channel'
      )
      .toArray();
    expect(rows).toEqual([
      { channel: 'default', name: 'check', status: 'failed' },
      { channel: 'library', name: 'check', status: 'pending' },
    ]);
    await vi.waitFor(() => {
      expect(appEvents).toContain('failed');
      expect(libraryEvents).toContain('retry_scheduled');
    });
    expect(appEvents).not.toContain('retry_scheduled');
    expect(libraryEvents).not.toContain('failed');
  });

  it('lists, reads, and purges only its own channel', async () => {
    const storage = new FakeStorage();
    const scheduler = new DurabilityScheduler({ context: contextFor(storage) });
    const fail = async () => {
      throw new DurabilityNonRetryableError('failed');
    };
    const app = new DurabilityAlarms({ scheduler, handlers: { check: fail } });
    const library = new DurabilityAlarms({
      scheduler,
      channel: 'library',
      handlers: { check: fail, poll: fail },
    });
    await app.check(Date.now());
    await library.check(Date.now());
    await library.poll(Date.now());
    storage.alarmAt = null;
    await scheduler.alarm();
    const tracker = new DurabilityTracker({ sources: { app, library } });

    const listed = await tracker.records();
    expect(listed.records.map(({ source, id }) => [source, id])).toEqual([
      ['app', 'check'],
      ['library', 'check'],
      ['library', 'poll'],
    ]);
    await expect(tracker.get('app', 'poll')).resolves.toBeUndefined();
    await expect(
      tracker.records({ source: 'library', name: 'check' })
    ).resolves.toMatchObject({
      records: [{ source: 'library', id: 'check' }],
    });

    await expect(library.purgeBefore(Date.now() + 1)).resolves.toBe(2);
    expect(
      storage.sql.exec('SELECT channel, name FROM durability_alarms').toArray()
    ).toEqual([{ channel: 'default', name: 'check' }]);
  });

  it('rejects a second DurabilityAlarms on a channel', () => {
    const scheduler = new DurabilityScheduler({
      context: contextFor(new FakeStorage()),
    });
    void new DurabilityAlarms({
      scheduler,
      channel: 'library',
      handlers: { check: async () => undefined },
    });

    expect(
      () =>
        new DurabilityAlarms({
          scheduler,
          channel: 'library',
          handlers: { other: async () => undefined },
        })
    ).toThrow(
      'DurabilityAlarms for channel "library" is already attached to this scheduler'
    );
  });

  it('rejects attaching two helpers of the same kind', () => {
    const scheduler = new DurabilityScheduler({
      context: contextFor(new FakeStorage()),
    });
    void new Durability({
      scheduler: scheduler,
      handlers: { work: async () => undefined },
    });

    expect(
      () =>
        new Durability({
          scheduler: scheduler,
          handlers: { other: async () => undefined },
        })
    ).toThrow('already attached');
  });
});
