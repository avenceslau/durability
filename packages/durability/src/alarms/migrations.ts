import type { DurableMigrations } from '@durability/storage';

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
  {
    name: 'durability_0016_alarms_channel',
    up: `
      ALTER TABLE durability_alarms RENAME TO durability_alarms_before_channels;
      CREATE TABLE durability_alarms (
        name TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'failed')),
        scheduled_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_name TEXT,
        created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
        channel TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (channel, name)
      );
      INSERT INTO durability_alarms
      SELECT *, 'default' FROM durability_alarms_before_channels;
      DROP TABLE durability_alarms_before_channels;
      CREATE INDEX durability_alarms_pending_idx
      ON durability_alarms (status, next_attempt_at);
      CREATE INDEX durability_alarms_created_idx
      ON durability_alarms (created_at);
      CREATE INDEX durability_alarms_channel_pending_idx
      ON durability_alarms (channel, status, next_attempt_at);
    `,
    down: `
      CREATE TABLE durability_alarms_channel_guard (
        channel TEXT CONSTRAINT cannot_downgrade_nondefault_channels CHECK (channel = 'default')
      );
      INSERT INTO durability_alarms_channel_guard SELECT DISTINCT channel FROM durability_alarms;
      DROP TABLE durability_alarms_channel_guard;
      ALTER TABLE durability_alarms RENAME TO durability_alarms_with_channels;
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
        attempt, last_error, last_error_name, created_at
      FROM durability_alarms_with_channels;
      DROP TABLE durability_alarms_with_channels;
      CREATE INDEX durability_alarms_pending_idx
      ON durability_alarms (status, next_attempt_at);
      CREATE INDEX durability_alarms_created_idx
      ON durability_alarms (created_at);
    `,
  },
] satisfies DurableMigrations;
