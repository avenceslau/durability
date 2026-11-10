import type { DurableMigrations } from '@durability/storage';

/**
 * Ordered SQLite migrations for the experimental schedule. Applied
 * automatically on construction.
 */
export const durabilityScheduleMigrations = [
  {
    name: 'durability_0013_create_schedule',
    // INTEGER PRIMARY KEY aliases the rowid, so each table is a single b-tree
    // with no secondary index for per-run writes to maintain.
    up: `
      CREATE TABLE IF NOT EXISTS durability_schedule (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        expression TEXT,
        next_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS durability_schedule_runs (
        scheduled_time INTEGER PRIMARY KEY,
        state TEXT NOT NULL
          CHECK (state IN ('queued', 'running', 'complete', 'errored')),
        next_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
    `,
    down: `
      DROP TABLE IF EXISTS durability_schedule_runs;
      DROP TABLE IF EXISTS durability_schedule;
    `,
  },
  {
    name: 'durability_0014_add_schedule_jitter',
    up: `
      ALTER TABLE durability_schedule ADD COLUMN jitter_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE durability_schedule_runs ADD COLUMN due_at INTEGER;
      UPDATE durability_schedule_runs SET due_at = scheduled_time;
    `,
    down: `
      ALTER TABLE durability_schedule_runs DROP COLUMN due_at;
      ALTER TABLE durability_schedule DROP COLUMN jitter_ms;
    `,
  },
  {
    name: 'durability_0018_schedule_channels',
    // WITHOUT ROWID keeps each table a single b-tree under its composite key,
    // so per-run writes still maintain no secondary index.
    up: `
      ALTER TABLE durability_schedule RENAME TO durability_schedule_before_channels;
      CREATE TABLE durability_schedule (
        channel TEXT NOT NULL DEFAULT 'default',
        id INTEGER NOT NULL CHECK (id = 1),
        version INTEGER NOT NULL,
        expression TEXT,
        next_at INTEGER,
        jitter_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel, id)
      ) WITHOUT ROWID;
      INSERT INTO durability_schedule
        (channel, id, version, expression, next_at, jitter_ms)
      SELECT 'default', id, version, expression, next_at, jitter_ms
      FROM durability_schedule_before_channels;
      DROP TABLE durability_schedule_before_channels;
      ALTER TABLE durability_schedule_runs RENAME TO durability_schedule_runs_before_channels;
      CREATE TABLE durability_schedule_runs (
        channel TEXT NOT NULL DEFAULT 'default',
        scheduled_time INTEGER NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('queued', 'running', 'complete', 'errored')),
        next_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        due_at INTEGER,
        PRIMARY KEY (channel, scheduled_time)
      ) WITHOUT ROWID;
      INSERT INTO durability_schedule_runs
        (channel, scheduled_time, state, next_at, attempt, error, due_at)
      SELECT 'default', scheduled_time, state, next_at, attempt, error, due_at
      FROM durability_schedule_runs_before_channels;
      DROP TABLE durability_schedule_runs_before_channels;
    `,
    down: `
      CREATE TABLE durability_schedule_channel_guard (
        channel TEXT CONSTRAINT cannot_downgrade_nondefault_channels CHECK (channel = 'default')
      );
      INSERT INTO durability_schedule_channel_guard
      SELECT channel FROM durability_schedule
      UNION SELECT channel FROM durability_schedule_runs;
      DROP TABLE durability_schedule_channel_guard;
      ALTER TABLE durability_schedule RENAME TO durability_schedule_with_channels;
      CREATE TABLE durability_schedule (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        expression TEXT,
        next_at INTEGER,
        jitter_ms INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO durability_schedule (id, version, expression, next_at, jitter_ms)
      SELECT id, version, expression, next_at, jitter_ms
      FROM durability_schedule_with_channels;
      DROP TABLE durability_schedule_with_channels;
      ALTER TABLE durability_schedule_runs RENAME TO durability_schedule_runs_with_channels;
      CREATE TABLE durability_schedule_runs (
        scheduled_time INTEGER PRIMARY KEY,
        state TEXT NOT NULL
          CHECK (state IN ('queued', 'running', 'complete', 'errored')),
        next_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        due_at INTEGER
      );
      INSERT INTO durability_schedule_runs
        (scheduled_time, state, next_at, attempt, error, due_at)
      SELECT scheduled_time, state, next_at, attempt, error, due_at
      FROM durability_schedule_runs_with_channels;
      DROP TABLE durability_schedule_runs_with_channels;
    `,
  },
] satisfies DurableMigrations;
