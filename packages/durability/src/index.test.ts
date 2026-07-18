import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDurability,
  DuplicateDurableCallError,
  DurablePayloadValidationError,
  DurableResultValidationError,
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
  transactionCount = 0;
  transactionFailureAt?: number;
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
    this.transactionCount += 1;
    if (this.transactionCount === this.transactionFailureAt) {
      throw new Error('unexpected storage failure');
    }
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
  it('preserves legacy rows with safe hardening defaults', () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    migrateDurability(context, 'durability_0003_create_alarms');
    storage.sql.exec(
      `INSERT INTO durability_calls
        (id, operation, payload, status, attempt, next_attempt_at)
       VALUES ('legacy', 'work', ?, 'pending', 1, 100)`,
      JSON.stringify({ kind: 'value', value: null })
    );
    storage.sql.exec(
      `INSERT INTO durability_alarms
        (name, generation_id, status, scheduled_at, next_attempt_at, attempt)
       VALUES ('cleanup', 'alarm-generation', 'pending', 100, 100, 1)`
    );

    expect(migrateDurability(context)).toEqual({
      applied: ['durability_0004_harden_queue'],
      rolledBack: [],
    });
    const migratedCall = storage.sql
      .exec<{
        created_at: number;
        generation_id: string;
        operation_version: string;
        payload_version: string;
      }>(
        `SELECT created_at, generation_id, operation_version, payload_version
         FROM durability_calls WHERE id = 'legacy'`
      )
      .toArray()[0];
    expect(migratedCall).toMatchObject({
      generation_id: 'legacy:legacy',
      operation_version: '1',
      payload_version: '1',
    });
    expect(migratedCall?.created_at).toBeGreaterThan(0);
    const migratedAlarm = storage.sql
      .exec<{ created_at: number; handler_version: string }>(
        `SELECT created_at, handler_version FROM durability_alarms
         WHERE name = 'cleanup'`
      )
      .toArray()[0];
    expect(migratedAlarm?.handler_version).toBe('1');
    expect(migratedAlarm?.created_at).toBeGreaterThan(0);
  });

  it('round-trips populated v4 data through its lossy down migration', () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    migrateDurability(context);
    storage.sql.exec(
      `INSERT INTO durability_calls (
         id, operation, payload, status, attempt, next_attempt_at, created_at,
         generation_id, operation_version, payload_version, last_error,
         last_error_name
       ) VALUES (
         'cancelled', 'work', ?, 'cancelled', 2, 10, 20,
         'generation-v4', '2', '3', 'cancelled', 'DurableCancellationError'
       )`,
      JSON.stringify({ kind: 'value', value: null })
    );
    storage.sql.exec(
      `INSERT INTO durability_alarms (
         name, generation_id, status, scheduled_at, next_attempt_at, attempt,
         created_at, handler_version, last_error, last_error_name
       ) VALUES (
         'cleanup', 'alarm-generation', 'cancelled', 10, 10, 2, 20, '4',
         'cancelled', 'DurableCancellationError'
       )`
    );

    expect(migrateDurability(context, 'durability_0003_create_alarms')).toEqual(
      {
        applied: [],
        rolledBack: ['durability_0004_harden_queue'],
      }
    );
    expect(
      storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM durability_calls WHERE id = 'cancelled'"
        )
        .toArray()
    ).toEqual([{ status: 'failed' }]);
    expect(
      storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM durability_alarms WHERE name = 'cleanup'"
        )
        .toArray()
    ).toEqual([{ status: 'failed' }]);

    expect(migrateDurability(context)).toEqual({
      applied: ['durability_0004_harden_queue'],
      rolledBack: [],
    });
    expect(
      storage.sql
        .exec<{
          created_at: number;
          generation_id: string;
          operation_version: string;
          payload_version: string;
          status: string;
        }>(
          `SELECT status, created_at, generation_id, operation_version,
             payload_version
           FROM durability_calls WHERE id = 'cancelled'`
        )
        .toArray()
    ).toEqual([
      expect.objectContaining({
        status: 'failed',
        generation_id: 'legacy:cancelled',
        operation_version: '1',
        payload_version: '1',
        created_at: expect.any(Number),
      }),
    ]);
    expect(
      storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name LIKE 'durability_%_idx'
           ORDER BY name`
        )
        .toArray()
    ).toEqual([
      { name: 'durability_alarms_created_idx' },
      { name: 'durability_alarms_pending_idx' },
      { name: 'durability_calls_created_idx' },
      { name: 'durability_calls_pending_idx' },
    ]);
    expect(
      storage.sql
        .exec<{ name: string }>(
          'SELECT name FROM durability_migrations ORDER BY id'
        )
        .toArray()
        .map(({ name }) => name)
    ).toEqual([
      'durability_0001_create_calls',
      'durability_0002_pending_index',
      'durability_0003_create_alarms',
      'durability_0004_harden_queue',
    ]);
  });

  it('removes all package tables and migration history at the null target', () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    migrateDurability(context);

    expect(migrateDurability(context, null)).toEqual({
      applied: [],
      rolledBack: [
        'durability_0004_harden_queue',
        'durability_0003_create_alarms',
        'durability_0002_pending_index',
        'durability_0001_create_calls',
      ],
    });
    expect(
      storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE name IN (
             'durability_calls', 'durability_alarms', 'durability_migrations'
           )`
        )
        .toArray()
    ).toEqual([]);
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
    const durability = createDurability(
      contextFor(storage),
      { double: handler },
      {
        methods: {
          double: {
            payloadSchema: z.object({ value: z.number() }),
            resultSchema: z.number(),
          },
        },
      }
    );

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
    await vi.waitFor(async () => {
      await expect(durability.double.getResult('double:2')).resolves.toEqual({
        status: 'completed',
        operationVersion: '1',
        payloadVersion: '1',
        result: 4,
      });
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

  it('persists transformed payloads and returns transformed results', async () => {
    const storage = new FakeStorage();
    const handler = vi.fn(
      async ({ payload }: DurableCall<{ value: string }>) => payload.value
    );
    const durability = createDurability(
      contextFor(storage),
      { normalize: handler },
      {
        methods: {
          normalize: {
            payloadSchema: z.object({
              value: z.string().transform(async (value) => value.trim()),
            }),
            resultSchema: z
              .string()
              .transform(async (value) => value.toUpperCase()),
          },
        },
      }
    );

    await durability.normalize({
      id: 'normalize:1',
      payload: { value: '  ready  ' },
    });

    expect(
      storage.sql
        .exec<{ payload: string }>(
          `SELECT payload FROM durability_calls WHERE id = 'normalize:1'`
        )
        .toArray()[0]?.payload
    ).toBe(JSON.stringify({ kind: 'value', value: { value: 'ready' } }));
    await vi.waitFor(async () => {
      await expect(
        durability.normalize.getResult('normalize:1')
      ).resolves.toMatchObject({ status: 'completed', result: 'READY' });
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { value: 'ready' } })
    );
  });

  it('rejects invalid payloads before persistence', async () => {
    const storage = new FakeStorage();
    const handler = vi.fn(
      async ({ payload }: DurableCall<{ value: number }>) => payload.value
    );
    const durability = createDurability(
      contextFor(storage),
      { validate: handler },
      {
        methods: {
          validate: {
            payloadSchema: z.object({ value: z.number() }),
            resultSchema: z.number(),
          },
        },
      }
    );

    await expect(
      durability.validate({
        id: 'invalid-registration',
        // @ts-expect-error verifies runtime validation at registration
        payload: { value: 'not-a-number' },
      })
    ).rejects.toBeInstanceOf(DurablePayloadValidationError);
    expect(handler).not.toHaveBeenCalled();
    expect(
      storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM durability_calls
           WHERE id = 'invalid-registration'`
        )
        .toArray()
    ).toEqual([{ count: 0 }]);
  });

  it('makes a corrupted recovered payload terminal before invocation', async () => {
    const storage = new FakeStorage();
    const handler = vi.fn(
      async ({ payload }: DurableCall<{ value: number }>) => payload.value
    );
    const durability = createDurability(
      contextFor(storage),
      { validate: handler },
      {
        methods: {
          validate: {
            payloadSchema: z.object({ value: z.number() }),
            resultSchema: z.number(),
          },
        },
      }
    );
    storage.sql.exec(
      `INSERT INTO durability_calls
        (id, operation, payload, status, attempt, next_attempt_at)
       VALUES ('corrupt-payload', 'validate', ?, 'pending', 0, 0)`,
      'not-json'
    );

    await durability.alarm();
    await durability.alarm();

    expect(handler).not.toHaveBeenCalled();
    await expect(
      durability.validate.getResult('corrupt-payload')
    ).resolves.toMatchObject({
      status: 'failed',
      attempt: 1,
      error: { name: 'DurablePayloadValidationError' },
    });
  });

  it('makes invalid handler results terminal without rerunning', async () => {
    const storage = new FakeStorage();
    const handler = vi.fn(
      async (_call: DurableCall<undefined>): Promise<number | string> =>
        'invalid'
    );
    const durability = createDurability(
      contextFor(storage),
      { validateResult: handler },
      {
        methods: {
          validateResult: {
            payloadSchema: z.undefined(),
            resultSchema: z.number(),
          },
        },
      }
    );

    await durability.validateResult({
      id: 'invalid-result',
      payload: undefined,
    });
    await vi.waitFor(async () => {
      await expect(
        durability.validateResult.getResult('invalid-result')
      ).resolves.toMatchObject({
        status: 'failed',
        attempt: 1,
        error: { name: 'DurableResultValidationError' },
      });
    });
    await durability.alarm();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects corrupted completed results without rerunning the handler', async () => {
    const storage = new FakeStorage();
    const handler = vi.fn(
      async ({ payload }: DurableCall<{ value: number }>) => payload.value * 2
    );
    const durability = createDurability(
      contextFor(storage),
      { double: handler },
      {
        methods: {
          double: {
            payloadSchema: z.object({ value: z.number() }),
            resultSchema: z.number(),
          },
        },
      }
    );
    await durability.double({ id: 'corrupt-result', payload: { value: 2 } });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    storage.sql.exec(
      `UPDATE durability_calls SET result = ? WHERE id = 'corrupt-result'`,
      'not-json'
    );

    await expect(
      durability.double.getResult('corrupt-result')
    ).rejects.toBeInstanceOf(DurableResultValidationError);
    await expect(
      durability.double.getResult('corrupt-result')
    ).rejects.toBeInstanceOf(DurableResultValidationError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('validates payload version unions', async () => {
    type VersionedPayload =
      | { version: '1'; legacy: string }
      | { version: '2'; value: number };
    const handler = vi.fn(async ({ payload }: DurableCall<VersionedPayload>) =>
      payload.version === '1' ? payload.legacy.length : payload.value
    );
    const durability = createDurability(
      contextFor(new FakeStorage()),
      { versioned: handler },
      {
        methods: {
          versioned: {
            payloadSchema: z.discriminatedUnion('version', [
              z.object({ version: z.literal('1'), legacy: z.string() }),
              z.object({ version: z.literal('2'), value: z.number() }),
            ]),
            resultSchema: z.number(),
            payloadVersion: '2',
            acceptedPayloadVersions: ['1'],
          },
        },
      }
    );

    await durability.versioned({
      id: 'version:1',
      payload: { version: '1', legacy: 'old' },
      payloadVersion: '1',
    });
    await durability.versioned({
      id: 'version:2',
      payload: { version: '2', value: 2 },
    });

    await vi.waitFor(async () => {
      await expect(
        durability.versioned.getResult('version:1')
      ).resolves.toMatchObject({ status: 'completed', result: 3 });
      await expect(
        durability.versioned.getResult('version:2')
      ).resolves.toMatchObject({ status: 'completed', result: 2 });
    });
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
      {
        retries: { delay: () => 1_000 },
        methods: {
          deliver: {
            payloadSchema: z.object({ value: z.string() }),
            resultSchema: z.string(),
          },
        },
      }
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
      {
        retries: { delay: () => 1_000 },
        methods: {
          send: {
            payloadSchema: z.object({ message: z.string() }),
            resultSchema: z.never(),
          },
        },
      }
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
      {
        retries: { delay: () => 1_000 },
        methods: {
          send: {
            payloadSchema: z.object({ message: z.string() }),
            resultSchema: z.string(),
          },
        },
      }
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
      {
        alarmConcurrency: 2,
        methods: {
          work: {
            payloadSchema: z.undefined(),
            resultSchema: z.undefined(),
          },
        },
      }
    );

    for (let index = 0; index < 101; index += 1) {
      storage.sql.exec(
        `INSERT INTO durability_calls
          (id, operation, payload, status, attempt, next_attempt_at)
          VALUES (?, 'work', ?, 'pending', 0, 0)`,
        `alarm:${index}`,
        JSON.stringify({ kind: 'undefined' })
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
      {
        retries: { delay: () => 1_000 },
        methods: {
          wait: { payloadSchema: z.null(), resultSchema: z.never() },
        },
      }
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
      {
        alarmHandoffMs: 10_000,
        methods: {
          wait: { payloadSchema: z.null(), resultSchema: z.string() },
        },
      }
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
      operationVersion: '1',
      payloadVersion: '1',
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
        methods: {
          retryable: { payloadSchema: z.null(), resultSchema: z.never() },
          terminal: {
            payloadSchema: z.null(),
            resultSchema: z.never(),
            retries: { maxAttempts: 1 },
          },
        },
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
        operationVersion: '1',
        payloadVersion: '1',
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
          timeout: {
            payloadSchema: z.null(),
            resultSchema: z.undefined(),
            attemptTimeoutMs: 100,
            retries: { maxAttempts: 5 },
          },
          rejected: { payloadSchema: z.null(), resultSchema: z.never() },
          workflowRejected: {
            payloadSchema: z.null(),
            resultSchema: z.never(),
          },
        },
      }
    );

    await durability.timeout({ id: 'timeout:1', payload: null });
    await vi.advanceTimersByTimeAsync(100);
    expect(timeoutSignal?.aborted).toBe(true);
    await expect(durability.timeout.getResult('timeout:1')).resolves.toEqual({
      status: 'failed',
      attempt: 1,
      operationVersion: '1',
      payloadVersion: '1',
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
        operationVersion: '1',
        payloadVersion: '1',
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

  it('requires schemas matching every operation handler', () => {
    const storage = new FakeStorage();
    const handlers = {
      double: async ({ payload }: DurableCall<{ value: number }>) =>
        payload.value * 2,
    };
    const durability = createDurability(contextFor(storage), handlers, {
      methods: {
        double: {
          payloadSchema: z.object({ value: z.number() }),
          resultSchema: z.number(),
        },
      },
    });
    expectTypeOf(durability.double).toBeCallableWith({
      id: 'double:1',
      payload: { value: 1 },
    });

    const assertInvalidTypes = () => {
      // @ts-expect-error non-empty handler maps require methods
      createDurability(contextFor(storage), handlers);
      createDurability(contextFor(storage), handlers, {
        methods: {
          double: {
            // @ts-expect-error payload schema output must match handler payload
            payloadSchema: z.string(),
            resultSchema: z.number(),
          },
        },
      });
      createDurability(contextFor(storage), handlers, {
        methods: {
          double: {
            payloadSchema: z.object({ value: z.number() }),
            // @ts-expect-error result schema output must match awaited result
            resultSchema: z.string(),
          },
        },
      });
    };
    expectTypeOf(assertInvalidTypes).toBeFunction();
  });

  it('infers scheduling methods and policies from named alarm handlers', () => {
    const storage = new FakeStorage();
    const durability = createDurability(
      contextFor(storage),
      {},
      { alarms: { cleanup: async () => undefined } }
    );

    expectTypeOf(durability.alarm.cleanup).toBeCallableWith(Date.now());
    expectTypeOf(durability.alarm.cleanup.cancel).toBeFunction();

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
      handlerVersion: '1',
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

  it('makes timed-out named alarms terminal by default', async () => {
    vi.useFakeTimers();
    const storage = new FakeStorage();
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cleanup = vi.fn(async () => pending);
    const durability = createDurability(
      contextFor(storage),
      {},
      {
        alarms: { cleanup },
        alarmMethods: {
          cleanup: {
            attemptTimeoutMs: 100,
            retries: { delay: () => 0, maxAttempts: 5 },
          },
        },
      }
    );

    await durability.alarm.cleanup(Date.now());
    storage.alarmAt = null;
    const invocation = durability.alarm();
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
    await durability.alarm();
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
            retryTimeouts: true,
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
        methods: {
          work: { payloadSchema: z.null(), resultSchema: z.never() },
        },
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
    const durability = createDurability(
      contextFor(storage),
      {
        first: async (_call: DurableCall<null>) => 'first',
        second: async (_call: DurableCall<null>) => 'second',
      },
      {
        methods: {
          first: { payloadSchema: z.null(), resultSchema: z.string() },
          second: { payloadSchema: z.null(), resultSchema: z.string() },
        },
      }
    );

    await durability.first({ id: 'shared', payload: null });

    await expect(
      durability.second({ id: 'shared', payload: null })
    ).rejects.toBeInstanceOf(DuplicateDurableCallError);
  });

  it('retains an operation lock and permit until a timed-out handler settles', async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const attempts: number[] = [];
    let invocation = 0;
    const handler = vi.fn(async ({ attempt }: DurableCall<null>) => {
      invocation += 1;
      attempts.push(attempt);
      if (invocation === 1) {
        await first;
      }
    });
    const storage = new FakeStorage();
    const durability = createDurability(
      contextFor(storage),
      {
        work: handler,
        other: async (_call: DurableCall<null>) => undefined,
      },
      {
        alarmConcurrency: 1,
        alarmHandoffMs: 150,
        methods: {
          work: {
            payloadSchema: z.null(),
            resultSchema: z.undefined(),
            attemptTimeoutMs: 100,
            retries: { delay: () => 0, maxAttempts: 2 },
            retryTimeouts: true,
          },
          other: { payloadSchema: z.null(), resultSchema: z.undefined() },
        },
      }
    );

    await durability.work({ id: 'work:timeout', payload: null });
    await vi.advanceTimersByTimeAsync(100);
    const other = durability.other({ id: 'other:1', payload: null });
    await other;
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(durability.other.getResult('other:1')).resolves.toMatchObject({
      status: 'pending',
      attempt: 0,
    });

    const blocked = durability.alarm();
    await vi.advanceTimersByTimeAsync(150);
    await blocked;
    expect(handler).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    storage.alarmAt = null;
    await durability.alarm();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([1, 2]);
    await expect(durability.other.getResult('other:1')).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('claims attempts conditionally and never invokes exhausted records', async () => {
    const storage = new FakeStorage();
    const operation = vi.fn(async (_call: DurableCall<undefined>) => undefined);
    const named = vi.fn(async () => undefined);
    const terminalEvents: Array<{ entityKind: string; reason: string }> = [];
    const durability = createDurability(
      contextFor(storage),
      { work: operation },
      {
        alarms: { cleanup: named },
        retries: { maxAttempts: 2 },
        methods: {
          work: {
            payloadSchema: z.undefined(),
            resultSchema: z.undefined(),
          },
        },
        onLifecycleEvent: (event) => {
          if (event.type === 'terminal') {
            terminalEvents.push(event);
          }
        },
      }
    );
    storage.sql.exec(
      `INSERT INTO durability_calls
        (id, operation, payload, status, attempt, next_attempt_at)
       VALUES ('exhausted', 'work', ?, 'pending', 2, 0)`,
      JSON.stringify({ kind: 'value', value: null })
    );
    storage.sql.exec(
      `INSERT INTO durability_alarms
        (name, generation_id, status, scheduled_at, next_attempt_at, attempt)
       VALUES ('cleanup', 'exhausted-alarm', 'pending', 0, 0, 2)`
    );

    await durability.alarm();

    expect(operation).not.toHaveBeenCalled();
    expect(named).not.toHaveBeenCalled();
    await expect(durability.work.getResult('exhausted')).resolves.toMatchObject(
      {
        status: 'failed',
        attempt: 2,
        error: { name: 'DurableAttemptsExhaustedError' },
      }
    );
    expect(
      storage.sql
        .exec<{ last_error_name: string; status: string }>(
          `SELECT status, last_error_name FROM durability_alarms
           WHERE name = 'cleanup'`
        )
        .toArray()
    ).toEqual([
      { status: 'failed', last_error_name: 'DurableAttemptsExhaustedError' },
    ]);
    expect(terminalEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityKind: 'operation',
          reason: 'attempts_exhausted',
        }),
        expect.objectContaining({
          entityKind: 'named_alarm',
          reason: 'attempts_exhausted',
        }),
      ])
    );
  });

  it('makes invalid retry policies and unserializable results terminal', async () => {
    const storage = new FakeStorage();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const handlers = {
      throwingDelay: vi.fn(async (_call: DurableCall<undefined>) => {
        throw new Error('retry');
      }),
      infiniteDelay: vi.fn(async (_call: DurableCall<undefined>) => {
        throw new Error('retry');
      }),
      negativeDelay: vi.fn(async (_call: DurableCall<undefined>) => {
        throw new Error('retry');
      }),
      bigint: vi.fn(async (_call: DurableCall<undefined>) => 1n),
      circular: vi.fn(async (_call: DurableCall<undefined>) => circular),
    };
    const durability = createDurability(contextFor(storage), handlers, {
      methods: {
        throwingDelay: {
          payloadSchema: z.undefined(),
          resultSchema: z.never(),
          retries: {
            delay: () => {
              throw new Error('policy');
            },
          },
        },
        infiniteDelay: {
          payloadSchema: z.undefined(),
          resultSchema: z.never(),
          retries: { delay: () => Number.POSITIVE_INFINITY },
        },
        negativeDelay: {
          payloadSchema: z.undefined(),
          resultSchema: z.never(),
          retries: { delay: () => -1 },
        },
        bigint: { payloadSchema: z.undefined(), resultSchema: z.bigint() },
        circular: {
          payloadSchema: z.undefined(),
          resultSchema: z.object({ self: z.unknown().optional() }),
        },
      },
    });

    await Promise.all([
      durability.throwingDelay({ id: 'delay:throw', payload: undefined }),
      durability.infiniteDelay({ id: 'delay:infinite', payload: undefined }),
      durability.negativeDelay({ id: 'delay:negative', payload: undefined }),
      durability.bigint({ id: 'result:bigint', payload: undefined }),
      durability.circular({ id: 'result:circular', payload: undefined }),
    ]);

    await vi.waitFor(async () => {
      await expect(
        durability.throwingDelay.getResult('delay:throw')
      ).resolves.toMatchObject({
        status: 'failed',
        error: { name: 'DurableRetryPolicyError' },
      });
      await expect(
        durability.infiniteDelay.getResult('delay:infinite')
      ).resolves.toMatchObject({
        status: 'failed',
        error: { name: 'DurableRetryPolicyError' },
      });
      await expect(
        durability.negativeDelay.getResult('delay:negative')
      ).resolves.toMatchObject({
        status: 'failed',
        error: { name: 'DurableRetryPolicyError' },
      });
      await expect(
        durability.bigint.getResult('result:bigint')
      ).resolves.toMatchObject({
        status: 'failed',
        error: { name: 'DurableResultSerializationError' },
      });
      await expect(
        durability.circular.getResult('result:circular')
      ).resolves.toMatchObject({
        status: 'failed',
        error: { name: 'DurableResultSerializationError' },
      });
    });
    expect(handlers.bigint).toHaveBeenCalledTimes(1);
    expect(handlers.circular).toHaveBeenCalledTimes(1);
  });

  it('makes unsafe retry delays terminal for operations and named alarms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1);
    const storage = new FakeStorage();
    const fail = async (_call: DurableCall<undefined>) => {
      throw new Error('retry');
    };
    const failAlarm = async () => {
      throw new Error('retry');
    };
    const durability = createDurability(
      contextFor(storage),
      { maxDelay: fail, overflowDelay: fail },
      {
        methods: {
          maxDelay: {
            payloadSchema: z.undefined(),
            resultSchema: z.never(),
            retries: { delay: () => Number.MAX_SAFE_INTEGER },
          },
          overflowDelay: {
            payloadSchema: z.undefined(),
            resultSchema: z.never(),
            retries: { delay: () => Number.MAX_SAFE_INTEGER + 1 },
          },
        },
        alarms: { maxAlarm: failAlarm, overflowAlarm: failAlarm },
        alarmMethods: {
          maxAlarm: { retries: { delay: () => Number.MAX_SAFE_INTEGER } },
          overflowAlarm: {
            retries: { delay: () => Number.MAX_SAFE_INTEGER + 1 },
          },
        },
      }
    );

    await Promise.all([
      durability.maxDelay({ id: 'max-delay', payload: undefined }),
      durability.overflowDelay({ id: 'overflow-delay', payload: undefined }),
      durability.alarm.maxAlarm(Date.now()),
      durability.alarm.overflowAlarm(Date.now()),
    ]);
    storage.alarmAt = null;
    await durability.alarm();

    await expect(
      durability.maxDelay.getResult('max-delay')
    ).resolves.toMatchObject({
      status: 'failed',
      error: { name: 'DurableRetryPolicyError' },
    });
    await expect(
      durability.overflowDelay.getResult('overflow-delay')
    ).resolves.toMatchObject({
      status: 'failed',
      error: { name: 'DurableRetryPolicyError' },
    });
    expect(
      storage.sql
        .exec<{ last_error_name: string }>(
          'SELECT last_error_name FROM durability_alarms ORDER BY name'
        )
        .toArray()
    ).toEqual([
      { last_error_name: 'DurableRetryPolicyError' },
      { last_error_name: 'DurableRetryPolicyError' },
    ]);
  });

  it('settles arbitrary null-prototype and hostile proxy throwables', async () => {
    const storage = new FakeStorage();
    const nullPrototype: unknown = Object.create(null);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('get trap');
        },
        getPrototypeOf() {
          throw new Error('prototype trap');
        },
      }
    );
    const throwNull = async (_call: DurableCall<undefined>) => {
      throw nullPrototype;
    };
    const throwProxy = async (_call: DurableCall<undefined>) => {
      throw hostile;
    };
    const durability = createDurability(
      contextFor(storage),
      { nullOperation: throwNull, proxyOperation: throwProxy },
      {
        methods: {
          nullOperation: {
            payloadSchema: z.undefined(),
            resultSchema: z.never(),
            retries: { maxAttempts: 1 },
          },
          proxyOperation: {
            payloadSchema: z.undefined(),
            resultSchema: z.never(),
            retries: { maxAttempts: 1 },
          },
        },
        alarms: {
          nullAlarm: async () => {
            throw nullPrototype;
          },
          proxyAlarm: async () => {
            throw hostile;
          },
        },
        alarmMethods: {
          nullAlarm: { retries: { maxAttempts: 1 } },
          proxyAlarm: { retries: { maxAttempts: 1 } },
        },
      }
    );

    await Promise.all([
      durability.nullOperation({ id: 'null-throw', payload: undefined }),
      durability.proxyOperation({ id: 'proxy-throw', payload: undefined }),
      durability.alarm.nullAlarm(Date.now()),
      durability.alarm.proxyAlarm(Date.now()),
    ]);
    storage.alarmAt = null;
    await durability.alarm();

    await Promise.all(
      (
        [
          [durability.nullOperation, 'null-throw'],
          [durability.proxyOperation, 'proxy-throw'],
        ] as const
      ).map(async ([operation, id]) => {
        await expect(operation.getResult(id)).resolves.toMatchObject({
          status: 'failed',
          error: { name: 'Error', message: 'Unknown thrown value' },
        });
      })
    );
    expect(
      storage.sql
        .exec<{ last_error: string; last_error_name: string }>(
          `SELECT last_error, last_error_name
           FROM durability_alarms ORDER BY name`
        )
        .toArray()
    ).toEqual([
      { last_error: 'Unknown thrown value', last_error_name: 'Error' },
      { last_error: 'Unknown thrown value', last_error_name: 'Error' },
    ]);
  });

  it('cancels, retries, deletes, and safely reuses operation IDs', async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let firstSignal: AbortSignal | undefined;
    let invocation = 0;
    const handler = vi.fn(async ({ signal }: DurableCall<null>) => {
      invocation += 1;
      if (invocation === 1) {
        firstSignal = signal;
        await pending;
      }
      return invocation;
    });
    const storage = new FakeStorage();
    const durability = createDurability(
      contextFor(storage),
      { work: handler },
      {
        methods: {
          work: { payloadSchema: z.null(), resultSchema: z.number() },
        },
      }
    );

    await durability.work({ id: 'admin:1', payload: null });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await expect(durability.work.cancel('admin:1')).resolves.toEqual({
      status: 'updated',
    });
    expect(firstSignal?.aborted).toBe(true);
    await expect(durability.work.getResult('admin:1')).resolves.toMatchObject({
      status: 'cancelled',
      error: { name: 'DurableCancellationError' },
    });
    await expect(durability.work.retry('admin:1')).resolves.toEqual({
      status: 'unchanged',
    });

    finish?.();
    await pending;
    await vi.waitFor(async () => {
      await expect(durability.work.retry('admin:1')).resolves.toEqual({
        status: 'updated',
      });
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      await expect(durability.work.getResult('admin:1')).resolves.toMatchObject(
        {
          status: 'completed',
          result: 2,
        }
      );
    });
    await expect(durability.work.delete('admin:1')).resolves.toEqual({
      status: 'deleted',
    });
    await expect(durability.work.getResult('admin:1')).resolves.toEqual({
      status: 'not_found',
    });
    await durability.work({ id: 'admin:1', payload: null });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
  });

  it('prevents late deleted generations from changing a reused operation ID', async () => {
    let finishOld: (() => void) | undefined;
    const oldPending = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    let invocation = 0;
    const handler = vi.fn(
      async ({ payload }: DurableCall<{ value: string }>) => {
        invocation += 1;
        if (invocation === 1) {
          await oldPending;
          throw new Error('obsolete failure');
        }
        return payload.value;
      }
    );
    const storage = new FakeStorage();
    const durability = createDurability(
      contextFor(storage),
      { work: handler },
      {
        methods: {
          work: {
            payloadSchema: z.object({ value: z.string() }),
            resultSchema: z.string(),
          },
        },
      }
    );

    await durability.work({ id: 'reused', payload: { value: 'old' } });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await expect(durability.work.delete('reused')).resolves.toEqual({
      status: 'deleted',
    });
    await durability.work({ id: 'reused', payload: { value: 'new' } });
    await expect(durability.work.getResult('reused')).resolves.toMatchObject({
      status: 'pending',
      attempt: 0,
    });

    finishOld?.();
    await oldPending;
    await vi.waitFor(async () => {
      storage.alarmAt = null;
      await durability.alarm();
      await expect(durability.work.getResult('reused')).resolves.toMatchObject({
        status: 'completed',
        result: 'new',
      });
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('supports named alarm administrative methods', async () => {
    const storage = new FakeStorage();
    const durability = createDurability(
      contextFor(storage),
      {},
      { alarms: { cleanup: async () => undefined } }
    );

    await expect(durability.alarm.cleanup.cancel()).resolves.toEqual({
      status: 'not_found',
    });
    await durability.alarm.cleanup(Date.now() + 60_000);
    await expect(durability.alarm.cleanup.cancel()).resolves.toEqual({
      status: 'updated',
    });
    await expect(durability.alarm.cleanup.retry()).resolves.toEqual({
      status: 'updated',
    });
    await expect(durability.alarm.cleanup.delete()).resolves.toEqual({
      status: 'deleted',
    });
  });

  it('purges all old queue records with an exclusive cutoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const storage = new FakeStorage();
    const durability = createDurability(
      contextFor(storage),
      { work: async ({ id }: DurableCall<null>) => id },
      {
        alarms: {
          oldAlarm: async () => undefined,
          retainedAlarm: async () => undefined,
        },
        methods: {
          work: { payloadSchema: z.null(), resultSchema: z.string() },
        },
      }
    );
    await durability.work({ id: 'old', payload: null });
    await durability.alarm.oldAlarm(10_000);
    vi.setSystemTime(1_001);
    await durability.work({ id: 'retained', payload: null });
    await durability.alarm.retainedAlarm(10_000);

    await expect(durability.purgeBefore(1_001)).resolves.toEqual({
      operations: 1,
      namedAlarms: 1,
      total: 2,
    });
    await expect(durability.work.getResult('old')).resolves.toEqual({
      status: 'not_found',
    });
    await expect(durability.work.getResult('retained')).resolves.toMatchObject({
      status: 'completed',
    });
    expect(
      storage.sql
        .exec<{ name: string }>('SELECT name FROM durability_alarms')
        .toArray()
    ).toEqual([{ name: 'retainedAlarm' }]);
    await expect(durability.purgeBefore(-1)).rejects.toBeInstanceOf(RangeError);
  });

  it('purges large queues with aggregate counts and no ID materialization', async () => {
    const storage = new FakeStorage();
    const durability = createDurability(contextFor(storage), {});
    storage.sql.exec(
      `WITH RECURSIVE sequence(value) AS (
         VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 2000
       )
       INSERT INTO durability_calls (
         id, operation, payload, status, next_attempt_at, created_at,
         generation_id, operation_version, payload_version
       )
       SELECT 'call:' || value, 'bulk', ?, 'pending', 10, 1,
         'call-generation:' || value, '1', '1'
       FROM sequence`,
      JSON.stringify({ kind: 'value', value: null })
    );
    storage.sql.exec(
      `WITH RECURSIVE sequence(value) AS (
         VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 2000
       )
       INSERT INTO durability_alarms (
         name, generation_id, status, scheduled_at, next_attempt_at, created_at,
         handler_version
       )
       SELECT 'alarm:' || value, 'alarm-generation:' || value, 'pending',
         10, 10, 1, '1'
       FROM sequence`
    );
    const exec = vi.spyOn(storage.sql, 'exec');

    await expect(durability.purgeBefore(2)).resolves.toEqual({
      operations: 2000,
      namedAlarms: 2000,
      total: 4000,
    });

    const queries = exec.mock.calls.map(([query]) => query);
    expect(queries).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/SELECT\s+(?:id|name),\s*generation_id/i),
      ])
    );
    expect(queries).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/DELETE[^;]+RETURNING/i)])
    );
  });

  it('parses handler and policy option entries at runtime', () => {
    const storage = new FakeStorage();
    expect(() =>
      createDurability(
        contextFor(storage),
        { work: async (_call: DurableCall<undefined>) => undefined },
        {
          methods: {
            // @ts-expect-error verifies malformed method options at runtime
            work: 'invalid',
          },
        }
      )
    ).toThrow(/expected object/i);
    expect(() =>
      createDurability(
        contextFor(new FakeStorage()),
        {},
        {
          alarms: { cleanup: async () => undefined },
          alarmMethods: {
            cleanup: {
              // @ts-expect-error verifies malformed alarm options at runtime
              retryTimeouts: 'yes',
            },
          },
        }
      )
    ).toThrow(/expected boolean/i);
    expect(() =>
      createDurability(
        contextFor(new FakeStorage()),
        {
          // @ts-expect-error verifies malformed handlers at runtime
          work: 'invalid',
        },
        {
          methods: {
            work: {
              payloadSchema: z.undefined(),
              resultSchema: z.undefined(),
            },
          },
        }
      )
    ).toThrow(/invalid input/i);
  });

  it('parses the global retry policy at construction', () => {
    expect(() =>
      createDurability(
        contextFor(new FakeStorage()),
        {},
        {
          retries: {
            // @ts-expect-error verifies malformed global policy at runtime
            maxAttempts: 'many',
          },
        }
      )
    ).toThrow(/expected number/i);
  });

  it('validates current and accepted version strings', async () => {
    const storage = new FakeStorage();
    expect(() =>
      createDurability(
        contextFor(storage),
        { work: async (_call: DurableCall<null>) => undefined },
        {
          methods: {
            work: {
              payloadSchema: z.null(),
              resultSchema: z.undefined(),
              operationVersion: '2',
              acceptedOperationVersions: ['2'],
            },
          },
        }
      )
    ).toThrow('must contain unique versions');

    const durability = createDurability(
      contextFor(new FakeStorage()),
      { work: async (_call: DurableCall<null>) => undefined },
      {
        methods: {
          work: { payloadSchema: z.null(), resultSchema: z.undefined() },
        },
      }
    );
    await expect(
      durability.work({
        id: 'empty-version',
        payload: null,
        operationVersion: '',
      })
    ).rejects.toThrow('must be a non-empty string');
  });

  it('accepts declared versions and fails incompatible pending records', async () => {
    const storage = new FakeStorage();
    const terminalEvents: string[] = [];
    const handler = vi.fn(
      async ({ operationVersion, payloadVersion }: DurableCall<null>) => ({
        operationVersion,
        payloadVersion,
      })
    );
    const durability = createDurability(
      contextFor(storage),
      { work: handler },
      {
        methods: {
          work: {
            payloadSchema: z.null(),
            resultSchema: z.object({
              operationVersion: z.string(),
              payloadVersion: z.string(),
            }),
            operationVersion: '2',
            payloadVersion: '2',
            acceptedOperationVersions: ['1'],
            acceptedPayloadVersions: ['1'],
          },
        },
        onLifecycleEvent: (event) => {
          if (event.type === 'terminal') {
            terminalEvents.push(event.reason);
          }
        },
      }
    );

    await durability.work({
      id: 'accepted',
      payload: null,
      operationVersion: '1',
      payloadVersion: '1',
    });
    await durability.work({
      id: 'mismatch',
      payload: null,
      operationVersion: '0',
      payloadVersion: '1',
    });

    await vi.waitFor(async () => {
      await expect(
        durability.work.getResult('accepted')
      ).resolves.toMatchObject({
        status: 'completed',
        operationVersion: '1',
        payloadVersion: '1',
      });
      await expect(
        durability.work.getResult('mismatch')
      ).resolves.toMatchObject({
        status: 'failed',
        error: { name: 'DurableVersionMismatchError' },
      });
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(terminalEvents).toContain('version_mismatch');
  });

  it('reports lifecycle hook failures and uses waitUntil when available', async () => {
    const errorLog = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const syncStorage = new FakeStorage();
    const sync = createDurability(
      contextFor(syncStorage),
      { work: async () => 'done' },
      {
        methods: {
          work: { payloadSchema: z.undefined(), resultSchema: z.string() },
        },
        onLifecycleEvent: () => {
          throw new Error('metrics unavailable');
        },
      }
    );
    await sync.work({ id: 'sync-hook', payload: undefined });
    await vi.waitFor(async () => {
      await expect(sync.work.getResult('sync-hook')).resolves.toMatchObject({
        status: 'completed',
      });
    });

    const asyncStorage = new FakeStorage();
    const events: string[] = [];
    const pendingHooks: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      pendingHooks.push(promise);
    });
    const asyncHook = createDurability(
      { ...contextFor(asyncStorage), waitUntil },
      { work: async () => 'done' },
      {
        methods: {
          work: { payloadSchema: z.undefined(), resultSchema: z.string() },
        },
        onLifecycleEvent: async (event) => {
          events.push(event.type);
          throw new Error('metrics rejected');
        },
      }
    );
    await asyncHook.work({ id: 'async-hook', payload: undefined });
    await vi.waitFor(async () => {
      await expect(
        asyncHook.work.getResult('async-hook')
      ).resolves.toMatchObject({
        status: 'completed',
      });
    });
    await Promise.all(pendingHooks);
    expect(events).toEqual(
      expect.arrayContaining([
        'registered',
        'attempt_started',
        'attempt_settled',
      ])
    );
    expect(waitUntil).toHaveBeenCalledTimes(events.length + 1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'durability.lifecycle_hook.failed',
        entityId: expect.any(String),
        entityKind: 'operation',
        lifecycleType: expect.any(String),
        error: {
          name: 'Error',
          message: expect.any(String),
          stack: expect.any(String),
        },
      })
    );
  });

  it('attaches eager background failures to waitUntil and logs them', async () => {
    const storage = new FakeStorage();
    storage.transactionFailureAt = 2;
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      pending.push(promise);
    });
    const errorLog = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const durability = createDurability(
      { ...contextFor(storage), waitUntil },
      {
        work: async (_call: DurableCall<undefined>) => 'done',
      },
      {
        methods: {
          work: { payloadSchema: z.undefined(), resultSchema: z.string() },
        },
      }
    );

    await durability.work({ id: 'background:eager', payload: undefined });
    await vi.waitFor(() => expect(waitUntil).toHaveBeenCalledTimes(1));
    await expect(Promise.all(pending)).rejects.toThrow(
      'unexpected storage failure'
    );
    await expect(
      durability.work.getResult('background:eager')
    ).resolves.toMatchObject({ status: 'completed', result: 'done' });
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'durability.background_execution.failed',
        operation: 'work',
        id: 'background:eager',
        name: 'work',
        error: {
          name: 'Error',
          message: 'unexpected storage failure',
          stack: expect.any(String),
        },
      })
    );
  });

  it('attaches administrative retry execution to waitUntil', async () => {
    const storage = new FakeStorage();
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      pending.push(promise);
    });
    let fail = true;
    const durability = createDurability(
      { ...contextFor(storage), waitUntil },
      {
        work: async (_call: DurableCall<undefined>) => {
          if (fail) {
            throw new DurabilityNonRetryableError('first failure');
          }
          return 'done';
        },
      },
      {
        methods: {
          work: { payloadSchema: z.undefined(), resultSchema: z.string() },
        },
      }
    );
    await durability.work({ id: 'background:retry', payload: undefined });
    await vi.waitFor(async () => {
      await expect(
        durability.work.getResult('background:retry')
      ).resolves.toMatchObject({ status: 'failed' });
    });
    await Promise.all(pending);
    pending.length = 0;
    waitUntil.mockClear();
    fail = false;

    await expect(durability.work.retry('background:retry')).resolves.toEqual({
      status: 'updated',
    });
    await vi.waitFor(() => expect(waitUntil).toHaveBeenCalledTimes(1));
    await Promise.all(pending);
    await expect(
      durability.work.getResult('background:retry')
    ).resolves.toMatchObject({ status: 'completed', result: 'done' });
  });

  it('logs alarm execution failures while preserving alarm rejection', async () => {
    const storage = new FakeStorage();
    const errorLog = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const handler = vi.fn(async (_call: DurableCall<undefined>) => {
      throw new Error('handler failure');
    });
    const durability = createDurability(
      contextFor(storage),
      { work: handler },
      {
        methods: {
          work: {
            payloadSchema: z.undefined(),
            resultSchema: z.never(),
            retries: { maxAttempts: 2 },
          },
        },
      }
    );
    storage.sql.exec(
      `INSERT INTO durability_calls
        (id, operation, payload, status, attempt, next_attempt_at)
       VALUES ('background:alarm', 'work', ?, 'pending', 0, 0)`,
      JSON.stringify({ kind: 'undefined' })
    );
    storage.transactionFailureAt = storage.transactionCount + 1;

    await expect(durability.alarm()).rejects.toThrow(
      'unexpected storage failure'
    );

    expect(handler).toHaveBeenCalledTimes(1);
    await expect(
      durability.work.getResult('background:alarm')
    ).resolves.toMatchObject({ status: 'pending', attempt: 1 });
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'durability.background_execution.failed',
        operation: 'work',
        id: 'background:alarm',
        name: 'work',
        error: {
          name: 'Error',
          message: 'unexpected storage failure',
          stack: expect.any(String),
        },
      })
    );
  });

  it('makes named alarm retry policy failures terminal and reconciles state', async () => {
    const storage = new FakeStorage();
    const durability = createDurability(
      contextFor(storage),
      {},
      {
        alarms: {
          throwing: async () => {
            throw new Error('retry');
          },
          nonFinite: async () => {
            throw new Error('retry');
          },
        },
        alarmMethods: {
          throwing: {
            retries: {
              delay: () => {
                throw new Error('policy');
              },
            },
          },
          nonFinite: {
            retries: { delay: () => Number.NaN },
          },
        },
      }
    );

    await durability.alarm.throwing(Date.now());
    await durability.alarm.nonFinite(Date.now());
    storage.alarmAt = null;
    await durability.alarm();

    expect(
      storage.sql
        .exec<{ last_error_name: string; status: string }>(
          'SELECT status, last_error_name FROM durability_alarms ORDER BY name'
        )
        .toArray()
    ).toEqual([
      { status: 'failed', last_error_name: 'DurableRetryPolicyError' },
      { status: 'failed', last_error_name: 'DurableRetryPolicyError' },
    ]);
    expect(storage.alarmAt).toBeNull();
  });

  it('rejects an incompatible persisted named alarm version before invocation', async () => {
    const storage = new FakeStorage();
    const initial = createDurability(
      contextFor(storage),
      {},
      {
        alarms: { cleanup: async () => undefined },
        alarmMethods: { cleanup: { handlerVersion: '1' } },
      }
    );
    await initial.alarm.cleanup(Date.now());

    const handler = vi.fn(async () => undefined);
    const recovered = createDurability(
      contextFor(storage),
      {},
      {
        alarms: { cleanup: handler },
        alarmMethods: { cleanup: { handlerVersion: '2' } },
      }
    );
    storage.alarmAt = null;
    await recovered.alarm();

    expect(handler).not.toHaveBeenCalled();
    expect(
      storage.sql
        .exec<{ last_error_name: string; status: string }>(
          `SELECT status, last_error_name FROM durability_alarms
           WHERE name = 'cleanup'`
        )
        .toArray()
    ).toEqual([
      { status: 'failed', last_error_name: 'DurableVersionMismatchError' },
    ]);
  });

  it('deduplicates concurrent same-ID registrations without leaking SQL errors', async () => {
    const storage = new FakeStorage();
    const handler = vi.fn(async () => 'done');
    const durability = createDurability(
      contextFor(storage),
      { work: handler },
      {
        methods: {
          work: { payloadSchema: z.undefined(), resultSchema: z.string() },
        },
      }
    );

    await expect(
      Promise.all([
        durability.work({ id: 'concurrent', payload: undefined }),
        durability.work({ id: 'concurrent', payload: undefined }),
      ])
    ).resolves.toEqual([undefined, undefined]);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });
});
