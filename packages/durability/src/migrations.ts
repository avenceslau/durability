import type { DurableMigrations } from '@durability/storage';
import { z } from 'zod';
import { traceStorage } from './dev.js';

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

/**
 * Ordered SQLite migrations for `durability_memos`, the memoized results that
 * {@link Durability} and {@link DurabilityAlarms} share. Applied by whichever
 * helper is constructed first.
 */
export const durabilityMemoMigrations = [
  {
    name: 'durability_0012_create_memos',
    up: `
      CREATE TABLE IF NOT EXISTS durability_memos (
        owner TEXT NOT NULL,
        key TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        memo_key TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (owner, key, generation_id, memo_key)
      );
    `,
    down: 'DROP TABLE IF EXISTS durability_memos;',
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
 * Ordered SQLite migrations for the outbound event log owned by
 * {@link DurabilitySocket}. Applied automatically on construction.
 */
export const durabilitySocketMigrations = [
  {
    name: 'durability_0006_create_socket_events',
    up: `
      CREATE TABLE IF NOT EXISTS durability_socket_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
    down: 'DROP TABLE IF EXISTS durability_socket_events;',
  },
] satisfies DurableMigrations;

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

/**
 * Ordered SQLite migrations for outbox channels. Applied automatically on
 * construction.
 */
export const durabilityOutboxMigrations = [
  {
    name: 'durability_0006_create_outbox',
    up: `
      CREATE TABLE IF NOT EXISTS durability_outbox (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending')),
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        last_error_name TEXT,
        created_at INTEGER NOT NULL,
        generation_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durability_outbox_due_idx
      ON durability_outbox (channel, status, next_attempt_at, version);
      CREATE INDEX IF NOT EXISTS durability_outbox_pending_idx
      ON durability_outbox (status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS durability_outbox_created_idx
      ON durability_outbox (created_at);
      CREATE TABLE IF NOT EXISTS durability_outbox_seq (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO durability_outbox_seq (id, next_version) VALUES (1, 1);
    `,
    down: `
      DROP INDEX IF EXISTS durability_outbox_due_idx;
      DROP INDEX IF EXISTS durability_outbox_pending_idx;
      DROP INDEX IF EXISTS durability_outbox_created_idx;
      DROP TABLE IF EXISTS durability_outbox;
      DROP TABLE IF EXISTS durability_outbox_seq;
    `,
  },
] satisfies DurableMigrations;

/**
 * Ordered SQLite migrations for semaphore grants. Applied automatically on
 * construction.
 */
export const durabilitySemaphoreMigrations = [
  {
    name: 'durability_0007_create_semaphore',
    up: `
      CREATE TABLE IF NOT EXISTS durability_semaphore_grants (
        grant_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        grp TEXT NOT NULL,
        permits INTEGER NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durability_semaphore_grants_expires_idx
      ON durability_semaphore_grants (expires_at) WHERE claimed < permits;
    `,
    down: `
      DROP INDEX IF EXISTS durability_semaphore_grants_expires_idx;
      DROP TABLE IF EXISTS durability_semaphore_grants;
    `,
  },
  {
    name: 'durability_0009_create_semaphore_leases',
    up: `
      CREATE TABLE IF NOT EXISTS durability_semaphore_leases (
        lease_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        grp TEXT NOT NULL,
        permits INTEGER NOT NULL,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        retired INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS durability_semaphore_leases_expires_idx
      ON durability_semaphore_leases (expires_at);
    `,
    down: `
      DROP INDEX IF EXISTS durability_semaphore_leases_expires_idx;
      DROP TABLE IF EXISTS durability_semaphore_leases;
    `,
  },
] satisfies DurableMigrations;

/**
 * Ordered SQLite migrations for a semaphore client's queue. Applied
 * automatically on construction.
 */
export const durabilitySemaphoreQueueMigrations = [
  {
    name: 'durability_0008_create_semaphore_queue',
    up: `
      CREATE TABLE IF NOT EXISTS durability_semaphore_queue_items (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        grp TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'claiming', 'admitted')),
        grant_id TEXT,
        created_at INTEGER NOT NULL,
        admitted_at INTEGER,
        notified INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durability_semaphore_queue_items_key_idx
      ON durability_semaphore_queue_items (key, status, created_at, id);
      CREATE INDEX IF NOT EXISTS durability_semaphore_queue_items_grant_idx
      ON durability_semaphore_queue_items (grant_id, created_at, id);
      CREATE INDEX IF NOT EXISTS durability_semaphore_queue_items_notify_idx
      ON durability_semaphore_queue_items (next_attempt_at)
      WHERE status = 'admitted' AND notified = 0;
      CREATE TABLE IF NOT EXISTS durability_semaphore_queue_grants (
        grant_id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        grp TEXT NOT NULL,
        permits INTEGER NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0,
        confirmed INTEGER NOT NULL DEFAULT 0,
        admitted INTEGER NOT NULL DEFAULT 0,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durability_semaphore_queue_grants_key_idx
      ON durability_semaphore_queue_grants (key, created_at);
      CREATE TABLE IF NOT EXISTS durability_semaphore_queue_keys (
        key TEXT PRIMARY KEY,
        next_request_at INTEGER NOT NULL,
        queued INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durability_semaphore_queue_keys_due_idx
      ON durability_semaphore_queue_keys (next_request_at) WHERE queued > 0;
    `,
    down: `
      DROP INDEX IF EXISTS durability_semaphore_queue_keys_due_idx;
      DROP TABLE IF EXISTS durability_semaphore_queue_keys;
      DROP INDEX IF EXISTS durability_semaphore_queue_grants_key_idx;
      DROP TABLE IF EXISTS durability_semaphore_queue_grants;
      DROP INDEX IF EXISTS durability_semaphore_queue_items_notify_idx;
      DROP INDEX IF EXISTS durability_semaphore_queue_items_grant_idx;
      DROP INDEX IF EXISTS durability_semaphore_queue_items_key_idx;
      DROP TABLE IF EXISTS durability_semaphore_queue_items;
    `,
  },
  {
    name: 'durability_0010_add_semaphore_queue_leases',
    up: `
      ALTER TABLE durability_semaphore_queue_items ADD COLUMN lease_id TEXT;
      CREATE TABLE IF NOT EXISTS durability_semaphore_queue_leases (
        lease_id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        grp TEXT NOT NULL,
        permits INTEGER NOT NULL,
        drawn INTEGER NOT NULL DEFAULT 0,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durability_semaphore_queue_leases_key_idx
      ON durability_semaphore_queue_leases (key, created_at);
    `,
    down: `
      DROP INDEX IF EXISTS durability_semaphore_queue_leases_key_idx;
      DROP TABLE IF EXISTS durability_semaphore_queue_leases;
      ALTER TABLE durability_semaphore_queue_items DROP COLUMN lease_id;
    `,
  },
  {
    name: 'durability_0011_renew_semaphore_queue_leases',
    up: `
      ALTER TABLE durability_semaphore_queue_leases ADD COLUMN renew_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE durability_semaphore_queue_leases ADD COLUMN renew_ms INTEGER NOT NULL DEFAULT 30000;
      ALTER TABLE durability_semaphore_queue_leases ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;
    `,
    down: `
      ALTER TABLE durability_semaphore_queue_leases DROP COLUMN confirmed;
      ALTER TABLE durability_semaphore_queue_leases DROP COLUMN renew_ms;
      ALTER TABLE durability_semaphore_queue_leases DROP COLUMN renew_at;
    `,
  },
] satisfies DurableMigrations;

/**
 * Ordered SQLite migrations for the experimental topology coordinator.
 * Publication and sync ride on outbox channels. Applied automatically on
 * construction.
 */
export const durabilityTopologyMigrations = [
  {
    name: 'durability_0011_create_topology',
    up: `
      CREATE TABLE IF NOT EXISTS durability_topology_groups (
        group_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        members TEXT NOT NULL,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS durability_topology_states (
        group_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (group_id, channel)
      );
      CREATE TABLE IF NOT EXISTS durability_topology_writes (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        land_by INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS durability_topology_writes_group_idx
      ON durability_topology_writes (group_id, land_by);
    `,
    down: `
      DROP INDEX IF EXISTS durability_topology_writes_group_idx;
      DROP TABLE IF EXISTS durability_topology_writes;
      DROP TABLE IF EXISTS durability_topology_states;
      DROP TABLE IF EXISTS durability_topology_groups;
    `,
  },
  {
    // `owner_channel` is the topology instance; the existing `channel` column
    // of durability_topology_states stays the state name.
    name: 'durability_0022_topology_channels',
    up: `
      ALTER TABLE durability_topology_groups RENAME TO durability_topology_groups_before_channels;
      CREATE TABLE durability_topology_groups (
        group_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        members TEXT NOT NULL,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        updated_at INTEGER NOT NULL,
        owner_channel TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (owner_channel, group_id)
      );
      INSERT INTO durability_topology_groups
        (group_id, version, members, deleted, updated_at, owner_channel)
      SELECT group_id, version, members, deleted, updated_at, 'default'
      FROM durability_topology_groups_before_channels;
      DROP TABLE durability_topology_groups_before_channels;

      ALTER TABLE durability_topology_states RENAME TO durability_topology_states_before_channels;
      CREATE TABLE durability_topology_states (
        group_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        value TEXT NOT NULL,
        owner_channel TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (owner_channel, group_id, channel)
      );
      INSERT INTO durability_topology_states
        (group_id, channel, value, owner_channel)
      SELECT group_id, channel, value, 'default'
      FROM durability_topology_states_before_channels;
      DROP TABLE durability_topology_states_before_channels;

      ALTER TABLE durability_topology_writes RENAME TO durability_topology_writes_before_channels;
      CREATE TABLE durability_topology_writes (
        id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        land_by INTEGER NOT NULL,
        owner_channel TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (owner_channel, id)
      );
      INSERT INTO durability_topology_writes
        (id, group_id, land_by, owner_channel)
      SELECT id, group_id, land_by, 'default'
      FROM durability_topology_writes_before_channels;
      DROP TABLE durability_topology_writes_before_channels;
      CREATE INDEX durability_topology_writes_group_idx
      ON durability_topology_writes (owner_channel, group_id, land_by);
    `,
    down: `
      CREATE TABLE durability_topology_channel_guard (
        owner_channel TEXT CONSTRAINT cannot_downgrade_nondefault_channels CHECK (owner_channel = 'default')
      );
      INSERT INTO durability_topology_channel_guard
      SELECT owner_channel FROM durability_topology_groups
      UNION SELECT owner_channel FROM durability_topology_states
      UNION SELECT owner_channel FROM durability_topology_writes;
      DROP TABLE durability_topology_channel_guard;

      ALTER TABLE durability_topology_groups RENAME TO durability_topology_groups_with_channels;
      CREATE TABLE durability_topology_groups (
        group_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        members TEXT NOT NULL,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
      INSERT INTO durability_topology_groups
      SELECT group_id, version, members, deleted, updated_at
      FROM durability_topology_groups_with_channels;
      DROP TABLE durability_topology_groups_with_channels;

      ALTER TABLE durability_topology_states RENAME TO durability_topology_states_with_channels;
      CREATE TABLE durability_topology_states (
        group_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (group_id, channel)
      );
      INSERT INTO durability_topology_states
      SELECT group_id, channel, value
      FROM durability_topology_states_with_channels;
      DROP TABLE durability_topology_states_with_channels;

      ALTER TABLE durability_topology_writes RENAME TO durability_topology_writes_with_channels;
      CREATE TABLE durability_topology_writes (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        land_by INTEGER NOT NULL
      );
      INSERT INTO durability_topology_writes
      SELECT id, group_id, land_by
      FROM durability_topology_writes_with_channels;
      DROP TABLE durability_topology_writes_with_channels;
      CREATE INDEX durability_topology_writes_group_idx
      ON durability_topology_writes (group_id, land_by);
    `,
  },
] satisfies DurableMigrations;

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
  return historyRowSchema.array().parse(
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

const currentRowSchema = z.object({
  name: z.string(),
  down: z.string().nullable(),
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
  let rows: z.infer<typeof currentRowSchema>[];
  try {
    rows = currentRowSchema
      .array()
      .parse(
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

  const remaining = z
    .object({ count: z.number().int() })
    .parse(
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
