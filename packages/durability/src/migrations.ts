import type { DurableMigrations } from '@durability/storage';
import { z } from 'zod';

export const migrationTableName = 'durability_migrations';

/**
 * Ordered SQLite migrations for the `durability_calls` table owned by
 * {@link Durability}. Applied automatically on construction and tracked in the
 * namespaced `durability_migrations` table alongside application migrations.
 */
export const durabilityOperationMigrations = [
  {
    name: 'durability_0001_create_calls',
    up: `
      CREATE TABLE IF NOT EXISTS durability_calls (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
        result TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        last_error_name TEXT,
        completed_at INTEGER
      );
    `,
    down: 'DROP TABLE IF EXISTS durability_calls;',
  },
  {
    name: 'durability_0002_pending_index',
    up: `
      CREATE INDEX IF NOT EXISTS durability_calls_pending_idx
      ON durability_calls (status, next_attempt_at);
    `,
    down: 'DROP INDEX IF EXISTS durability_calls_pending_idx;',
  },
  {
    name: 'durability_0004_calls_generation_and_created_at',
    up: `
      DROP INDEX IF EXISTS durability_calls_pending_idx;
      ALTER TABLE durability_calls RENAME TO durability_calls_v3;
      CREATE TABLE durability_calls (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
        result TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        last_error_name TEXT,
        completed_at INTEGER,
        generation_id TEXT NOT NULL DEFAULT 'legacy',
        created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
      );
      INSERT INTO durability_calls
      SELECT id, operation, payload, status, result, attempt, next_attempt_at,
        last_error, last_error_name, completed_at, 'legacy:' || id,
        CAST(unixepoch('subsec') * 1000 AS INTEGER)
      FROM durability_calls_v3;
      DROP TABLE durability_calls_v3;
      CREATE INDEX durability_calls_pending_idx
      ON durability_calls (status, next_attempt_at);
      CREATE INDEX durability_calls_created_idx
      ON durability_calls (created_at);
    `,
    down: `
      DROP INDEX IF EXISTS durability_calls_pending_idx;
      DROP INDEX IF EXISTS durability_calls_created_idx;
      ALTER TABLE durability_calls RENAME TO durability_calls_v4;
      CREATE TABLE durability_calls (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
        result TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        last_error_name TEXT,
        completed_at INTEGER
      );
      INSERT INTO durability_calls
      SELECT id, operation, payload, status, result, attempt, next_attempt_at,
        last_error, last_error_name, completed_at
      FROM durability_calls_v4;
      DROP TABLE durability_calls_v4;
      CREATE INDEX durability_calls_pending_idx
      ON durability_calls (status, next_attempt_at);
    `,
  },
] satisfies DurableMigrations;

/**
 * Ordered SQLite migrations for the `durability_alarms` table owned by
 * {@link DurabilityAlarms}. Applied automatically on construction.
 */
export const durabilityNamedAlarmMigrations = [
  {
    name: 'durability_0003_create_alarms',
    up: `
      CREATE TABLE IF NOT EXISTS durability_alarms (
        name TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'failed')),
        scheduled_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_name TEXT
      );
      CREATE INDEX IF NOT EXISTS durability_alarms_pending_idx
      ON durability_alarms (status, next_attempt_at);
    `,
    down: `
      DROP INDEX IF EXISTS durability_alarms_pending_idx;
      DROP TABLE IF EXISTS durability_alarms;
    `,
  },
  {
    name: 'durability_0004_alarms_generation_and_created_at',
    up: `
      DROP INDEX IF EXISTS durability_alarms_pending_idx;
      ALTER TABLE durability_alarms RENAME TO durability_alarms_v3;
      CREATE TABLE durability_alarms (
        name TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'failed')),
        scheduled_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_name TEXT,
        created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
      );
      INSERT INTO durability_alarms
      SELECT name, generation_id, status, scheduled_at, next_attempt_at,
        attempt, last_error, last_error_name,
        CAST(unixepoch('subsec') * 1000 AS INTEGER)
      FROM durability_alarms_v3;
      DROP TABLE durability_alarms_v3;
      CREATE INDEX durability_alarms_pending_idx
      ON durability_alarms (status, next_attempt_at);
      CREATE INDEX durability_alarms_created_idx
      ON durability_alarms (created_at);
    `,
    down: `
      DROP INDEX IF EXISTS durability_alarms_pending_idx;
      DROP INDEX IF EXISTS durability_alarms_created_idx;
      ALTER TABLE durability_alarms RENAME TO durability_alarms_v4;
      CREATE TABLE durability_alarms (
        name TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'failed')),
        scheduled_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_name TEXT
      );
      INSERT INTO durability_alarms
      SELECT name, generation_id, status, scheduled_at, next_attempt_at,
        attempt, last_error, last_error_name
      FROM durability_alarms_v4;
      DROP TABLE durability_alarms_v4;
      CREATE INDEX durability_alarms_pending_idx
      ON durability_alarms (status, next_attempt_at);
    `,
  },
] satisfies DurableMigrations;

