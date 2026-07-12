import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDurability,
  DuplicateDurableCallError,
  migrateDurability,
  type DurableCall,
} from './index';

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
  setAlarmCalls = 0;
  private transactionTail = Promise.resolve();

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(timestamp: number | Date): Promise<void> {
    this.setAlarmCalls += 1;
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
        'durability_0003_execution_mode',
        'durability_0004_pending_mode_index',
      ],
      rolledBack: [],
    });
    expect(migrateDurability(context, 'durability_0001_create_calls')).toEqual({
      applied: [],
      rolledBack: [
        'durability_0004_pending_mode_index',
        'durability_0003_execution_mode',
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
        'durability_0003_execution_mode',
        'durability_0004_pending_mode_index',
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
      { retryDelay: () => 1_000 }
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
      { retryDelay: () => 1_000 }
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
      { retryDelay: () => 1_000 }
    );
    vi.advanceTimersByTime(1_000);

    await recovered.alarm();

    expect(recoveredHandler).toHaveBeenCalledWith({
      id: 'message:1',
      operation: 'send',
      payload: { message: 'hello' },
      attempt: 2,
    });
  });

  it('runs background batches inside one timer with bounded concurrency', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeStorage();
    let active = 0;
    let maxActive = 0;
    const handler = vi.fn(async ({ id }: DurableCall<null>) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return id;
    });
    const durability = createDurability(
      contextFor(storage),
      { work: handler },
      { backgroundConcurrency: 2 }
    );

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        durability.background.work({ id: `background:${index}`, payload: null })
      )
    );

    expect(handler).not.toHaveBeenCalled();
    expect(storage.setAlarmCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(50);

    expect(handler).toHaveBeenCalledTimes(5);
    expect(maxActive).toBe(2);
    await expect(
      durability.background.work.getResult('background:4')
    ).resolves.toEqual({ status: 'completed', result: 'background:4' });
  });

  it('runs at most 100 background calls in each timer callback', async () => {
    const callbacks: Array<() => Promise<void>> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
      callbacks.push(callback as () => Promise<void>);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    });
    const storage = new FakeStorage();
    const handler = vi.fn(async ({ id }: DurableCall<null>) => id);
    const durability = createDurability(contextFor(storage), { work: handler });

    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        durability.background.work({ id: `batch:${index}`, payload: null })
      )
    );
    await callbacks.shift()?.();

    expect(handler).toHaveBeenCalledTimes(100);
    expect(callbacks).toHaveLength(1);
    await callbacks.shift()?.();
    expect(handler).toHaveBeenCalledTimes(101);
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
          (id, operation, payload, status, attempt, next_attempt_at, execution_mode)
          VALUES (?, 'work', ?, 'pending', 0, 0, 'immediate')`,
        `alarm:${index}`,
        JSON.stringify({ kind: 'value', value: null })
      );
    }

    await durability.alarm();

    expect(handler).toHaveBeenCalledTimes(100);
    expect(maxActive).toBe(2);
    expect(storage.alarmAt).toBe(0);

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
      { retryDelay: () => 1_000 }
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
