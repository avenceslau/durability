import type { DurableMigrations } from '@durability/storage';

/**
 * Ordered SQLite migrations for the retained log and its consumer cursors.
 * Applied automatically on construction.
 */
export const durabilityLogMigrations = [
  {
    name: 'durability_0007_create_log',
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
  {
    name: 'durability_0019_log_channels',
    up: `
      ALTER TABLE durability_log_records RENAME TO durability_log_records_before_channels;
      CREATE TABLE durability_log_records (
        channel TEXT NOT NULL,
        "offset" INTEGER NOT NULL,
        dedup_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        appended_at INTEGER NOT NULL,
        PRIMARY KEY (channel, "offset"),
        UNIQUE (channel, dedup_key)
      );
      INSERT INTO durability_log_records
        (channel, "offset", dedup_key, payload, bytes, appended_at)
      SELECT 'default', "offset", dedup_key, payload, bytes, appended_at
      FROM durability_log_records_before_channels;
      DROP TABLE durability_log_records_before_channels;
      CREATE INDEX durability_log_records_appended_idx
      ON durability_log_records (channel, appended_at, "offset");

      ALTER TABLE durability_log_cursors RENAME TO durability_log_cursors_before_channels;
      CREATE TABLE durability_log_cursors (
        channel TEXT NOT NULL,
        consumer TEXT NOT NULL,
        "offset" INTEGER NOT NULL,
        committed_at INTEGER NOT NULL,
        PRIMARY KEY (channel, consumer)
      );
      INSERT INTO durability_log_cursors (channel, consumer, "offset", committed_at)
      SELECT 'default', consumer, "offset", committed_at
      FROM durability_log_cursors_before_channels;
      DROP TABLE durability_log_cursors_before_channels;

      ALTER TABLE durability_log_segments RENAME TO durability_log_segments_before_channels;
      CREATE TABLE durability_log_segments (
        channel TEXT NOT NULL,
        first_offset INTEGER NOT NULL,
        last_offset INTEGER NOT NULL,
        locator TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        flushed_at INTEGER NOT NULL,
        PRIMARY KEY (channel, first_offset)
      );
      INSERT INTO durability_log_segments
        (channel, first_offset, last_offset, locator, bytes, flushed_at)
      SELECT 'default', first_offset, last_offset, locator, bytes, flushed_at
      FROM durability_log_segments_before_channels;
      DROP TABLE durability_log_segments_before_channels;

      ALTER TABLE durability_log_seq RENAME TO durability_log_seq_before_channels;
      CREATE TABLE durability_log_seq (
        channel TEXT PRIMARY KEY,
        next_offset INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL
      );
      INSERT INTO durability_log_seq (channel, next_offset, total_bytes)
      SELECT 'default', next_offset, total_bytes
      FROM durability_log_seq_before_channels WHERE id = 1;
      DROP TABLE durability_log_seq_before_channels;
    `,
    // A channel's offset counter is kept even once its records are gone, so
    // it also blocks the downgrade: dropping it would let offsets repeat.
    down: `
      CREATE TABLE durability_log_channel_guard (
        channel TEXT CONSTRAINT cannot_downgrade_nondefault_channels CHECK (channel = 'default')
      );
      INSERT INTO durability_log_channel_guard
      SELECT channel FROM durability_log_records
      UNION SELECT channel FROM durability_log_cursors
      UNION SELECT channel FROM durability_log_segments
      UNION SELECT channel FROM durability_log_seq;
      DROP TABLE durability_log_channel_guard;

      ALTER TABLE durability_log_records RENAME TO durability_log_records_with_channels;
      CREATE TABLE durability_log_records (
        "offset" INTEGER PRIMARY KEY,
        dedup_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        appended_at INTEGER NOT NULL
      );
      INSERT INTO durability_log_records
        ("offset", dedup_key, payload, bytes, appended_at)
      SELECT "offset", dedup_key, payload, bytes, appended_at
      FROM durability_log_records_with_channels;
      DROP TABLE durability_log_records_with_channels;
      CREATE INDEX durability_log_records_appended_idx
      ON durability_log_records (appended_at, "offset");

      ALTER TABLE durability_log_cursors RENAME TO durability_log_cursors_with_channels;
      CREATE TABLE durability_log_cursors (
        consumer TEXT PRIMARY KEY,
        "offset" INTEGER NOT NULL,
        committed_at INTEGER NOT NULL
      );
      INSERT INTO durability_log_cursors (consumer, "offset", committed_at)
      SELECT consumer, "offset", committed_at
      FROM durability_log_cursors_with_channels;
      DROP TABLE durability_log_cursors_with_channels;

      ALTER TABLE durability_log_segments RENAME TO durability_log_segments_with_channels;
      CREATE TABLE durability_log_segments (
        first_offset INTEGER PRIMARY KEY,
        last_offset INTEGER NOT NULL,
        locator TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        flushed_at INTEGER NOT NULL
      );
      INSERT INTO durability_log_segments
        (first_offset, last_offset, locator, bytes, flushed_at)
      SELECT first_offset, last_offset, locator, bytes, flushed_at
      FROM durability_log_segments_with_channels;
      DROP TABLE durability_log_segments_with_channels;

      ALTER TABLE durability_log_seq RENAME TO durability_log_seq_with_channels;
      CREATE TABLE durability_log_seq (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_offset INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL
      );
      INSERT INTO durability_log_seq (id, next_offset, total_bytes)
      SELECT 1, next_offset, total_bytes
      FROM durability_log_seq_with_channels WHERE channel = 'default';
      INSERT OR IGNORE INTO durability_log_seq (id, next_offset, total_bytes)
      VALUES (1, 0, 0);
      DROP TABLE durability_log_seq_with_channels;
    `,
  },
] satisfies DurableMigrations;

/**
 * Leases let several workers consume one log in parallel without handing the
 * same offsets to two of them. Applied automatically when leases are enabled.
 */
export const durabilityLogLeaseMigrations = [
  {
    name: 'durability_0008_create_log_leases',
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
  {
    name: 'durability_0024_log_lease_channels',
    up: `
      ALTER TABLE durability_log_leases RENAME TO durability_log_leases_before_channels;
      CREATE TABLE durability_log_leases (
        channel TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        consumer TEXT NOT NULL,
        first_offset INTEGER NOT NULL,
        last_offset INTEGER NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('active', 'pending', 'acked', 'skipped')),
        attempt INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (channel, batch_id)
      );
      INSERT INTO durability_log_leases
        (channel, batch_id, consumer, first_offset, last_offset, state,
         attempt, expires_at, created_at)
      SELECT 'default', batch_id, consumer, first_offset, last_offset, state,
        attempt, expires_at, created_at
      FROM durability_log_leases_before_channels;
      DROP TABLE durability_log_leases_before_channels;
      CREATE INDEX durability_log_leases_claim_idx
      ON durability_log_leases (channel, consumer, state, expires_at, first_offset);
      CREATE INDEX durability_log_leases_order_idx
      ON durability_log_leases (channel, consumer, first_offset);

      ALTER TABLE durability_log_allocations RENAME TO durability_log_allocations_before_channels;
      CREATE TABLE durability_log_allocations (
        channel TEXT NOT NULL,
        consumer TEXT NOT NULL,
        allocated_offset INTEGER NOT NULL,
        PRIMARY KEY (channel, consumer)
      );
      INSERT INTO durability_log_allocations (channel, consumer, allocated_offset)
      SELECT 'default', consumer, allocated_offset
      FROM durability_log_allocations_before_channels;
      DROP TABLE durability_log_allocations_before_channels;
    `,
    down: `
      CREATE TABLE durability_log_lease_channel_guard (
        channel TEXT CONSTRAINT cannot_downgrade_nondefault_channels CHECK (channel = 'default')
      );
      INSERT INTO durability_log_lease_channel_guard
      SELECT channel FROM durability_log_leases
      UNION SELECT channel FROM durability_log_allocations;
      DROP TABLE durability_log_lease_channel_guard;

      ALTER TABLE durability_log_leases RENAME TO durability_log_leases_with_channels;
      CREATE TABLE durability_log_leases (
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
      INSERT INTO durability_log_leases
        (batch_id, consumer, first_offset, last_offset, state, attempt,
         expires_at, created_at)
      SELECT batch_id, consumer, first_offset, last_offset, state, attempt,
        expires_at, created_at
      FROM durability_log_leases_with_channels;
      DROP TABLE durability_log_leases_with_channels;
      CREATE INDEX durability_log_leases_claim_idx
      ON durability_log_leases (consumer, state, expires_at, first_offset);
      CREATE INDEX durability_log_leases_order_idx
      ON durability_log_leases (consumer, first_offset);

      ALTER TABLE durability_log_allocations RENAME TO durability_log_allocations_with_channels;
      CREATE TABLE durability_log_allocations (
        consumer TEXT PRIMARY KEY,
        allocated_offset INTEGER NOT NULL
      );
      INSERT INTO durability_log_allocations (consumer, allocated_offset)
      SELECT consumer, allocated_offset
      FROM durability_log_allocations_with_channels;
      DROP TABLE durability_log_allocations_with_channels;
    `,
  },
] satisfies DurableMigrations;