/**
 * Ordered SQLite migrations for fanout manifests and deliveries. Applied
 * automatically on construction.
 */
export const durabilityFanoutMigrations = [
  {
    name: 'durability_0005_create_fanout',
    up: `
      CREATE TABLE IF NOT EXISTS durability_fanout_messages (
        key TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        targets TEXT NOT NULL,
        remaining INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        generation_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS durability_fanout_deliveries (
        id TEXT PRIMARY KEY,
        message_key TEXT NOT NULL,
        target_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending')),
        phase TEXT NOT NULL CHECK (phase IN ('delivery', 'dead_letter')),
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        last_error_name TEXT,
        created_at INTEGER NOT NULL,
        generation_id TEXT NOT NULL,
        dead_lettered_at INTEGER,
        dead_letter_reason TEXT CHECK (dead_letter_reason IN ('explicit', 'exhausted'))
      );
      CREATE INDEX IF NOT EXISTS durability_fanout_deliveries_due_idx
      ON durability_fanout_deliveries
        (target_id, phase, status, attempt, seq, next_attempt_at);
      CREATE INDEX IF NOT EXISTS durability_fanout_deliveries_pending_idx
      ON durability_fanout_deliveries (phase, status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS durability_fanout_deliveries_created_idx
      ON durability_fanout_deliveries (created_at);
      CREATE TABLE IF NOT EXISTS durability_fanout_seq (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_seq INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO durability_fanout_seq (id, next_seq) VALUES (1, 0);
    `,
    down: `
      DROP INDEX IF EXISTS durability_fanout_deliveries_due_idx;
      DROP INDEX IF EXISTS durability_fanout_deliveries_pending_idx;
      DROP INDEX IF EXISTS durability_fanout_deliveries_created_idx;
      DROP TABLE IF EXISTS durability_fanout_deliveries;
      DROP TABLE IF EXISTS durability_fanout_messages;
      DROP TABLE IF EXISTS durability_fanout_seq;
    `,
  },
] satisfies DurableMigrations;

/**
 * Ordered SQLite migrations for the retained log and its consumer cursors.
 * Applied automatically on construction.
 */
export const durabilityLogMigrations = [
  {
    name: 'durability_0006_create_log',
    up: `
      CREATE TABLE IF NOT EXISTS durability_log_records (
        "offset" INTEGER PRIMARY KEY,
        dedup_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        appended_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durability_log_records_appended_idx
      ON durability_log_records (appended_at, "offset");
      CREATE TABLE IF NOT EXISTS durability_log_cursors (
        consumer TEXT PRIMARY KEY,
        "offset" INTEGER NOT NULL,
        committed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS durability_log_segments (
        first_offset INTEGER PRIMARY KEY,
        last_offset INTEGER NOT NULL,
        locator TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        flushed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS durability_log_seq (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_offset INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO durability_log_seq (id, next_offset, total_bytes)
      VALUES (1, 0, 0);
    `,
    down: `
      DROP INDEX IF EXISTS durability_log_records_appended_idx;
      DROP TABLE IF EXISTS durability_log_records;
      DROP TABLE IF EXISTS durability_log_cursors;
      DROP TABLE IF EXISTS durability_log_segments;
      DROP TABLE IF EXISTS durability_log_seq;
    `,
  },
] satisfies DurableMigrations;

