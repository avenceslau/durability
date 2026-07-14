import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createDurability,
  DuplicateDurableCallError,
  migrateDurability,
  NonRetryableError as DurabilityNonRetryableError,
  type DurableCall,
} from './index';
import { exponential, jitter } from './utils';

class NodeSqlStorage {
  private readonly database = new DatabaseSync(':memory:');

  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlStorageCursor<T> {
    const statements = query.split(';').filter((statement) => statement.trim());
    if (bindings.length === 0 && statements.length > 1) {
      this.database.exec(query);
      return {
        rowsRead: 0,
        rowsWritten: 0,
        toArray: () => [],
      } as unknown as SqlStorageCursor<T>;
    }

    const statement = this.database.prepare(query);
    const rows = statement.all(
      ...(bindings as SQLInputValue[])
    ) as unknown as T[];

    return {
      rowsRead: rows.length,
      rowsWritten: 0,
      toArray: () => rows,
    } as unknown as SqlStorageCursor<T>;
  }
}

class FakeStorage {
  readonly sql = new NodeSqlStorage() as unknown as SqlStorage;
  alarmAt: number | null = null;
  alarmSetupBarrier?: Promise<void>;
  private transactionTail = Promise.resolve();

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(timestamp: number | Date): Promise<void> {
    this.alarmAt = timestamp instanceof Date ? timestamp.getTime() : timestamp;
    await this.alarmSetupBarrier;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  async transaction<T>(
    closure: (transaction: DurableObjectTransaction) => Promise<T>
  ): Promise<T> {
    const result = this.transactionTail.then(() =>
      closure(this as unknown as DurableObjectTransaction)
    );
    this.transactionTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const contextFor = (storage: FakeStorage) => ({
  storage: storage as unknown as DurableObjectStorage,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('migrateDurability', () => {
  it('migrates up and down to an explicit target', () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);

    expect(migrateDurability(context)).toEqual({
      applied: [
        'durability_0001_create_calls',
        'durability_0002_pending_index',
        'durability_0003_create_alarms',
      ],
      rolledBack: [],
    });
    expect(migrateDurability(context, 'durability_0001_create_calls')).toEqual({
      applied: [],
      rolledBack: [
        'durability_0003_create_alarms',
        'durability_0002_pending_index',
      ],
    });
    expect(migrateDurability(context, null)).toEqual({
      applied: [],
      rolledBack: ['durability_0001_create_calls'],
    });
    expect(migrateDurability(context)).toEqual({
      applied: [
        'durability_0001_create_calls',
        'durability_0002_pending_index',
        'durability_0003_create_alarms',
      ],
      rolledBack: [],
    });
  });
});

describe('createDurability', () => {
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
    const durability = createDurability(contextFor(storage), {
      double: handler,
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
      durability.double({
        id: 'double:2',
        payload: { value: 2 },
      })
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
    const durability = createDurability(
      contextFor(storage),
      { deliver: handler },
      { retries: { delay: () => 1_000 } }
    );

    const retryAt = Date.now() + 1_000;
    await expect(
      durability.deliver({
        id: 'delivery:1',
        payload: { value: 'sent' },
      })
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
      durability.deliver({
        id: 'delivery:1',
        payload: { value: 'sent' },
      })
    ).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('recovers pending calls after the helper is recreated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const failing = createDurability(
      contextFor(storage),
      {
        send: async (_call: DurableCall<{ message: string }>) => {
          throw new Error('offline');
        },
      },
      { retries: { delay: () => 1_000 } }
    );

    const retryAt = Date.now() + 1_000;
    await expect(
      failing.send({
        id: 'message:1',
        payload: { message: 'hello' },
      })
    ).resolves.toBeUndefined();
    storage.alarmAt = null;
    await failing.alarm();
    expect(storage.alarmAt).toBe(retryAt);

    const recoveredHandler = vi.fn(
      async ({ payload }: DurableCall<{ message: string }>) => payload.message
    );
    const recovered = createDurability(
      contextFor(storage),
      { send: recoveredHandler },
      { retries: { delay: () => 1_000 } }
    );
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
    const durability = createDurability(
      contextFor(storage),
      { work: handler },
      { alarmConcurrency: 2 }
    );

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
    const initial = createDurability(
      contextFor(storage),
      {
        wait: async (_call: DurableCall<null>) => {
          throw new Error('retry from alarm');
        },
      },
      { retries: { delay: () => 1_000 } }
    );

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
    const durability = createDurability(
      contextFor(storage),
      { wait: handler },
      { alarmHandoffMs: 10_000 }
    );
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
    expect(storage.alarmAt).toBe(Date.now());
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
    const durability = createDurability(
      contextFor(storage),
      {
        retryable: async (_call: DurableCall<null>) => {
          throw new Error('retry');
        },
        terminal: async (_call: DurableCall<null>) => {
          throw new Error('terminal');
        },
      },
      {
        retries: {
          delay: (attempt) => jitter(exponential(attempt)),
        },
        methods: { terminal: { retries: { maxAttempts: 1 } } },
      }
    );

    await durability.retryable({ id: 'retryable:1', payload: null });
    storage.alarmAt = null;
    await durability.alarm();
    expect(storage.alarmAt).toBe(Date.now() + 750);

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
    const durability = createDurability(
      contextFor(storage),
      {
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
      {
        methods: {
          timeout: { attemptTimeoutMs: 100, retries: { maxAttempts: 1 } },
        },
      }
    );

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
        error: {
          name: 'NonRetryableError',
          message: 'invalid recipient',
        },
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

  it('infers scheduling methods and policies from named alarm handlers', () => {
    const storage = new FakeStorage();
    const durability = createDurability(
      contextFor(storage),
      {},
      { alarms: { cleanup: async () => undefined } }
    );

    expectTypeOf(durability.alarm.cleanup).toEqualTypeOf<
      (scheduledTime: number) => Promise<void>
    >();

    const assertInvalidTypes = () => {
      createDurability(
        contextFor(storage),
        {},
        {
          // @ts-expect-error alarm policies require a matching alarm handler
          alarmMethods: { missing: { retries: { maxAttempts: 2 } } },
        }
      );
      // @ts-expect-error unconfigured alarm names are not schedulable
      void durability.alarm.missing(Date.now());
    };
    expectTypeOf(assertInvalidTypes).toBeFunction();
  });

  it('schedules and executes a typed named alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const cleanup = vi.fn(async () => undefined);
    const durability = createDurability(
      contextFor(storage),
      {},
      { alarms: { cleanup } }
    );
    const scheduledTime = Date.now() + 5_000;

    await durability.alarm.cleanup(scheduledTime);

    expect(storage.alarmAt).toBe(scheduledTime);
    vi.advanceTimersByTime(5_000);
    storage.alarmAt = null;
    const platform = {
      isRetry: false,
      retryCount: 0,
      scheduledTime,
    } satisfies AlarmInvocationInfo;
    await durability.alarm(platform);

    expect(cleanup).toHaveBeenCalledWith({
      name: 'cleanup',
      scheduledTime,
      attempt: 1,
      isRetry: false,
      retryCount: 0,
      idempotencyKey: expect.stringMatching(/^durability-alarm:v1:/),
      signal: expect.any(AbortSignal),
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
    const durability = createDurability(
      contextFor(storage),
      {},
      { alarms: { cleanup, refresh } }
    );
    const refreshAt = Date.now() + 1_000;
    const cleanupAt = Date.now() + 60_000;

    await durability.alarm.cleanup(cleanupAt);
    await durability.alarm.refresh(refreshAt);
    expect(storage.alarmAt).toBe(refreshAt);

    vi.advanceTimersByTime(1_000);
    storage.alarmAt = null;
    await durability.alarm();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect(storage.alarmAt).toBe(cleanupAt);
  });

  it('keeps a named alarm idempotency key stable across attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const invocations: Array<{ attempt: number; idempotencyKey: string }> = [];
    const cleanup = vi.fn(
      async (info: { attempt: number; idempotencyKey: string }) => {
        invocations.push(info);
        if (info.attempt === 1) {
          throw new Error('temporary cleanup failure');
        }
      }
    );
    const durability = createDurability(
      contextFor(storage),
      {},
      {
        alarms: { cleanup },
        alarmMethods: { cleanup: { retries: { delay: () => 1_000 } } },
      }
    );

    const retryAt = Date.now() + 1_000;
    await durability.alarm.cleanup(Date.now());
    storage.alarmAt = null;
    await durability.alarm();
    expect(storage.alarmAt).toBe(retryAt);

    vi.advanceTimersByTime(1_000);
    storage.alarmAt = null;
    await durability.alarm({
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
    const durability = createDurability(
      contextFor(storage),
      {},
      {
        alarms: {
          cleanup: async () => {
            throw new Error('retry cleanup');
          },
        },
      }
    );

    await durability.alarm.cleanup(Date.now());
    storage.alarmAt = null;
    await durability.alarm();

    expect(storage.alarmAt).toBe(Date.now() + 750);
  });

  it('makes non-retryable named alarm failures terminal', async () => {
    const storage = new FakeStorage();
    const cleanup = vi.fn(async () => {
      throw new DurabilityNonRetryableError('invalid cleanup');
    });
    const durability = createDurability(
      contextFor(storage),
      {},
      { alarms: { cleanup } }
    );

    await durability.alarm.cleanup(Date.now());
    storage.alarmAt = null;
    await durability.alarm();

    const state = storage.sql
      .exec<{ attempt: number; status: string }>(
        `SELECT attempt, status FROM durability_alarms WHERE name = 'cleanup'`
      )
      .toArray();
    expect(state).toEqual([{ attempt: 1, status: 'failed' }]);
    expect(storage.alarmAt).toBeNull();
    await durability.alarm();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('stops named alarm retries after the configured attempts', async () => {
    const storage = new FakeStorage();
    const cleanup = vi.fn(async () => {
      throw new Error('cleanup unavailable');
    });
    const durability = createDurability(
      contextFor(storage),
      {},
      {
        alarms: { cleanup },
        alarmMethods: {
          cleanup: { retries: { delay: () => 0, maxAttempts: 2 } },
        },
      }
    );

    await durability.alarm.cleanup(Date.now());
    storage.alarmAt = null;
    await durability.alarm();
    storage.alarmAt = null;
    await durability.alarm();

    const state = storage.sql
      .exec<{ attempt: number; status: string }>(
        `SELECT attempt, status FROM durability_alarms WHERE name = 'cleanup'`
      )
      .toArray();
    expect(state).toEqual([{ attempt: 2, status: 'failed' }]);
    expect(storage.alarmAt).toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(2);
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
    const durability = createDurability(
      contextFor(storage),
      {},
      {
        alarmHandoffMs: 150,
        alarms: { cleanup },
        alarmMethods: {
          cleanup: {
            attemptTimeoutMs: 100,
            retries: { delay: () => 0, maxAttempts: 2 },
          },
        },
      }
    );

    await durability.alarm.cleanup(Date.now());
    storage.alarmAt = null;
    const firstAlarm = durability.alarm();
    await vi.advanceTimersByTimeAsync(100);
    await firstAlarm;
    expect(timeoutSignal?.aborted).toBe(true);

    storage.alarmAt = null;
    const blockedRetry = durability.alarm();
    await vi.advanceTimersByTimeAsync(150);
    await blockedRetry;
    expect(cleanup).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await firstPending;
    await vi.advanceTimersByTimeAsync(0);
    storage.alarmAt = null;
    await durability.alarm();

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
    const durability = createDurability(
      contextFor(storage),
      {},
      { alarms: { cleanup } }
    );

    await durability.alarm.cleanup(Date.now());
    storage.alarmAt = null;
    const first = durability.alarm();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    const duplicate = durability.alarm();
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
    const cleanup = vi.fn(
      async (info: {
        attempt: number;
        idempotencyKey: string;
        scheduledTime: number;
      }) => {
        invocations.push(info);
        if (invocations.length === 1) {
          await firstPending;
          throw new Error('obsolete cleanup failed');
        }
      }
    );
    const durability = createDurability(
      contextFor(storage),
      {},
      { alarms: { cleanup } }
    );

    await durability.alarm.cleanup(Date.now());
    storage.alarmAt = null;
    const first = durability.alarm();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));

    const replacementTime = Date.now() + 60_000;
    await durability.alarm.cleanup(replacementTime);
    finishFirst?.();
    await first;

    expect(storage.alarmAt).toBe(replacementTime);
    vi.advanceTimersByTime(60_000);
    storage.alarmAt = null;
    await durability.alarm();

    expect(invocations).toHaveLength(2);
    expect(invocations.map(({ attempt }) => attempt)).toEqual([1, 1]);
    expect(invocations[1]?.idempotencyKey).not.toBe(
      invocations[0]?.idempotencyKey
    );
    expect(invocations[1]?.scheduledTime).toBe(replacementTime);
  });

  it('moves the physical alarm forward for newly earlier work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const durability = createDurability(
      contextFor(storage),
      {},
      { alarms: { cleanup: async () => undefined } }
    );

    await durability.alarm.cleanup(Date.now() + 60_000);
    expect(storage.alarmAt).toBe(Date.now() + 60_000);

    await durability.alarm.cleanup(Date.now() + 1_000);
    expect(storage.alarmAt).toBe(Date.now() + 1_000);
  });

  it('reconciles the earliest operation retry and named alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    const durability = createDurability(
      contextFor(storage),
      {
        work: async (_call: DurableCall<null>) => {
          throw new Error('retry work');
        },
      },
      {
        alarms: { cleanup: async () => undefined },
        retries: { delay: () => 60_000 },
      }
    );

    await durability.work({ id: 'work:1', payload: null });
    await vi.waitFor(() => expect(storage.alarmAt).toBeGreaterThan(Date.now()));
    const operationRetryAt = storage.alarmAt;

    await durability.alarm.cleanup(Date.now() + 120_000);
    expect(storage.alarmAt).toBe(operationRetryAt);

    const earlierCleanupAt = Date.now() + 30_000;
    await durability.alarm.cleanup(earlierCleanupAt);
    expect(storage.alarmAt).toBe(earlierCleanupAt);
  });

  it('rejects reuse of an ID for a different operation', async () => {
    const storage = new FakeStorage();
    const durability = createDurability(contextFor(storage), {
      first: async (_call: DurableCall<null>) => 'first',
      second: async (_call: DurableCall<null>) => 'second',
    });

    await durability.first({ id: 'shared', payload: null });

    await expect(
      durability.second({ id: 'shared', payload: null })
    ).rejects.toBeInstanceOf(DuplicateDurableCallError);
  });
});
