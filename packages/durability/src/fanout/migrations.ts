import type { DurableMigrations } from '@durability/storage';

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
  {
    name: 'durability_0017_fanout_channels',
    up: `
      ALTER TABLE durability_fanout_messages
        RENAME TO durability_fanout_messages_before_channels;
      CREATE TABLE durability_fanout_messages (
        key TEXT NOT NULL,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        targets TEXT NOT NULL,
        remaining INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        generation_id TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (channel, key)
      );
      INSERT INTO durability_fanout_messages
        (key, id, payload, targets, remaining, seq, created_at,
         generation_id, channel)
      SELECT key, id, payload, targets, remaining, seq, created_at,
        generation_id, 'default'
      FROM durability_fanout_messages_before_channels;
      DROP TABLE durability_fanout_messages_before_channels;

      ALTER TABLE durability_fanout_deliveries
        RENAME TO durability_fanout_deliveries_before_channels;
      CREATE TABLE durability_fanout_deliveries (
        id TEXT NOT NULL,
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
        dead_letter_reason TEXT CHECK (dead_letter_reason IN ('explicit', 'exhausted')),
        channel TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (channel, id)
      );
      INSERT INTO durability_fanout_deliveries
        (id, message_key, target_id, seq, status, phase, attempt,
         next_attempt_at, last_error, last_error_name, created_at,
         generation_id, dead_lettered_at, dead_letter_reason, channel)
      SELECT id, message_key, target_id, seq, status, phase, attempt,
        next_attempt_at, last_error, last_error_name, created_at,
        generation_id, dead_lettered_at, dead_letter_reason, 'default'
      FROM durability_fanout_deliveries_before_channels;
      DROP TABLE durability_fanout_deliveries_before_channels;
      CREATE INDEX durability_fanout_deliveries_due_idx
      ON durability_fanout_deliveries
        (channel, target_id, phase, status, attempt, seq, next_attempt_at);
      CREATE INDEX durability_fanout_deliveries_pending_idx
      ON durability_fanout_deliveries (phase, status, next_attempt_at);
      CREATE INDEX durability_fanout_deliveries_created_idx
      ON durability_fanout_deliveries (created_at);
      CREATE INDEX durability_fanout_deliveries_channel_pending_idx
      ON durability_fanout_deliveries (channel, status, next_attempt_at);
    `,
    down: `
      CREATE TABLE durability_fanout_channel_guard (
        channel TEXT CONSTRAINT cannot_downgrade_nondefault_channels CHECK (channel = 'default')
      );
      INSERT INTO durability_fanout_channel_guard
      SELECT DISTINCT channel FROM durability_fanout_messages
      UNION SELECT DISTINCT channel FROM durability_fanout_deliveries;
      DROP TABLE durability_fanout_channel_guard;

      ALTER TABLE durability_fanout_messages
        RENAME TO durability_fanout_messages_with_channels;
      CREATE TABLE durability_fanout_messages (
        key TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        payload TEXT NOT NULL,
        targets TEXT NOT NULL,
        remaining INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        generation_id TEXT NOT NULL
      );
      INSERT INTO durability_fanout_messages
      SELECT key, id, payload, targets, remaining, seq, created_at,
        generation_id
      FROM durability_fanout_messages_with_channels;
      DROP TABLE durability_fanout_messages_with_channels;

      ALTER TABLE durability_fanout_deliveries
        RENAME TO durability_fanout_deliveries_with_channels;
      CREATE TABLE durability_fanout_deliveries (
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
      INSERT INTO durability_fanout_deliveries
      SELECT id, message_key, target_id, seq, status, phase, attempt,
        next_attempt_at, last_error, last_error_name, created_at,
        generation_id, dead_lettered_at, dead_letter_reason
      FROM durability_fanout_deliveries_with_channels;
      DROP TABLE durability_fanout_deliveries_with_channels;
      CREATE INDEX durability_fanout_deliveries_due_idx
      ON durability_fanout_deliveries
        (target_id, phase, status, attempt, seq, next_attempt_at);
      CREATE INDEX durability_fanout_deliveries_pending_idx
      ON durability_fanout_deliveries (phase, status, next_attempt_at);
      CREATE INDEX durability_fanout_deliveries_created_idx
      ON durability_fanout_deliveries (created_at);
    `,
  },
] satisfies DurableMigrations;
