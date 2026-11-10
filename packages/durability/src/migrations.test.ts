import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Durability,
  DurabilityAlarms,
  DurabilityScheduler,
  durabilityNamedAlarmMigrations,
  durabilityOperationMigrations,
  migrate,
} from './index';
import { migrateCapability } from './migrations';
import { contextFor, FakeStorage } from './test-fakes';

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
        'durability_0015_calls_channel',
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
        'durability_0016_alarms_channel',
      ],
      rolledBack: [],
    });
    expect(Durability.migrate(context, 'durability_0001_create_calls')).toEqual(
      {
        applied: [],
        rolledBack: [
          'durability_0015_calls_channel',
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
        'durability_0016_alarms_channel',
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
      'durability_memos',
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
      'durability_memos',
      'durability_migrations',
    ]);
  });

  it('reads the history once per capability when the schema is current', () => {
    const storage = new FakeStorage();
    const construct = () => {
      const scheduler = new DurabilityScheduler({
        context: contextFor(storage),
      });
      return [
        new Durability({ scheduler, handlers: { work: async () => 1 } }),
        new DurabilityAlarms({
          scheduler,
          handlers: { job: async () => undefined },
        }),
      ];
    };
    construct();
    const exec = vi.spyOn(storage.sql, 'exec');

    construct();

    expect(exec.mock.calls.map(([query]) => query.trim())).toEqual([
      'SELECT name, down FROM durability_migrations WHERE capability = ?',
      'SELECT name, down FROM durability_migrations WHERE capability = ?',
      'SELECT name, down FROM durability_migrations WHERE capability = ?',
    ]);
  });

  it('migrates on construction when the stored history is stale', () => {
    const storage = new FakeStorage();
    const context = contextFor(storage);
    Durability.migrate(context);
    storage.sql.exec(
      `UPDATE durability_migrations SET down = 'SELECT 1;' WHERE name = ?`,
      'durability_0002_pending_index'
    );
    storage.sql.exec('CREATE TABLE durability_future (id TEXT PRIMARY KEY)');
    storage.sql.exec(
      `INSERT INTO durability_migrations (name, capability, down)
       VALUES (?, 'operations', ?)`,
      'durability_0005_calls_future',
      'DROP TABLE durability_future;'
    );

    void new Durability({ context, handlers: { work: async () => 1 } });

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
    // the combined v4 schema, and a live record. Channels came later.
    storage.sql.exec(`
      CREATE TABLE durability_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    for (const migration of [
      ...durabilityOperationMigrations.filter(
        ({ name }) => name !== 'durability_0015_calls_channel'
      ),
      ...durabilityNamedAlarmMigrations.filter(
        ({ name }) => name !== 'durability_0016_alarms_channel'
      ),
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
      { name: 'durability_0015_calls_channel', capability: 'operations' },
      { name: 'durability_0012_create_memos', capability: 'memos' },
      { name: 'durability_0016_alarms_channel', capability: 'namedAlarms' },
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
      'durability_0015_calls_channel',
      'durability_0016_alarms_channel',
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
      migrateCapability(
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

  it('refreshes stored down scripts only for migrations applied earlier', () => {
    const storage = new FakeStorage();
    const migration = {
      name: 'test_0001',
      up: 'CREATE TABLE test_one (id TEXT);',
      down: 'DROP TABLE test_one;',
    };
    const exec = vi.spyOn(storage.sql, 'exec');
    const refreshes = () =>
      exec.mock.calls.filter(([query]) => query.includes('SET down')).length;
    const migrateTest = (target: (typeof migration)[]) =>
      migrateCapability(
        contextFor(storage).storage,
        'operations',
        target,
        undefined
      );

    migrateTest([migration]);
    expect(refreshes()).toBe(0);

    migrateTest([
      {
        ...migration,
        down: 'DROP TABLE IF EXISTS test_one;',
      },
    ]);
    expect(refreshes()).toBe(1);
    expect(
      storage.sql
        .exec("SELECT down FROM durability_migrations WHERE name = 'test_0001'")
        .toArray()[0]?.['down']
    ).toBe('DROP TABLE IF EXISTS test_one;');
  });
});

describe('migrate', () => {
  const jobsMigrations = [
    {
      name: '0001_create_jobs',
      up: 'CREATE TABLE jobs (id TEXT PRIMARY KEY);',
      down: 'DROP TABLE jobs;',
    },
    {
      name: '0002_add_jobs_status',
      up: "ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'queued';",
      down: 'ALTER TABLE jobs DROP COLUMN status;',
    },
  ];
  const asStorage = (storage: FakeStorage) =>
    storage as unknown as DurableObjectStorage;

  it('tracks application migrations apart from durability history', () => {
    const storage = new FakeStorage();
    Durability.migrate(contextFor(storage));

    expect(migrate(asStorage(storage), jobsMigrations)).toEqual({
      applied: ['0001_create_jobs', '0002_add_jobs_status'],
      rolledBack: [],
    });
    expect(migrate(asStorage(storage), jobsMigrations)).toEqual({
      applied: [],
      rolledBack: [],
    });
    expect(tableNames(storage)).toEqual([
      'durability_calls',
      'durability_migrations',
      'jobs',
      'schema_migrations',
    ]);
    expect(
      storage.sql
        .exec('SELECT COUNT(*) AS count FROM durability_migrations')
        .toArray()[0]?.['count']
    ).toBe(4);
  });

  it('moves to a target and drops its history table once empty', () => {
    const storage = new FakeStorage();
    migrate(asStorage(storage), jobsMigrations, { table: 'app_history' });

    expect(
      migrate(asStorage(storage), jobsMigrations, {
        table: 'app_history',
        target: '0001_create_jobs',
      })
    ).toEqual({ applied: [], rolledBack: ['0002_add_jobs_status'] });
    expect(
      migrate(asStorage(storage), jobsMigrations, {
        table: 'app_history',
        target: null,
      })
    ).toEqual({ applied: [], rolledBack: ['0001_create_jobs'] });
    expect(tableNames(storage)).toEqual([]);
  });

  it('reverts migrations an application downgrade does not know', () => {
    const storage = new FakeStorage();
    migrate(asStorage(storage), jobsMigrations);

    expect(migrate(asStorage(storage), jobsMigrations.slice(0, 1))).toEqual({
      applied: [],
      rolledBack: ['0002_add_jobs_status'],
    });
    expect(
      storage.sql
        .exec<{ name: string }>(`SELECT name FROM pragma_table_info('jobs')`)
        .toArray()
        .map(({ name }) => name)
    ).toEqual(['id']);
  });

  it('rejects a history table it cannot safely name', () => {
    const storage = new FakeStorage();

    expect(() =>
      migrate(asStorage(storage), jobsMigrations, {
        table: 'jobs; DROP TABLE x',
      })
    ).toThrow('Invalid schema migration table');
    expect(() =>
      migrate(asStorage(storage), jobsMigrations, {
        table: 'durability_migrations',
      })
    ).toThrow('Invalid schema migration table');
  });
});