/**
 * Leases let several workers consume one log in parallel without handing the
 * same offsets to two of them. Applied automatically when leases are enabled.
 */
export const durabilityLogLeaseMigrations = [
  {
    name: 'durability_0007_create_log_leases',
    up: `
      CREATE TABLE IF NOT EXISTS durability_log_leases (
        batch_id TEXT PRIMARY KEY,
        consumer TEXT NOT NULL,
        first_offset INTEGER NOT NULL,
        last_offset INTEGER NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('active', 'pending', 'acked', 'skipped')),
        attempt INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durability_log_leases_claim_idx
      ON durability_log_leases (consumer, state, expires_at, first_offset);
      CREATE INDEX IF NOT EXISTS durability_log_leases_order_idx
      ON durability_log_leases (consumer, first_offset);
      CREATE TABLE IF NOT EXISTS durability_log_allocations (
        consumer TEXT PRIMARY KEY,
        allocated_offset INTEGER NOT NULL
      );
    `,
    down: `
      DROP INDEX IF EXISTS durability_log_leases_claim_idx;
      DROP INDEX IF EXISTS durability_log_leases_order_idx;
      DROP TABLE IF EXISTS durability_log_leases;
      DROP TABLE IF EXISTS durability_log_allocations;
    `,
  },
] satisfies DurableMigrations;

/** Migration names changed by one migrate call. */
export type DurabilityMigrationResult = {
  /** Migrations applied in ascending order. */
  applied: string[];
  /** Migrations reverted in descending order. */
  rolledBack: string[];
};

export type MigrationCapability =
  | 'operations'
  | 'namedAlarms'
  | 'fanout'
  | 'log'
  | 'logLeases';

/**
 * Newer library versions may leave migrations this one does not know about.
 * On downgrade their stored `down` scripts are run, but only this many, so an
 * accidental deploy of an ancient version cannot silently unwind a schema.
 */
const maxFutureMigrations = 2;

type MigrationStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

const historyRowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  capability: z.string().nullable(),
  down: z.string().nullable(),
});

type HistoryRow = z.infer<typeof historyRowSchema>;

/**
 * Versions before 3.0 tracked the v4 rewrite of both tables under one name.
 * Splitting it lets each capability migrate independently. The combined row is
 * kept and both halves are recorded next to it, so a 2.x deployment reading
 * the same database still sees its history as complete and never re-runs the
 * rewrite.
 */
const legacyCombinedV4 = 'durability_0004_generation_and_created_at';
const legacyHalves = [
  'durability_0004_calls_generation_and_created_at',
  'durability_0004_alarms_generation_and_created_at',
];

const ensureHistoryTable = (sql: SqlStorage): void => {
  // The base shape matches the table earlier versions created through workers-qb.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ${migrationTableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `);
  const columns = new Set(
    sql
      .exec(`SELECT name FROM pragma_table_info('${migrationTableName}')`)
      .toArray()
      .map((row) => row['name'])
  );
  for (const column of ['capability', 'down']) {
    if (!columns.has(column)) {
      sql.exec(`ALTER TABLE ${migrationTableName} ADD COLUMN ${column} TEXT`);
    }
  }
};

const translateLegacyHistory = (sql: SqlStorage): void => {
  const legacy = sql
    .exec(
      `SELECT name FROM ${migrationTableName} WHERE name = ?`,
      legacyCombinedV4
    )
    .toArray();
  if (legacy.length === 0) {
    return;
  }
  for (const name of legacyHalves) {
    sql.exec(
      `INSERT OR IGNORE INTO ${migrationTableName} (name) VALUES (?)`,
      name
    );
  }
};

const readHistory = (
  sql: SqlStorage,
  capability: MigrationCapability,
  migrations: DurableMigrations
): HistoryRow[] => {
  // Rows written before capabilities were tracked are claimed by the list that names them.
  for (const { name } of migrations) {
    sql.exec(
      `UPDATE ${migrationTableName} SET capability = ?
       WHERE name = ? AND capability IS NULL`,
      capability,
      name
    );
  }
  return historyRowSchema.array().parse(
    sql
      .exec(
        `SELECT id, name, capability, down FROM ${migrationTableName}
         WHERE capability = ? ORDER BY id`,
        capability
      )
      .toArray()
  );
};

