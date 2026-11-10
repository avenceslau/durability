import type { DurableMigrations } from '@durability/storage';

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
  {
    name: 'durability_0015_calls_channel',
    up: `
      ALTER TABLE durability_calls RENAME TO durability_calls_before_channels;
      CREATE TABLE durability_calls (
        id TEXT NOT NULL,
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
        created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
        channel TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (channel, id)
      );
      INSERT INTO durability_calls
      SELECT *, 'default' FROM durability_calls_before_channels;
      DROP TABLE durability_calls_before_channels;
      CREATE INDEX durability_calls_pending_idx
      ON durability_calls (status, next_attempt_at);
      CREATE INDEX durability_calls_created_idx
      ON durability_calls (created_at);
      CREATE INDEX durability_calls_channel_pending_idx
      ON durability_calls (channel, status, next_attempt_at);
    `,
    down: `
      CREATE TABLE durability_calls_channel_guard (
        channel TEXT CONSTRAINT cannot_downgrade_nondefault_channels CHECK (channel = 'default')
      );
      INSERT INTO durability_calls_channel_guard SELECT DISTINCT channel FROM durability_calls;
      DROP TABLE durability_calls_channel_guard;
      ALTER TABLE durability_calls RENAME TO durability_calls_with_channels;
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
        last_error, last_error_name, completed_at, generation_id, created_at
      FROM durability_calls_with_channels;
      DROP TABLE durability_calls_with_channels;
      CREATE INDEX durability_calls_pending_idx
      ON durability_calls (status, next_attempt_at);
      CREATE INDEX durability_calls_created_idx
      ON durability_calls (created_at);
    `,
  },
] satisfies DurableMigrations;
