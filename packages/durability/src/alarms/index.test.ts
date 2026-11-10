import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  DurabilityAlarms,
  DurabilityScheduler,
  NonRetryableError as DurabilityNonRetryableError,
} from '../index';
import { contextFor, FakeStorage } from '../test-fakes';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DurabilityAlarms', () => {
  it('infers scheduling methods and policies from handlers', () => {
    const alarms = new DurabilityAlarms({
      context: contextFor(new FakeStorage()),
      handlers: {
        cleanup: async () => undefined,
      },
    });

    expectTypeOf(alarms.cleanup).toEqualTypeOf<
      ((scheduledTime: number) => Promise<void>) & {
        cancel: () => Promise<boolean>;
      }
    >();

    const assertInvalidTypes = () => {
      void new DurabilityAlarms({
        context: contextFor(new FakeStorage()),
        handlers: { cleanup: async () => undefined },
        // @ts-expect-error alarm policies require a matching alarm handler
        methods: { missing: { retries: { maxAttempts: 2 } } },
      });
      // @ts-expect-error near-term scheduling is automatic, not a separate method
      void alarms.cleanup.now();
      // @ts-expect-error unconfigured alarm names are not schedulable
      void alarms.missing(Date.now());
    };
    expectTypeOf(assertInvalidTypes).toBeFunction();
  });

  it('starts a nearby named alarm at its scheduled time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cleanup = vi.fn(async () => pending);
    const background: Promise<unknown>[] = [];
    const alarms = new DurabilityAlarms({
      context: {
        ...contextFor(storage),
        waitUntil(promise: Promise<unknown>) {
          background.push(promise);
        },
      },
      handlers: { cleanup },
    });
    const scheduledTime = Date.now() + 5_000;
    const fallbackAt = Date.now() + 15_000;

    await alarms.cleanup(scheduledTime);

    expect(storage.alarmAt).toBe(fallbackAt);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(cleanup).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledTime, platform: undefined })
    );
    expect(background).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    storage.alarmAt = null;
    const fallback = alarms.alarm({
      isRetry: false,
      retryCount: 0,
      scheduledTime: fallbackAt,
    });
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);

    finish?.();
    await Promise.all([...background, fallback]);
    expect(storage.alarmAt).toBeNull();
  });

  it('publishes timer changes only after the storage transaction commits', async () => {
    vi.useFakeTimers();
    const assertRollback = async (storage: FakeStorage): Promise<void> => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const cleanup = vi.fn(async () => undefined);
      const alarms = new DurabilityAlarms({
        context: {
          storage: storage as unknown as DurableObjectStorage,
        },
        handlers: { cleanup },
      });
      const scheduledTime = Date.now() + 5_000;

      await alarms.cleanup(scheduledTime);
      storage.transactionCommitBarrier = Promise.reject(
        new Error('commit failed')
      );
      await expect(alarms.purgeBefore(Number.MAX_SAFE_INTEGER)).rejects.toThrow(
        'commit failed'
      );
      delete storage.transactionCommitBarrier;

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
      expect(cleanup).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledTime })
      );
    };

    await assertRollback(new FakeStorage());
  });

  it('uses the configured physical-alarm minimum as the timer boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const cleanup = vi.fn(async () => undefined);
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: { cleanup },
      alarmMinDelayMs: 5_000,
    });
    const scheduledTime = Date.now() + 5_000;

    await alarms.cleanup(scheduledTime);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(cleanup).not.toHaveBeenCalled();
    expect(storage.alarmAt).toBe(scheduledTime);
  });

  it('queues a nearby named alarm when concurrency is full', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    let finishBusy: (() => void) | undefined;
    const busyPending = new Promise<void>((resolve) => {
      finishBusy = resolve;
    });
    const busy = vi.fn(async () => busyPending);
    const cleanup = vi.fn(async () => undefined);
    const scheduler = new DurabilityScheduler({
      context: contextFor(storage),
      alarmConcurrency: 1,
    });
    const alarms = new DurabilityAlarms({
      scheduler,
      handlers: { busy, cleanup },
    });
    const fallbackAt = Date.now() + 15_000;

    await alarms.busy(Date.now());
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(busy).toHaveBeenCalledTimes(1));
    await alarms.cleanup(Date.now());
    await vi.advanceTimersByTimeAsync(0);

    expect(cleanup).not.toHaveBeenCalled();
    expect(storage.alarmAt).toBe(fallbackAt);

    finishBusy?.();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
  });

  it('queues a nearby replacement behind the running occurrence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    let finishFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const cleanup = vi.fn(async () => {
      if (cleanup.mock.calls.length === 1) {
        await firstPending;
      }
    });
    const refresh = vi.fn(async () => undefined);
    const scheduler = new DurabilityScheduler({
      context: contextFor(storage),
      alarmConcurrency: 2,
    });
    const alarms = new DurabilityAlarms({
      scheduler,
      handlers: { cleanup, refresh },
    });

    await alarms.cleanup(Date.now());
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    await alarms.cleanup(Date.now());
    await alarms.refresh(Date.now());
    await vi.advanceTimersByTimeAsync(0);

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(cleanup).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
  });

  it('schedules and executes a typed named alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const cleanup = vi.fn(async () => undefined);
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: { cleanup },
    });
    const scheduledTime = Date.now() + 15_000;

    await alarms.cleanup(scheduledTime);

    expect(storage.alarmAt).toBe(scheduledTime);
    vi.advanceTimersByTime(15_000);
    storage.alarmAt = null;
    const platform = {
      isRetry: false,
      retryCount: 0,
      scheduledTime,
    } satisfies AlarmInvocationInfo;
    await alarms.alarm(platform);

    expect(cleanup).toHaveBeenCalledWith({
      name: 'cleanup',
      scheduledTime,
      attempt: 1,
      isRetry: false,
      retryCount: 0,
      idempotencyKey: expect.stringMatching(/^durability-alarm:v1:/),
      signal: expect.any(AbortSignal),
      memoize: expect.any(Function),
      platform,
    });
    expect(storage.alarmAt).toBeNull();
  });

  it('runs due names and keeps the next named alarm scheduled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const cleanup = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: {
        cleanup,
        refresh,
      },
      alarmMinDelayMs: 1_000,
    });
    const refreshAt = Date.now() + 1_000;
    const cleanupAt = Date.now() + 60_000;

    await alarms.cleanup(cleanupAt);
    await alarms.refresh(refreshAt);
    expect(storage.alarmAt).toBe(refreshAt);

    vi.advanceTimersByTime(1_000);
    storage.alarmAt = null;
    await alarms.alarm();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect(storage.alarmAt).toBe(cleanupAt);
  });

  it('keeps a named alarm idempotency key stable across attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const invocations: Array<{ attempt: number; idempotencyKey: string }> = [];
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: {
        cleanup: async (info) => {
          invocations.push(info);
          if (info.attempt === 1) {
            throw new Error('temporary cleanup failure');
          }
        },
      },
      methods: { cleanup: { retries: { delay: () => 1_000 } } },
      alarmMinDelayMs: 1_000,
    });

    const retryAt = Date.now() + 1_000;
    await alarms.cleanup(Date.now());
    storage.alarmAt = null;
    await alarms.alarm();
    expect(storage.alarmAt).toBe(retryAt);

    vi.advanceTimersByTime(1_000);
    storage.alarmAt = null;
    await alarms.alarm({
      isRetry: false,
      retryCount: 0,
      scheduledTime: retryAt,
    });

    expect(invocations).toHaveLength(2);
    expect(invocations.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(invocations[1]?.idempotencyKey).toBe(invocations[0]?.idempotencyKey);
  });

  it('uses jittered retry delays for named alarms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const storage = new FakeStorage();
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: {
        cleanup: async () => {
          throw new Error('retry cleanup');
        },
      },
      alarmMinDelayMs: 1_000,
    });

    await alarms.cleanup(Date.now());
    storage.alarmAt = null;
    await alarms.alarm();

    expect(storage.alarmAt).toBe(Date.now() + 1_000);
  });

  it('makes non-retryable named alarm failures terminal', async () => {
    const storage = new FakeStorage();
    const cleanup = vi.fn(async () => {
      throw new DurabilityNonRetryableError('invalid cleanup');
    });
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: { cleanup },
    });

    await alarms.cleanup(Date.now());
    storage.alarmAt = null;
    await alarms.alarm();

    const state = storage.sql
      .exec<{ attempt: number; status: string }>(
        `SELECT attempt, status FROM durability_alarms WHERE name = 'cleanup'`
      )
      .toArray();
    expect(state).toEqual([{ attempt: 1, status: 'failed' }]);
    expect(storage.alarmAt).toBeNull();
    await alarms.alarm();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('stops named alarm retries after the configured attempts', async () => {
    const storage = new FakeStorage();
    const cleanup = vi.fn(async () => {
      throw new Error('cleanup unavailable');
    });
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: { cleanup },
      methods: { cleanup: { retries: { delay: () => 0, maxAttempts: 2 } } },
    });

    await alarms.cleanup(Date.now());
    storage.alarmAt = null;
    await alarms.alarm();
    storage.alarmAt = null;
    await alarms.alarm();

    const state = storage.sql
      .exec<{ attempt: number; status: string }>(
        `SELECT attempt, status FROM durability_alarms WHERE name = 'cleanup'`
      )
      .toArray();
    expect(state).toEqual([{ attempt: 2, status: 'failed' }]);
    expect(storage.alarmAt).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('makes timed-out named alarms terminal by default', async () => {
    vi.useFakeTimers();
    const storage = new FakeStorage();
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cleanup = vi.fn(async () => pending);
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: { cleanup },
      methods: {
        cleanup: {
          attemptTimeoutMs: 100,
          retries: { delay: () => 0, maxAttempts: 5 },
        },
      },
    });

    await alarms.cleanup(Date.now() + 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    storage.alarmAt = null;
    const invocation = alarms.alarm();
    await vi.advanceTimersByTimeAsync(100);
    await invocation;

    const state = storage.sql
      .exec<{ attempt: number; status: string }>(
        `SELECT attempt, status FROM durability_alarms WHERE name = 'cleanup'`
      )
      .toArray();
    expect(state).toEqual([{ attempt: 1, status: 'failed' }]);
    expect(storage.alarmAt).toBeNull();

    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    await alarms.alarm();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('holds the named alarm lock until a timed-out handler settles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    let finishFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const attempts: number[] = [];
    let invocation = 0;
    let timeoutSignal: AbortSignal | undefined;
    const cleanup = vi.fn(
      async ({ attempt, signal }: { attempt: number; signal: AbortSignal }) => {
        invocation += 1;
        attempts.push(attempt);
        if (invocation === 1) {
          timeoutSignal = signal;
          await firstPending;
        }
      }
    );
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: { cleanup },
      alarmHandoffMs: 150,
      methods: {
        cleanup: {
          attemptTimeoutMs: 100,
          retries: { delay: () => 0, maxAttempts: 2 },
          retryTimeouts: true,
        },
      },
    });

    await alarms.cleanup(Date.now() + 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    storage.alarmAt = null;
    const firstAlarm = alarms.alarm();
    await vi.advanceTimersByTimeAsync(100);
    await firstAlarm;
    expect(timeoutSignal?.aborted).toBe(true);

    storage.alarmAt = null;
    const blockedRetry = alarms.alarm();
    await vi.advanceTimersByTimeAsync(150);
    await blockedRetry;
    expect(cleanup).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await firstPending;
    await vi.advanceTimersByTimeAsync(0);
    storage.alarmAt = null;
    await alarms.alarm();

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([1, 2]);
  });

  it('runs only one invocation of a named alarm at a time', async () => {
    const storage = new FakeStorage();
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cleanup = vi.fn(async () => pending);
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: { cleanup },
    });

    await alarms.cleanup(Date.now());
    storage.alarmAt = null;
    const first = alarms.alarm();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    const duplicate = alarms.alarm();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);

    finish?.();
    await Promise.all([first, duplicate]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('preserves a replacement scheduled while the named alarm is running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    let finishFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const invocations: Array<{
      attempt: number;
      idempotencyKey: string;
      scheduledTime: number;
    }> = [];
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: {
        cleanup: async (info) => {
          invocations.push(info);
          if (invocations.length === 1) {
            await firstPending;
            throw new Error('obsolete cleanup failed');
          }
        },
      },
    });

    await alarms.cleanup(Date.now());
    storage.alarmAt = null;
    const first = alarms.alarm();
    await vi.waitFor(() => expect(invocations).toHaveLength(1));

    const replacementTime = Date.now() + 60_000;
    await alarms.cleanup(replacementTime);
    finishFirst?.();
    await first;

    expect(storage.alarmAt).toBe(replacementTime);
    vi.advanceTimersByTime(60_000);
    storage.alarmAt = null;
    await alarms.alarm();

    expect(invocations).toHaveLength(2);
    expect(invocations.map(({ attempt }) => attempt)).toEqual([1, 1]);
    expect(invocations[1]?.idempotencyKey).not.toBe(
      invocations[0]?.idempotencyKey
    );
    expect(invocations[1]?.scheduledTime).toBe(replacementTime);
  });

  it('serializes a replacement named alarm after its purged handler settles', async () => {
    const storage = new FakeStorage();
    let finishOld: (() => void) | undefined;
    const oldPending = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const cleanup = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (cleanup.mock.calls.length === 1) {
        await oldPending;
      }
      active -= 1;
    });
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: { cleanup },
    });

    await alarms.cleanup(Date.now());
    storage.alarmAt = null;
    const oldAlarm = alarms.alarm();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));

    await expect(alarms.purgeBefore(Date.now() + 1)).resolves.toBe(1);
    await alarms.cleanup(Date.now());
    storage.alarmAt = null;
    const blockedReplacement = alarms.alarm();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);

    finishOld?.();
    await Promise.all([oldAlarm, blockedReplacement]);
    storage.alarmAt = null;
    await alarms.alarm();

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it('moves the physical alarm forward for newly earlier work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: {
        cleanup: async () => undefined,
      },
      alarmMinDelayMs: 1_000,
    });

    await alarms.cleanup(Date.now() + 60_000);
    expect(storage.alarmAt).toBe(Date.now() + 60_000);

    await alarms.cleanup(Date.now() + 1_000);
    expect(storage.alarmAt).toBe(Date.now() + 1_000);
  });

  it('never claims an exhausted named alarm', async () => {
    const storage = new FakeStorage();
    const cleanup = vi.fn(async () => undefined);
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: { cleanup },
      methods: { cleanup: { retries: { maxAttempts: 2 } } },
    });
    await alarms.cleanup(Date.now() + 15_000);
    storage.sql.exec(
      `UPDATE durability_alarms
       SET attempt = 2, next_attempt_at = 0
       WHERE name = 'cleanup'`
    );

    storage.alarmAt = null;
    await alarms.alarm();

    expect(cleanup).not.toHaveBeenCalled();
    expect(
      storage.sql
        .exec<{ last_error_name: string; status: string }>(
          "SELECT last_error_name, status FROM durability_alarms WHERE name = 'cleanup'"
        )
        .toArray()
    ).toEqual([
      { last_error_name: 'DurableAttemptsExhaustedError', status: 'failed' },
    ]);
  });

  it('rejects a negative fractional named alarm retry delay', async () => {
    const storage = new FakeStorage();
    const alarms = new DurabilityAlarms({
      context: contextFor(storage),
      handlers: {
        cleanup: async () => {
          throw new Error('retry');
        },
      },
      methods: {
        cleanup: { retries: { delay: () => -0.1, maxAttempts: 2 } },
      },
    });

    await alarms.cleanup(Date.now());
    storage.alarmAt = null;
    await alarms.alarm();

    expect(
      storage.sql
        .exec<{ last_error_name: string; status: string }>(
          "SELECT last_error_name, status FROM durability_alarms WHERE name = 'cleanup'"
        )
        .toArray()
    ).toEqual([
      { last_error_name: 'DurableRetryPolicyError', status: 'failed' },
    ]);
  });
});
