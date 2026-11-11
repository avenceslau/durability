import type { DurableMigrations } from '@durability/storage';
import * as v from 'valibot';
import { traceStorage } from './dev.js';

export const migrationTableName = 'durability_migrations';

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
  | 'memos'
  | 'fanout'
  | 'socket'
  | 'log'
  | 'logLeases'
  | 'outbox'
  | 'semaphore'
  | 'semaphoreQueue'
  | 'topology'
  | 'schedule';

/**
 * Newer library versions may leave migrations this one does not know about.
 * On downgrade their stored `down` scripts are run, but only this many, so an
 * accidental deploy of an ancient version cannot silently unwind a schema.
 */
const maxFutureMigrations = 2;

type MigrationStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

const historyRowSchema = v.object({
  id: v.pipe(v.number(), v.safeInteger()),
  name: v.string(),
  capability: v.nullable(v.string()),
  down: v.nullable(v.string()),
});

type HistoryRow = v.InferOutput<typeof historyRowSchema>;

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

/** Where one list of migrations records its history, and how errors name it. */
type HistoryScope = {
  table: string;
  capability: string;
  label: string;
};

const ensureHistoryTable = (sql: SqlStorage, table: string): void => {
  // The base shape matches the table earlier versions created through workers-qb.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `);
  const columns = new Set(
    sql
      .exec(`SELECT name FROM pragma_table_info('${table}')`)
      .toArray()
      .map((row) => row['name'])
  );
  for (const column of ['capability', 'down']) {
    if (!columns.has(column)) {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
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
  scope: HistoryScope,
  migrations: DurableMigrations
): HistoryRow[] => {
  // Rows written before capabilities were tracked are claimed by the list that names them.
  for (const { name } of migrations) {
    sql.exec(
      `UPDATE ${scope.table} SET capability = ?
       WHERE name = ? AND capability IS NULL`,
      scope.capability,
      name
    );
  }
  return v.parse(
    v.array(historyRowSchema),
    sql
      .exec(
        `SELECT id, name, capability, down FROM ${scope.table}
         WHERE capability = ? ORDER BY id`,
        scope.capability
      )
      .toArray()
  );
};

const runDown = (
  sql: SqlStorage,
  table: string,
  name: string,
  down: string | null
): void => {
  if (down === null) {
    throw new Error(`Migration "${name}" has no stored down script`);
  }
  sql.exec(down);
  sql.exec(`DELETE FROM ${table} WHERE name = ?`, name);
};

/**
 * Reverts migrations recorded by a newer version, newest first, using the down
 * scripts it stored. Refuses when the schema is further ahead than
 * {@link maxFutureMigrations}.
 */
const revertFutureMigrations = (
  storage: MigrationStorage,
  scope: HistoryScope,
  history: HistoryRow[],
  known: ReadonlySet<string>
): string[] => {
  const future = history.filter(({ name }) => !known.has(name)).reverse();
  if (future.length === 0) {
    return [];
  }
  if (future.length > maxFutureMigrations) {
    throw new Error(
      `${scope.label} schema is ${future.length} migrations ahead of this version; refusing to revert more than ${maxFutureMigrations}`
    );
  }
  storage.transactionSync(() => {
    for (const row of future) {
      runDown(storage.sql, scope.table, row.name, row.down);
    }
  });
  return future.map(({ name }) => name);
};

const currentRowSchema = v.object({
  name: v.string(),
  down: v.nullable(v.string()),
});

/**
 * Whether a capability's history already lists exactly these migrations with
 * these `down` scripts, so construction can skip {@link migrateCapability}. Every Durable
 * Object wake constructs its helpers, and each statement there is one more way
 * for the wake to fail, so the common case costs one read.
 */
export const isSchemaCurrent = (
  sql: SqlStorage,
  capability: MigrationCapability,
  migrations: DurableMigrations
): boolean => {
  let rows: v.InferOutput<typeof currentRowSchema>[];
  try {
    rows = v.parse(
      v.array(currentRowSchema),
      sql
        .exec(
          `SELECT name, down FROM ${migrationTableName} WHERE capability = ?`,
          capability
        )
        .toArray()
    );
  } catch {
    // A first construction has no history table, and an older one lacks the
    // capability column; migrateCapability() creates both, and retries any other failure.
    return false;
  }

  const known = new Map(migrations.map(({ name, down }) => [name, down]));
  return (
    rows.length === known.size &&
    rows.every((row) => known.get(row.name) === row.down)
  );
};

const migrateScope = (
  storage: MigrationStorage,
  scope: HistoryScope,
  migrations: DurableMigrations,
  target: string | null | undefined
): DurabilityMigrationResult => {
  storage = traceStorage(storage);
  const resolvedTarget =
    target === undefined
      ? (migrations[migrations.length - 1]?.name ?? null)
      : target;
  const targetIndex =
    resolvedTarget === null
      ? -1
      : migrations.findIndex((migration) => migration.name === resolvedTarget);
  if (resolvedTarget !== null && targetIndex === -1) {
    throw new Error(
      `Unknown ${scope.label} migration target "${resolvedTarget}"`
    );
  }

  ensureHistoryTable(storage.sql, scope.table);
  if (scope.table === migrationTableName) {
    translateLegacyHistory(storage.sql);
  }
  const known = new Set(migrations.map(({ name }) => name));
  const history = readHistory(storage.sql, scope, migrations);
  const rolledBack = revertFutureMigrations(storage, scope, history, known);
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
    .filter(
      ({ name, down }) => applied.has(name) && applied.get(name)?.down !== down
    );

  storage.transactionSync(() => {
    for (const migration of toRevert) {
      runDown(storage.sql, scope.table, migration.name, migration.down);
    }
    for (const migration of toApply) {
      storage.sql.exec(migration.up);
      storage.sql.exec(
        `INSERT INTO ${scope.table} (name, capability, down) VALUES (?, ?, ?)`,
        migration.name,
        scope.capability,
        migration.down
      );
    }
    // Keep stored down scripts current so a downgrade runs the latest revert logic.
    for (const migration of toRefresh) {
      storage.sql.exec(
        `UPDATE ${scope.table} SET down = ? WHERE name = ?`,
        migration.down,
        migration.name
      );
    }
  });

  const remaining = v.parse(
    v.object({ count: v.pipe(v.number(), v.safeInteger()) }),
    storage.sql
      .exec(`SELECT COUNT(*) AS count FROM ${scope.table}`)
      .toArray()[0]
  ).count;
  if (remaining === 0) {
    storage.sql.exec(`DROP TABLE IF EXISTS ${scope.table}`);
  }

  return {
    applied: toApply.map(({ name }) => name),
    rolledBack: [...rolledBack, ...toRevert.map(({ name }) => name)],
  };
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
export const migrateCapability = (
  storage: MigrationStorage,
  capability: MigrationCapability,
  migrations: DurableMigrations,
  target: string | null | undefined
): DurabilityMigrationResult =>
  migrateScope(
    storage,
    {
      table: migrationTableName,
      capability,
      label: `Durability ${capability}`,
    },
    migrations,
    target
  );

/** Options for {@link migrate}. */
export type MigrateOptions = {
  /** History table for these migrations. Defaults to `schema_migrations`. */
  table?: string;
  /**
   * Migration to move the schema to. Defaults to the last one; `null` reverts
   * every migration.
   */
  target?: string | null;
};

const sqlIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Moves an application's own schema to a target migration, with the same
 * guarantees durability gives its tables: each batch applies or reverts in one
 * synchronous transaction, every history row stores its `down` script, and a
 * Durable Object running older code reverts up to two migrations it does not
 * know before refusing.
 *
 * The history lives in its own table, apart from `durability_migrations`, and
 * is dropped once no migration remains applied.
 *
 * @example
 * ```ts
 * constructor(ctx: DurableObjectState, env: Env) {
 *   super(ctx, env);
 *   migrate(ctx.storage, [
 *     {
 *       name: '0001_create_jobs',
 *       up: 'CREATE TABLE jobs (id TEXT PRIMARY KEY);',
 *       down: 'DROP TABLE jobs;',
 *     },
 *   ]);
 * }
 * ```
 */
export const migrate = (
  storage: MigrationStorage,
  migrations: DurableMigrations,
  options: MigrateOptions = {}
): DurabilityMigrationResult => {
  const table = options.table ?? 'schema_migrations';
  if (!sqlIdentifier.test(table) || table === migrationTableName) {
    throw new Error(`Invalid schema migration table "${table}"`);
  }
  return migrateScope(
    storage,
    {
      table,
      capability: 'schema',
      label: `"${table}"`,
    },
    migrations,
    options.target
  );
};