const runDown = (sql: SqlStorage, name: string, down: string | null): void => {
  if (down === null) {
    throw new Error(`Migration "${name}" has no stored down script`);
  }
  sql.exec(down);
  sql.exec(`DELETE FROM ${migrationTableName} WHERE name = ?`, name);
};

/**
 * Reverts migrations recorded by a newer library version, newest first, using
 * the down scripts it stored. Refuses when the schema is further ahead than
 * {@link maxFutureMigrations}.
 */
const revertFutureMigrations = (
  storage: MigrationStorage,
  capability: MigrationCapability,
  history: HistoryRow[],
  known: ReadonlySet<string>
): string[] => {
  const future = history.filter(({ name }) => !known.has(name)).reverse();
  if (future.length === 0) {
    return [];
  }
  if (future.length > maxFutureMigrations) {
    throw new Error(
      `Durability ${capability} schema is ${future.length} migrations ahead of this version; refusing to revert more than ${maxFutureMigrations}`
    );
  }
  storage.transactionSync(() => {
    for (const row of future) {
      runDown(storage.sql, row.name, row.down);
    }
  });
  return future.map(({ name }) => name);
};

/**
 * Moves one capability's schema to a target migration, applying or reverting as
 * needed. `null` reverts every migration in the list; the shared migration
 * table is dropped once no durability history remains.
 *
 * Each migration's `down` is stored alongside its history row so a later
 * downgrade of the library can still revert it. Batches of migrations apply or
 * revert atomically.
 */
export const migrate = (
  storage: MigrationStorage,
  capability: MigrationCapability,
  migrations: DurableMigrations,
  target: string | null | undefined
): DurabilityMigrationResult => {
  const resolvedTarget =
    target === undefined
      ? (migrations[migrations.length - 1]?.name ?? null)
      : target;
  const targetIndex =
    resolvedTarget === null
      ? -1
      : migrations.findIndex((migration) => migration.name === resolvedTarget);
  if (resolvedTarget !== null && targetIndex === -1) {
    throw new Error(`Unknown durability migration target "${resolvedTarget}"`);
  }

  ensureHistoryTable(storage.sql);
  translateLegacyHistory(storage.sql);
  const known = new Set(migrations.map(({ name }) => name));
  const history = readHistory(storage.sql, capability, migrations);
  const rolledBack = revertFutureMigrations(
    storage,
    capability,
    history,
    known
  );
  const applied = new Map(
    history
      .filter(({ name }) => known.has(name))
      .map((row) => [row.name, row] as const)
  );

  const toRevert = migrations
    .slice(targetIndex + 1)
    .filter(({ name }) => applied.has(name))
    .reverse();
  const toApply = migrations
    .slice(0, targetIndex + 1)
    .filter(({ name }) => !applied.has(name));
  const toRefresh = migrations
    .slice(0, targetIndex + 1)
    .filter(({ name, down }) => applied.get(name)?.down !== down);

  storage.transactionSync(() => {
    for (const migration of toRevert) {
      runDown(storage.sql, migration.name, migration.down);
    }
    for (const migration of toApply) {
      storage.sql.exec(migration.up);
      storage.sql.exec(
        `INSERT INTO ${migrationTableName} (name, capability, down) VALUES (?, ?, ?)`,
        migration.name,
        capability,
        migration.down
      );
    }
    // Keep stored down scripts current so a downgrade runs the latest revert logic.
    for (const migration of toRefresh) {
      storage.sql.exec(
        `UPDATE ${migrationTableName} SET down = ? WHERE name = ?`,
        migration.down,
        migration.name
      );
    }
  });

  const remaining = z
    .object({ count: z.number().int() })
    .parse(
      storage.sql
        .exec(`SELECT COUNT(*) AS count FROM ${migrationTableName}`)
        .toArray()[0]
    ).count;
  if (remaining === 0) {
    storage.sql.exec(`DROP TABLE IF EXISTS ${migrationTableName}`);
  }

  return {
    applied: toApply.map(({ name }) => name),
    rolledBack: [...rolledBack, ...toRevert.map(({ name }) => name)],
  };
};
