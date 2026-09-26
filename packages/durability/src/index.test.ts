import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  Durability,
  DurabilityAlarms,
  DurabilityScheduler,
  durabilityNamedAlarmMigrations,
  durabilityOperationMigrations,
  DuplicateDurableCallError,
  DurableAttemptsExhaustedError,
  DurableResultSerializationError,
  DurableRetryPolicyError,
  NonRetryableError as DurabilityNonRetryableError,
  type DurableCall,
  type DurabilityLifecycleEvent,
} from './index';
import { migrate } from './migrations';
import {
  contextFor,
  contextForKv,
  FakeKvStorage,
  FakeStorage,
} from './test-fakes';
import { exponential, jitter } from './utils';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const tableNames = (storage: FakeStorage): string[] =>
  storage.sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .toArray()
    .map(({ name }) => name);

describe('migrations', () => {
  it('migrates each capability up and down independently', () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);

    expect(Durability.migrate(context)).toEqual({
      applied: [
        'durability_0001_create_calls',
        'durability_0002_pending_index',
        'durability_0004_calls_generation_and_created_at',
      ],
      rolledBack: [],
    });
    expect(tableNames(storage)).toEqual([
      'durability_calls',
      'durability_migrations',
    ]);

    expect(DurabilityAlarms.migrate(context)).toEqual({
      applied: [
        'durability_0003_create_alarms',
        'durability_0004_alarms_generation_and_created_at',
      ],
      rolledBack: [],
    });
    expect(Durability.migrate(context, 'durability_0001_create_calls')).toEqual(
      {
        applied: [],
        rolledBack: [
          'durability_0004_calls_generation_and_created_at',
          'durability_0002_pending_index',
        ],
      }
    );
    expect(Durability.migrate(context, null)).toEqual({
      applied: [],
      rolledBack: ['durability_0001_create_calls'],
    });
    expect(tableNames(storage)).toEqual([
      'durability_alarms',
      'durability_migrations',
    ]);

    expect(DurabilityAlarms.migrate(context, null)).toEqual({
      applied: [],
      rolledBack: [
        'durability_0004_alarms_generation_and_created_at',
        'durability_0003_create_alarms',
      ],
    });
    expect(tableNames(storage)).toEqual([]);
  });

  it('only creates the tables for the constructed helpers', () => {
    const operationsOnly = new FakeStorage();
    void new Durability({
      context: contextFor(operationsOnly),
      handlers: {
        work: async () => undefined,
      },
    });
    expect(tableNames(operationsOnly)).toEqual([
      'durability_calls',
      'durability_migrations',
    ]);

    const alarmsOnly = new FakeStorage();
    void new DurabilityAlarms({
      context: contextFor(alarmsOnly),
      handlers: {
        cleanup: async () => undefined,
      },
    });
    expect(tableNames(alarmsOnly)).toEqual([
      'durability_alarms',
      'durability_migrations',
    ]);
  });

  it('stamps legacy rows during migration and removes v4 columns on rollback', () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    Durability.migrate(context, 'durability_0002_pending_index');
    storage.sql.exec(
      `INSERT INTO durability_calls
        (id, operation, payload, status, attempt, next_attempt_at)
       VALUES ('legacy', 'work', '{"kind":"value","value":null}', 'pending', 0, 0)`
    );

    Durability.migrate(context);
    const migrated = storage.sql
      .exec<{ created_at: number; generation_id: string }>(
        'SELECT created_at, generation_id FROM durability_calls WHERE id = ?',
        'legacy'
      )
      .toArray()[0];
    expect(migrated?.created_at).toBeGreaterThan(0);
    expect(migrated?.generation_id).toBe('legacy:legacy');

    Durability.migrate(context, 'durability_0002_pending_index');
    expect(
      storage.sql
        .exec<{ name: string }>('PRAGMA table_info(durability_calls)')
        .toArray()
        .map(({ name }) => name)
    ).not.toContain('generation_id');
  });

  it('upgrades a v2 database in place without touching records', async () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    // Reproduce what durability 2.x left behind: workers-qb's history table,
    // the combined v4 schema, and a live record.
    storage.sql.exec(`
      CREATE TABLE durability_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    for (const migration of [
      ...durabilityOperationMigrations,
      ...durabilityNamedAlarmMigrations,
    ]) {
      storage.sql.exec(migration.up);
    }
    for (const name of [
      'durability_0001_create_calls',
      'durability_0002_pending_index',
      'durability_0003_create_alarms',
      'durability_0004_generation_and_created_at',
    ]) {
      storage.sql.exec(
        'INSERT INTO durability_migrations (name) VALUES (?)',
        name
      );
    }
    storage.sql.exec(
      `INSERT INTO durability_calls
        (id, operation, payload, status, attempt, next_attempt_at,
         generation_id, created_at)
       VALUES ('kept', 'work', '{"kind":"value","value":1}', 'pending', 1, 0,
         'gen-v2', 123)`
    );

    const durability = new Durability({
      context,
      handlers: { work: async () => undefined },
    });
    void new DurabilityAlarms({
      context,
      handlers: { cleanup: async () => undefined },
    });

    expect(
      storage.sql
        .exec<{ generation_id: string; created_at: number }>(
          'SELECT generation_id, created_at FROM durability_calls WHERE id = ?',
          'kept'
        )
        .toArray()
    ).toEqual([{ generation_id: 'gen-v2', created_at: 123 }]);
    expect(
      storage.sql
        .exec<{ name: string; capability: string | null }>(
          'SELECT name, capability FROM durability_migrations ORDER BY id'
        )
        .toArray()
    ).toEqual([
      { name: 'durability_0001_create_calls', capability: 'operations' },
      { name: 'durability_0002_pending_index', capability: 'operations' },
      { name: 'durability_0003_create_alarms', capability: 'namedAlarms' },
      { name: 'durability_0004_generation_and_created_at', capability: null },
      {
        name: 'durability_0004_calls_generation_and_created_at',
        capability: 'operations',
      },
      {
        name: 'durability_0004_alarms_generation_and_created_at',
        capability: 'namedAlarms',
      },
    ]);
    expect(Durability.migrate(context)).toEqual({
      applied: [],
      rolledBack: [],
    });
    await expect(durability.work.getResult('kept')).resolves.toMatchObject({
      status: 'pending',
      attempt: 1,
    });
  });

  it('translates the combined v2 history without re-running migrations', () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    Durability.migrate(context);
    DurabilityAlarms.migrate(context);
    storage.sql.exec(
      `DELETE FROM durability_migrations
       WHERE name IN (?, ?)`,
      'durability_0004_calls_generation_and_created_at',
      'durability_0004_alarms_generation_and_created_at'
    );
    storage.sql.exec(
      'INSERT INTO durability_migrations (name) VALUES (?)',
      'durability_0004_generation_and_created_at'
    );

    expect(Durability.migrate(context)).toEqual({
      applied: [],
      rolledBack: [],
    });
    expect(DurabilityAlarms.migrate(context)).toEqual({
      applied: [],
      rolledBack: [],
    });
    expect(
      storage.sql
        .exec<{ name: string }>(
          'SELECT name FROM durability_migrations ORDER BY name'
        )
        .toArray()
        .map(({ name }) => name)
    ).toEqual([
      'durability_0001_create_calls',
      'durability_0002_pending_index',
      'durability_0003_create_alarms',
      'durability_0004_alarms_generation_and_created_at',
      'durability_0004_calls_generation_and_created_at',
      'durability_0004_generation_and_created_at',
    ]);
  });

  it('reverts migrations recorded by a newer version on downgrade', () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    Durability.migrate(context);
    storage.sql.exec('CREATE TABLE durability_future (id TEXT PRIMARY KEY)');
    storage.sql.exec(
      `INSERT INTO durability_migrations (name, capability, down)
       VALUES (?, 'operations', ?)`,
      'durability_0005_calls_future',
      'DROP TABLE durability_future;'
    );

    expect(Durability.migrate(context)).toEqual({
      applied: [],
      rolledBack: ['durability_0005_calls_future'],
    });
    expect(tableNames(storage)).not.toContain('durability_future');
    expect(
      storage.sql
        .exec<{ down: string }>(
          'SELECT down FROM durability_migrations WHERE name = ?',
          'durability_0002_pending_index'
        )
        .toArray()[0]?.down
    ).toBe('DROP INDEX IF EXISTS durability_calls_pending_idx;');
  });

  it('refuses to unwind a schema more than two migrations ahead', () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    Durability.migrate(context);
    for (const version of [5, 6, 7]) {
      storage.sql.exec(
        `INSERT INTO durability_migrations (name, capability, down)
         VALUES (?, 'operations', 'SELECT 1;')`,
        `durability_000${version}_calls_future`
      );
    }

    expect(() => Durability.migrate(context)).toThrow(
      'refusing to revert more than 2'
    );
  });

  it('applies a batch of migrations atomically', () => {
    const storage = new FakeStorage();
    const migrations = [
      {
        name: 'test_0001',
        up: 'CREATE TABLE test_one (id TEXT);',
        down: 'DROP TABLE test_one;',
      },
      {
        name: 'test_0002',
        up: 'CREATE TABLE test_two (id TEXT) INVALID SQL;',
        down: 'DROP TABLE test_two;',
      },
    ];

    expect(() =>
      migrate(
        storage as unknown as DurableObjectStorage,
        'operations',
        migrations,
        undefined
      )
    ).toThrow(/syntax error/);
    expect(tableNames(storage)).not.toContain('test_one');
    expect(
      storage.sql
        .exec('SELECT COUNT(*) AS count FROM durability_migrations')
        .toArray()[0]?.['count']
    ).toBe(0);
  });
});

describe('KV storage', () => {
  it('persists operations without SQLite and retains deduplication', async () => {
    const storage = new FakeKvStorage();
    const handler = vi.fn(
      async ({ payload }: DurableCall<{ value: number }>) => payload.value * 2
    );
    const durability = new Durability({
      context: contextForKv(storage),
      handlers: { double: handler },
      storageBackend: 'kv',
    });

    await durability.double({ id: 'double:ü/2', payload: { value: 2 } });
    await vi.waitFor(async () => {
      await expect(durability.double.getResult('double:ü/2')).resolves.toEqual({
        status: 'completed',
        result: 4,
      });
    });
    await durability.double({ id: 'double:ü/2', payload: { value: 2 } });

    expect(handler).toHaveBeenCalledTimes(1);
    await expect(durability.purgeBefore(Number.MAX_SAFE_INTEGER)).resolves.toBe(
      1
    );
    await expect(durability.double.getResult('double:ü/2')).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('retries operations and named alarms from ordered KV indexes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = new FakeKvStorage();
    const scheduler = new DurabilityScheduler({
      context: contextForKv(storage),
      storageBackend: 'kv',
    });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('retry operation'))
      .mockResolvedValue('done');
    const durability = new Durability({
      scheduler: scheduler,
      handlers: { work: operation },
      retries: { delay: () => 1_000 },
    });
    const alarmAttempts: number[] = [];
    const alarms = new DurabilityAlarms({
      scheduler: scheduler,
      handlers: {
        cleanup: async ({ attempt }) => {
          alarmAttempts.push(attempt);
          if (attempt === 1) {
            throw new Error('retry alarm');
          }
        },
      },
      methods: { cleanup: { retries: { delay: () => 500 } } },
    });

    await durability.work({ id: 'work', payload: null });
    await alarms.cleanup(Date.now());
    storage.alarmAt = null;
    await scheduler.alarm();
    expect(storage.alarmAt).toBe(Date.now() + 500);

    vi.advanceTimersByTime(500);
    storage.alarmAt = null;
    await scheduler.alarm();
    expect(alarmAttempts).toEqual([1, 2]);
    expect(storage.alarmAt).toBe(Date.now() + 500);

    vi.advanceTimersByTime(500);
    storage.alarmAt = null;
    await scheduler.alarm();
    await expect(durability.work.getResult('work')).resolves.toEqual({
      status: 'completed',
      result: 'done',
    });
    expect(storage.alarmAt).toBeNull();
  });

  it('does not overlap eager and alarm execution during async lookup', async () => {
    const storage = new FakeKvStorage();
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handler = vi.fn(async () => pending);
    const durability = new Durability({
      context: contextForKv(storage),
      handlers: { work: handler },
      storageBackend: 'kv',
    });

    await Promise.all([
      durability.work({ id: 'single-flight', payload: null }),
      durability.alarm(),
    ]);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    finish?.();
    await pending;
    await vi.waitFor(async () => {
      await expect(
        durability.work.getResult('single-flight')
      ).resolves.toMatchObject({ status: 'completed' });
    });
  });

  it('purges KV records in bounded batches', async () => {
    const durability = new Durability({
      context: contextForKv(new FakeKvStorage()),
      handlers: { work: async () => undefined },
      storageBackend: 'kv',
      alarmConcurrency: 1,
    });

    await Promise.all(
      Array.from({ length: 70 }, (_, index) =>
        durability.work({ id: `purge:${index}`, payload: null })
      )
    );

    await expect(durability.purgeBefore(Number.MAX_SAFE_INTEGER)).resolves.toBe(
      70
    );
    await expect(durability.work.getResult('purge:69')).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('atomically validates concurrent same-ID registration', async () => {
    const durability = new Durability({
      context: contextForKv(new FakeKvStorage()),
      handlers: {
        first: async () => 'first',
        second: async () => 'second',
      },
      storageBackend: 'kv',
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
});

describe('Durability', () => {
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
    });

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
      (scheduledTime: number) => Promise<void>
    >();

    const assertInvalidTypes = () => {
      void new DurabilityAlarms({
        context: contextFor(new FakeStorage()),
        handlers: { cleanup: async () => undefined },
        // @ts-expect-error alarm policies require a matching alarm handler
        methods: { missing: { retries: { maxAttempts: 2 } } },
      });
      // @ts-expect-error unconfigured alarm names are not schedulable
      void alarms.missing(Date.now());
    };
    expectTypeOf(assertInvalidTypes).toBeFunction();
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
    const scheduledTime = Date.now() + 5_000;

    await alarms.cleanup(scheduledTime);

    expect(storage.alarmAt).toBe(scheduledTime);
    vi.advanceTimersByTime(5_000);
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
    });

    await alarms.cleanup(Date.now());
    storage.alarmAt = null;
    await alarms.alarm();

    expect(storage.alarmAt).toBe(Date.now() + 750);
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

    await alarms.cleanup(Date.now());
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

    await alarms.cleanup(Date.now());
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
    await alarms.cleanup(0);
    storage.sql.exec(
      "UPDATE durability_alarms SET attempt = 2 WHERE name = 'cleanup'"
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

describe('DurabilityScheduler', () => {
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
    await vi.waitFor(() => expect(storage.alarmAt).toBeGreaterThan(Date.now()));
    const operationRetryAt = storage.alarmAt;

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
