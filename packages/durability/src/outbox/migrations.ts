import type { DurableMigrations } from '@durability/storage';

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
