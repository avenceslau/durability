import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Durability,
  DurabilityAlarms,
  DuplicateDurableCallError,
  DuplicateDurablePayloadError,
  DurableAttemptsExhaustedError,
  DurableResultSerializationError,
  DurableRetryPolicyError,
  NonRetryableError as DurabilityNonRetryableError,
  type DurableCall,
  type DurabilityLifecycleEvent,
} from '../index';
import { contextFor, FakeStorage } from '../test-fakes';
import { exponential, jitter } from '../utils';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Durability', () => {
  it('does not overlap eager and alarm execution during async lookup', async () => {
    const storage = new FakeStorage();
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handler = vi.fn(async () => pending);
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: handler },
    });

    const registered = durability.work({ id: 'single-flight', payload: null });
    const alarm = durability.alarm();
    await registered;
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    finish?.();
    await alarm;
    await vi.waitFor(async () => {
      await expect(
        durability.work.getResult('single-flight')
      ).resolves.toMatchObject({ status: 'completed' });
    });
  });

  it('registers and arms the first alarm transactionally', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    let finishAlarmSetup: (() => void) | undefined;
    storage.alarmSetupBarrier = new Promise<void>((resolve) => {
      finishAlarmSetup = resolve;
    });
    const handler = vi.fn(
      async ({ payload }: DurableCall<{ value: number }>) => {
        const registered = storage.sql
          .exec<{ status: string }>(
            'SELECT status FROM durability_calls WHERE id = ?',
            'double:2'
          )
          .toArray();
        expect(registered).toEqual([{ status: 'pending' }]);
        return payload.value * 2;
      }
    );
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { double: handler },
    });

    await expect(durability.double.getResult('double:2')).resolves.toEqual({
      status: 'not_found',
    });
    const firstCall = durability.double({
      id: 'double:2',
      payload: { value: 2 },
    });
    expect(handler).not.toHaveBeenCalled();
    finishAlarmSetup?.();
    await expect(firstCall).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await expect(durability.double.getResult('double:2')).resolves.toEqual({
      status: 'completed',
      result: 4,
    });
    await vi.waitFor(() => expect(storage.alarmAt).toBeNull());
    await expect(
      durability.double({ id: 'double:2', payload: { value: 2 } })
    ).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('retains failed calls and retries them from an alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    let shouldFail = true;
    const handler = vi.fn(
      async ({ payload }: DurableCall<{ value: string }>) => {
        if (shouldFail) {
          throw new Error('temporary failure');
        }
        return payload.value;
      }
    );
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { deliver: handler },
      retries: { delay: () => 1_000 },
      alarmMinDelayMs: 1_000,
    });

    const retryAt = Date.now() + 1_000;
    await expect(
      durability.deliver({ id: 'delivery:1', payload: { value: 'sent' } })
    ).resolves.toBeUndefined();
    storage.alarmAt = null;
    await durability.alarm();
    expect(storage.alarmAt).toBe(retryAt);

    shouldFail = false;
    vi.advanceTimersByTime(1_000);
    await durability.alarm();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(storage.alarmAt).toBeNull();
    await expect(
      durability.deliver({ id: 'delivery:1', payload: { value: 'sent' } })
    ).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('runs a near-term operation retry from the in-memory timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const handler = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('retry'))
      .mockResolvedValue('done');
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: handler },
      retries: { delay: () => 5_000 },
    });

    const fallbackAt = Date.now() + 15_000;
    await durability.work({ id: 'timer-retry', payload: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    const pending = await durability.work.getResult('timer-retry');
    expect(pending.status).toBe('pending');
    if (pending.status !== 'pending') {
      throw new Error('Expected a pending retry');
    }

    expect(storage.alarmAt).toBe(fallbackAt);
    await vi.advanceTimersByTimeAsync(pending.nextAttemptAt - Date.now() - 1);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    await expect(durability.work.getResult('timer-retry')).resolves.toEqual({
      status: 'completed',
      result: 'done',
    });
    expect(storage.alarmAt).toBeNull();
  });

  it('recovers pending calls after the helper is recreated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const failing = new Durability({
      context: contextFor(storage),
      handlers: {
        send: async (_call: DurableCall<{ message: string }>) => {
          throw new Error('offline');
        },
      },
      retries: { delay: () => 1_000 },
      alarmMinDelayMs: 1_000,
    });

    const retryAt = Date.now() + 1_000;
    await expect(
      failing.send({ id: 'message:1', payload: { message: 'hello' } })
    ).resolves.toBeUndefined();
    storage.alarmAt = null;
    await failing.alarm();
    expect(storage.alarmAt).toBe(retryAt);

    const recoveredHandler = vi.fn(
      async ({ payload }: DurableCall<{ message: string }>) => payload.message
    );
    const recovered = new Durability({
      context: contextFor(storage),
      handlers: { send: recoveredHandler },
      retries: { delay: () => 1_000 },
      alarmMinDelayMs: 1_000,
    });
    vi.advanceTimersByTime(1_000);

    await recovered.alarm();

    expect(recoveredHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'message:1',
        operation: 'send',
        payload: { message: 'hello' },
        attempt: 2,
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('bounds alarm batches and concurrency', async () => {
    const storage = new FakeStorage();
    let active = 0;
    let maxActive = 0;
    const handler = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    });
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: handler },
      alarmConcurrency: 2,
    });

    for (let index = 0; index < 101; index += 1) {
      storage.sql.exec(
        `INSERT INTO durability_calls
          (id, operation, payload, status, attempt, next_attempt_at)
          VALUES (?, 'work', ?, 'pending', 0, 0)`,
        `alarm:${index}`,
        JSON.stringify({ kind: 'value', value: null })
      );
    }

    await durability.alarm();

    expect(handler).toHaveBeenCalledTimes(100);
    expect(maxActive).toBe(2);
    expect(storage.alarmAt).toBeGreaterThan(0);

    storage.alarmAt = null;
    await durability.alarm();
    expect(handler).toHaveBeenCalledTimes(101);
  });

  it('hands a long-running alarm execution to the next alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const initial = new Durability({
      context: contextFor(storage),
      handlers: {
        wait: async (_call: DurableCall<null>) => {
          throw new Error('retry from alarm');
        },
      },
      retries: { delay: () => 1_000 },
      alarmMinDelayMs: 1_000,
    });

    const retryAt = Date.now() + 1_000;
    await expect(
      initial.wait({ id: 'long:1', payload: null })
    ).resolves.toBeUndefined();
    storage.alarmAt = null;
    await initial.alarm();
    expect(storage.alarmAt).toBe(retryAt);

    let finish: ((value: string) => void) | undefined;
    const longResult = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const handler = vi.fn(async (_call: DurableCall<null>) => longResult);
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { wait: handler },
      alarmMinDelayMs: 1_000,
      alarmHandoffMs: 10_000,
    });
    vi.advanceTimersByTime(1_000);
    storage.alarmAt = null;

    const firstAlarm = durability.alarm({
      isRetry: false,
      retryCount: 0,
      scheduledTime: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await firstAlarm;

    await expect(durability.wait.getResult('long:1')).resolves.toMatchObject({
      status: 'pending',
      attempt: 2,
    });
    expect(storage.alarmAt).toBe(Date.now() + 1_000);
    storage.alarmAt = null;
    const secondAlarm = durability.alarm({
      isRetry: false,
      retryCount: 0,
      scheduledTime: Date.now(),
    });
    finish?.('done');
    await secondAlarm;

    await expect(durability.wait.getResult('long:1')).resolves.toEqual({
      status: 'completed',
      result: 'done',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(storage.alarmAt).toBeNull();
  });

  it('uses delay helpers and applies per-method attempt limits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(exponential(1)).toBe(1_000);
    expect(exponential(10)).toBe(300_000);
    expect(jitter(1_000)).toBe(750);

    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        retryable: async (_call: DurableCall<null>) => {
          throw new Error('retry');
        },
        terminal: async (_call: DurableCall<null>) => {
          throw new Error('terminal');
        },
      },
      retries: { delay: (attempt) => jitter(exponential(attempt)) },
      methods: { terminal: { retries: { maxAttempts: 1 } } },
      alarmMinDelayMs: 1_000,
    });

    await durability.retryable({ id: 'retryable:1', payload: null });
    storage.alarmAt = null;
    await durability.alarm();
    expect(storage.alarmAt).toBe(Date.now() + 1_000);

    await durability.terminal({ id: 'terminal:1', payload: null });
    await vi.waitFor(async () => {
      await expect(
        durability.terminal.getResult('terminal:1')
      ).resolves.toEqual({
        status: 'failed',
        attempt: 1,
        error: { name: 'Error', message: 'terminal' },
      });
    });
  });

  it('aborts timed-out handlers and stops non-retryable failures', async () => {
    vi.useFakeTimers();
    const storage = new FakeStorage();
    let timeoutSignal: AbortSignal | undefined;
    const WorkflowNonRetryableError = class NonRetryableError extends Error {};
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        timeout: async ({ signal }: DurableCall<null>) => {
          timeoutSignal = signal;
          await new Promise(() => undefined);
        },
        rejected: async (_call: DurableCall<null>) => {
          throw new DurabilityNonRetryableError('invalid recipient');
        },
        workflowRejected: async (_call: DurableCall<null>) => {
          throw new WorkflowNonRetryableError('invalid workflow input');
        },
      },
      methods: {
        timeout: { attemptTimeoutMs: 100, retries: { maxAttempts: 1 } },
      },
    });

    await durability.timeout({ id: 'timeout:1', payload: null });
    await vi.advanceTimersByTimeAsync(100);
    expect(timeoutSignal?.aborted).toBe(true);
    await expect(durability.timeout.getResult('timeout:1')).resolves.toEqual({
      status: 'failed',
      attempt: 1,
      error: {
        name: 'DurableAttemptTimeoutError',
        message: 'Durable operation "timeout" timed out after 100ms',
      },
    });

    await durability.rejected({ id: 'rejected:1', payload: null });
    await vi.waitFor(async () => {
      await expect(
        durability.rejected.getResult('rejected:1')
      ).resolves.toEqual({
        status: 'failed',
        attempt: 1,
        error: { name: 'NonRetryableError', message: 'invalid recipient' },
      });
    });

    await durability.workflowRejected({
      id: 'workflow-rejected:1',
      payload: null,
    });
    await vi.waitFor(async () => {
      await expect(
        durability.workflowRejected.getResult('workflow-rejected:1')
      ).resolves.toMatchObject({ status: 'failed', attempt: 1 });
    });
  });

  it('rejects reuse of an ID for a different operation', async () => {
    const durability = new Durability({
      context: contextFor(new FakeStorage()),
      handlers: {
        first: async (_call: DurableCall<null>) => 'first',
        second: async (_call: DurableCall<null>) => 'second',
      },
    });

    await durability.first({ id: 'shared', payload: null });

    await expect(
      durability.second({ id: 'shared', payload: null })
    ).rejects.toBeInstanceOf(DuplicateDurableCallError);
  });

  it('rejects reuse of an ID with a different payload and accepts the same data', async () => {
    const calls: unknown[] = [];
    const durability = new Durability({
      context: contextFor(new FakeStorage()),
      handlers: {
        send: async ({
          payload,
        }: DurableCall<{ to: string; tags?: string[] }>) => {
          calls.push(payload);
          return payload.to;
        },
      },
    });

    await durability.send({
      id: 'mail',
      payload: { to: 'ana', tags: ['a', 'b'] },
    });
    // Key order does not matter; the second registration is a no-op.
    await durability.send({
      id: 'mail',
      payload: { tags: ['a', 'b'], to: 'ana' },
    });
    await vi.waitFor(async () => {
      await expect(durability.send.getResult('mail')).resolves.toMatchObject({
        status: 'completed',
        result: 'ana',
      });
    });
    expect(calls).toHaveLength(1);

    // Array order and values do matter, before and after completion.
    await expect(
      durability.send({ id: 'mail', payload: { to: 'ana', tags: ['b', 'a'] } })
    ).rejects.toBeInstanceOf(DuplicateDurablePayloadError);
    await expect(
      durability.send({ id: 'mail', payload: { to: 'bob' } })
    ).rejects.toThrow(
      'Durable call "mail" for operation "send" was registered with a different payload'
    );
    expect(calls).toHaveLength(1);
  });

  it('ignores nested object key order and never leaks payloads in conflicts', async () => {
    const calls: unknown[] = [];
    const durability = new Durability({
      context: contextFor(new FakeStorage()),
      handlers: {
        send: async ({ payload }: DurableCall<Record<string, unknown>>) => {
          calls.push(payload);
          return 'ok';
        },
      },
    });

    await durability.send({ id: 'nested', payload: { meta: { a: 1, b: 2 } } });
    // A nested object with the same data in a different key order is a no-op.
    await durability.send({ id: 'nested', payload: { meta: { b: 2, a: 1 } } });
    await vi.waitFor(async () => {
      await expect(durability.send.getResult('nested')).resolves.toMatchObject({
        status: 'completed',
      });
    });
    expect(calls).toHaveLength(1);

    const error = await durability
      .send({
        id: 'nested',
        payload: { meta: { a: 1, b: 2 }, token: 'leaky-secret' },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DuplicateDurablePayloadError);
    const reported = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    expect(reported).not.toContain('leaky-secret');
    expect(calls).toHaveLength(1);
  });

  it('commits one authoritative payload for concurrent first registrations', async () => {
    const calls: unknown[] = [];
    const durability = new Durability({
      context: contextFor(new FakeStorage()),
      handlers: {
        send: async ({ payload }: DurableCall<{ cents: number }>) => {
          calls.push(payload);
          return payload.cents;
        },
      },
    });

    const results = await Promise.allSettled([
      durability.send({ id: 'transfer:42', payload: { cents: 100 } }),
      durability.send({ id: 'transfer:42', payload: { cents: 10_000 } }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      DuplicateDurablePayloadError
    );

    await vi.waitFor(async () => {
      await expect(
        durability.send.getResult('transfer:42')
      ).resolves.toMatchObject({ status: 'completed' });
    });
    expect(calls).toHaveLength(1);
    const stored = await durability.send.getResult('transfer:42');
    expect([100, 10_000]).toContain((stored as { result: number }).result);
  });

  it('keeps its alarm armed when a run cannot reconcile, instead of failing the alarm', async () => {
    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: async (_call: DurableCall<null>) => 'done' },
      alarmMinDelayMs: 1_000,
    });
    await durability.work({ id: 'job', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('job')).resolves.toMatchObject({
        status: 'completed',
      });
    });

    // The platform fires the alarm while storage is failing: the run cannot
    // reconcile, but it must not throw, and the alarm must still be set.
    const getAlarm = storage.getAlarm.bind(storage);
    storage.getAlarm = () => Promise.reject(new Error('storage unavailable'));
    const reported = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const before = Date.now();
    storage.alarmAt = null;
    await expect(durability.alarm()).resolves.toBeUndefined();
    expect(storage.alarmAt).toBeGreaterThanOrEqual(before + 1_000);
    expect(storage.alarmAt).toBeLessThan(before + 2_000);
    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'durability.alarm.failed' })
    );

    // Only when even the fallback cannot be armed does the failure reach the platform.
    const setAlarm = storage.setAlarm.bind(storage);
    storage.setAlarm = () => Promise.reject(new Error('storage unavailable'));
    await expect(durability.alarm()).rejects.toThrow('storage unavailable');

    storage.getAlarm = getAlarm;
    storage.setAlarm = setAlarm;
  });

  it('retries a failed alarm run in memory before the fallback alarm, backing off', async () => {
    vi.useFakeTimers();
    const storage = new FakeStorage();
    const handler = vi.fn(async (_call: DurableCall<null>) => 'done');
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: handler },
    });
    storage.sql.exec(
      `INSERT INTO durability_calls
        (id, operation, payload, status, attempt, next_attempt_at)
        VALUES ('due', 'work', ?, 'pending', 0, 0)`,
      JSON.stringify({ kind: 'value', value: null })
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exec = storage.sql.exec.bind(storage.sql);
    const runs: number[] = [];
    let failures = 2;
    vi.spyOn(storage.sql, 'exec').mockImplementation((query, ...bindings) => {
      if (/FROM durability_calls\s+WHERE status = 'pending'/.test(query)) {
        runs.push(Date.now());
        if (failures > 0) {
          failures -= 1;
          throw new Error('storage unavailable');
        }
      }
      return exec(query, ...bindings);
    });
    const start = Date.now();

    // The first run fails; the fallback alarm is 15 s away by default.
    await durability.alarm();
    expect(handler).not.toHaveBeenCalled();

    // Retried after 1 s, which fails again; the next retry waits 2 s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs.map((at) => at - start)).toEqual([0, 1_000]);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });

  it('rejects handler names that collide with instance members', () => {
    expect(
      () =>
        new Durability({
          context: contextFor(new FakeStorage()),
          handlers: {
            alarm: async () => undefined,
          },
        })
    ).toThrow('"alarm" is reserved by Durability');
    expect(
      () =>
        new DurabilityAlarms({
          context: contextFor(new FakeStorage()),
          handlers: {
            purgeBefore: async () => undefined,
          },
        })
    ).toThrow('"purgeBefore" is reserved by DurabilityAlarms');
  });

  it('keeps a timed-out operation locked until its handler settles', async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const attempts: number[] = [];
    const handler = vi.fn(async ({ attempt }: DurableCall<null>) => {
      attempts.push(attempt);
      if (attempt === 1) {
        await firstPending;
      }
    });
    const storage = new FakeStorage();
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: handler },
      alarmHandoffMs: 50,
      alarmConcurrency: 1,
      methods: {
        work: {
          attemptTimeoutMs: 100,
          retries: { delay: () => 0, maxAttempts: 2 },
        },
      },
    });

    await durability.work({ id: 'timeout-lock', payload: null });
    await vi.advanceTimersByTimeAsync(100);
    storage.alarmAt = null;
    const blocked = durability.alarm();
    await vi.advanceTimersByTimeAsync(50);
    await blocked;
    expect(handler).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await firstPending;
    await vi.advanceTimersByTimeAsync(0);
    storage.alarmAt = null;
    await durability.alarm();

    expect(attempts).toEqual([1, 2]);
    await expect(durability.work.getResult('timeout-lock')).resolves.toEqual({
      status: 'completed',
      result: undefined,
    });
  });

  it('never claims an exhausted operation', async () => {
    const storage = new FakeStorage();
    const work = vi.fn(async () => undefined);
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work },
      methods: { work: { retries: { maxAttempts: 2 } } },
    });
    storage.sql.exec(
      `INSERT INTO durability_calls
        (id, operation, payload, status, attempt, next_attempt_at)
       VALUES (?, 'work', ?, 'pending', 2, 0)`,
      'exhausted',
      JSON.stringify({ kind: 'value', value: null })
    );

    storage.alarmAt = null;
    await durability.alarm();

    expect(work).not.toHaveBeenCalled();
    await expect(durability.work.getResult('exhausted')).resolves.toMatchObject(
      {
        status: 'failed',
        attempt: 2,
        error: { name: DurableAttemptsExhaustedError.name },
      }
    );
  });

  it('makes unsafe retry policies terminal and persists their error', async () => {
    const callbacks = [
      () => {
        throw new Error('delay failed');
      },
      () => Number.NaN,
      () => -1,
      () => -0.1,
      () => Number.MAX_SAFE_INTEGER,
    ];

    await Promise.all(
      callbacks.map(async (delay, index) => {
        const durability = new Durability({
          context: contextFor(new FakeStorage()),
          handlers: {
            work: async () => {
              throw new Error('retry');
            },
          },
          retries: { delay, maxAttempts: 2 },
        });
        await durability.work({ id: `policy:${index}`, payload: null });
        await vi.waitFor(async () => {
          await expect(
            durability.work.getResult(`policy:${index}`)
          ).resolves.toMatchObject({
            status: 'failed',
            error: { name: DurableRetryPolicyError.name },
          });
        });
      })
    );
  });

  it('persists non-serializable successful results as terminal failures', async () => {
    const handler = vi.fn(async () => 1n);
    const durability = new Durability({
      context: contextFor(new FakeStorage()),
      handlers: { work: handler },
      retries: { maxAttempts: 3, delay: () => 0 },
    });

    await durability.work({ id: 'bigint', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('bigint')).resolves.toMatchObject({
        status: 'failed',
        attempt: 1,
        error: { name: DurableResultSerializationError.name },
      });
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('leaves saturated eager calls for their reconciled alarm', async () => {
    const storage = new FakeStorage();
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handler = vi.fn(async ({ id }: DurableCall<null>) => {
      if (id === 'first') {
        await firstPending;
      }
    });
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: handler },
      alarmConcurrency: 1,
    });

    await durability.work({ id: 'first', payload: null });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await durability.work({ id: 'second', payload: null });
    await durability.work({ id: 'second', payload: null });
    await expect(durability.work.getResult('second')).resolves.toMatchObject({
      status: 'pending',
      attempt: 0,
    });

    releaseFirst?.();
    await firstPending;
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);

    storage.alarmAt = null;
    await durability.alarm();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('validates the winner of concurrent same-ID registration', async () => {
    const durability = new Durability({
      context: contextFor(new FakeStorage()),
      handlers: {
        first: async () => 'first',
        second: async () => 'second',
      },
    });

    const registrations = await Promise.allSettled([
      durability.first({ id: 'race', payload: null }),
      durability.second({ id: 'race', payload: null }),
    ]);

    expect(
      registrations.filter(({ status }) => status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      registrations.find(({ status }) => status === 'rejected')
    ).toMatchObject({
      status: 'rejected',
      reason: expect.any(DuplicateDurableCallError),
    });
  });

  it('purges a strict cutoff and protects reused IDs from late settlement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10);
    const storage = new FakeStorage();
    let finishOld: (() => void) | undefined;
    const oldPending = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    let invocation = 0;
    let oldSignal: AbortSignal | undefined;
    const durability = new Durability({
      context: contextFor(storage),
      handlers: {
        work: async ({ signal }: DurableCall<null>) => {
          invocation += 1;
          if (invocation === 1) {
            oldSignal = signal;
            await oldPending;
            return 'old';
          }
          return 'new';
        },
      },
    });

    await durability.work({ id: 'reuse', payload: null });
    await vi.waitFor(() => expect(invocation).toBe(1));
    const cutoff = Date.now() + 10;
    vi.setSystemTime(cutoff);
    await durability.work({ id: 'kept', payload: null });

    await expect(durability.purgeBefore(cutoff)).resolves.toBe(1);
    expect(oldSignal?.aborted).toBe(true);
    await expect(durability.work.getResult('kept')).resolves.toMatchObject({
      status: 'completed',
    });

    await durability.work({ id: 'reuse', payload: null });
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('reuse')).resolves.toEqual({
        status: 'completed',
        result: 'new',
      });
    });
    finishOld?.();
    await oldPending;
    await vi.advanceTimersByTimeAsync(0);
    await expect(durability.work.getResult('reuse')).resolves.toEqual({
      status: 'completed',
      result: 'new',
    });
  });

  it('emits compact lifecycle events and isolates hook failures', async () => {
    const storage = new FakeStorage();
    const events: DurabilityLifecycleEvent[] = [];
    const pending: Promise<unknown>[] = [];
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const durability = new Durability({
      context: {
        ...contextFor(storage),
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
      },
      handlers: { work: async () => 'done' },
      onLifecycleEvent(event) {
        events.push(event);
        if (event.type === 'registered') {
          return Promise.reject(new Error('metrics unavailable'));
        }
        return undefined;
      },
    });

    await durability.work({ id: 'events', payload: null });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'attempt_settled')).toBe(
        true
      )
    );
    await Promise.all(pending);
    await durability.purgeBefore(Date.now() + 1);

    expect(events.map(({ type }) => type)).toEqual([
      'registered',
      'attempt_started',
      'attempt_settled',
      'purged',
    ]);
    expect(events.find(({ type }) => type === 'registered')).toMatchObject({
      entityKind: 'operation',
      operation: 'work',
      id: 'events',
      generation: expect.any(String),
      attempt: 0,
      timestamp: expect.any(Number),
    });
    expect(events.find(({ type }) => type === 'purged')).toMatchObject({
      entityKind: 'operation',
      count: 1,
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'durability.lifecycle_hook.failed',
        error: expect.objectContaining({
          name: 'Error',
          message: 'metrics unavailable',
        }),
      })
    );
  });

  it('omits handler results from default lifecycle events', async () => {
    const storage = new FakeStorage();
    const events: DurabilityLifecycleEvent[] = [];
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: async () => ({ secret: 'token-abc' }) },
      onLifecycleEvent(event) {
        events.push(event);
      },
    });

    await durability.work({ id: 'events', payload: null });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'attempt_settled')).toBe(
        true
      )
    );

    const settled = events.find((event) => event.type === 'attempt_settled');
    expect(settled).toMatchObject({ outcome: 'completed' });
    expect(settled).not.toHaveProperty('result');
    expect(JSON.stringify(events)).not.toContain('token-abc');
  });

  it('includes handler results only when includeResults is enabled', async () => {
    const storage = new FakeStorage();
    const events: DurabilityLifecycleEvent[] = [];
    const durability = new Durability({
      context: contextFor(storage),
      handlers: { work: async () => ({ secret: 'token-abc' }) },
      includeResults: true,
      onLifecycleEvent(event) {
        events.push(event);
      },
    });

    await durability.work({ id: 'events', payload: null });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'attempt_settled')).toBe(
        true
      )
    );

    expect(
      events.find((event) => event.type === 'attempt_settled')
    ).toMatchObject({
      outcome: 'completed',
      result: { secret: 'token-abc' },
    });
  });
});
