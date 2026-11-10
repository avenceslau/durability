import type { DurableMigrations } from '@durability/storage';

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
  {
    name: 'durability_0020_semaphore_channels',
    up: `
      ALTER TABLE durability_semaphore_grants RENAME TO durability_semaphore_grants_before_channels;
      CREATE TABLE durability_semaphore_grants (
        channel TEXT NOT NULL DEFAULT 'default',
        grant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_channel TEXT NOT NULL DEFAULT 'default',
        grp TEXT NOT NULL,
        permits INTEGER NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (channel, grant_id)
      );
      INSERT INTO durability_semaphore_grants
        (channel, grant_id, client_id, client_channel, grp, permits, claimed,
         released, created_at, expires_at)
      SELECT 'default', grant_id, client_id, 'default', grp, permits, claimed,
        released, created_at, expires_at
      FROM durability_semaphore_grants_before_channels;
      DROP TABLE durability_semaphore_grants_before_channels;
      CREATE INDEX durability_semaphore_grants_expires_idx
      ON durability_semaphore_grants (channel, expires_at) WHERE claimed < permits;

      ALTER TABLE durability_semaphore_leases RENAME TO durability_semaphore_leases_before_channels;
      CREATE TABLE durability_semaphore_leases (
        channel TEXT NOT NULL DEFAULT 'default',
        lease_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_channel TEXT NOT NULL DEFAULT 'default',
        grp TEXT NOT NULL,
        permits INTEGER NOT NULL,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        retired INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel, lease_id)
      );
      INSERT INTO durability_semaphore_leases
        (channel, lease_id, client_id, client_channel, grp, permits, released,
         created_at, expires_at, retired)
      SELECT 'default', lease_id, client_id, 'default', grp, permits, released,
        created_at, expires_at, retired
      FROM durability_semaphore_leases_before_channels;
      DROP TABLE durability_semaphore_leases_before_channels;
      CREATE INDEX durability_semaphore_leases_expires_idx
      ON durability_semaphore_leases (channel, expires_at);
    `,
    down: `
      CREATE TABLE durability_semaphore_channel_guard (
        channel TEXT CONSTRAINT cannot_downgrade_nondefault_channels CHECK (channel = 'default')
      );
      INSERT INTO durability_semaphore_channel_guard
      SELECT channel FROM durability_semaphore_grants
      UNION SELECT client_channel FROM durability_semaphore_grants
      UNION SELECT channel FROM durability_semaphore_leases
      UNION SELECT client_channel FROM durability_semaphore_leases;
      DROP TABLE durability_semaphore_channel_guard;

      ALTER TABLE durability_semaphore_grants RENAME TO durability_semaphore_grants_with_channels;
      CREATE TABLE durability_semaphore_grants (
        grant_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        grp TEXT NOT NULL,
        permits INTEGER NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      INSERT INTO durability_semaphore_grants
      SELECT grant_id, client_id, grp, permits, claimed, released, created_at,
        expires_at
      FROM durability_semaphore_grants_with_channels;
      DROP TABLE durability_semaphore_grants_with_channels;
      CREATE INDEX durability_semaphore_grants_expires_idx
      ON durability_semaphore_grants (expires_at) WHERE claimed < permits;

      ALTER TABLE durability_semaphore_leases RENAME TO durability_semaphore_leases_with_channels;
      CREATE TABLE durability_semaphore_leases (
        lease_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        grp TEXT NOT NULL,
        permits INTEGER NOT NULL,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        retired INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO durability_semaphore_leases
      SELECT lease_id, client_id, grp, permits, released, created_at,
        expires_at, retired
      FROM durability_semaphore_leases_with_channels;
      DROP TABLE durability_semaphore_leases_with_channels;
      CREATE INDEX durability_semaphore_leases_expires_idx
      ON durability_semaphore_leases (expires_at);
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
  {
    name: 'durability_0021_semaphore_queue_channels',
    up: `
      ALTER TABLE durability_semaphore_queue_items RENAME TO durability_semaphore_queue_items_before_channels;
      CREATE TABLE durability_semaphore_queue_items (
        channel TEXT NOT NULL DEFAULT 'default',
        id TEXT NOT NULL,
        key TEXT NOT NULL,
        grp TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'claiming', 'admitted')),
        grant_id TEXT,
        lease_id TEXT,
        created_at INTEGER NOT NULL,
        admitted_at INTEGER,
        notified INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        PRIMARY KEY (channel, id)
      );
      INSERT INTO durability_semaphore_queue_items
        (channel, id, key, grp, payload, status, grant_id, lease_id, created_at,
         admitted_at, notified, attempt, next_attempt_at)
      SELECT 'default', id, key, grp, payload, status, grant_id, lease_id,
        created_at, admitted_at, notified, attempt, next_attempt_at
      FROM durability_semaphore_queue_items_before_channels;
      DROP TABLE durability_semaphore_queue_items_before_channels;
      CREATE INDEX durability_semaphore_queue_items_key_idx
      ON durability_semaphore_queue_items (channel, key, status, created_at, id);
      CREATE INDEX durability_semaphore_queue_items_grant_idx
      ON durability_semaphore_queue_items (channel, grant_id, created_at, id);
      CREATE INDEX durability_semaphore_queue_items_notify_idx
      ON durability_semaphore_queue_items (channel, next_attempt_at)
      WHERE status = 'admitted' AND notified = 0;

      ALTER TABLE durability_semaphore_queue_grants RENAME TO durability_semaphore_queue_grants_before_channels;
      CREATE TABLE durability_semaphore_queue_grants (
        channel TEXT NOT NULL DEFAULT 'default',
        grant_id TEXT NOT NULL,
        key TEXT NOT NULL,
        grp TEXT NOT NULL,
        permits INTEGER NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0,
        confirmed INTEGER NOT NULL DEFAULT 0,
        admitted INTEGER NOT NULL DEFAULT 0,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (channel, grant_id)
      );
      INSERT INTO durability_semaphore_queue_grants
        (channel, grant_id, key, grp, permits, claimed, confirmed, admitted,
         released, created_at)
      SELECT 'default', grant_id, key, grp, permits, claimed, confirmed,
        admitted, released, created_at
      FROM durability_semaphore_queue_grants_before_channels;
      DROP TABLE durability_semaphore_queue_grants_before_channels;
      CREATE INDEX durability_semaphore_queue_grants_key_idx
      ON durability_semaphore_queue_grants (channel, key, created_at);

      ALTER TABLE durability_semaphore_queue_keys RENAME TO durability_semaphore_queue_keys_before_channels;
      CREATE TABLE durability_semaphore_queue_keys (
        channel TEXT NOT NULL DEFAULT 'default',
        key TEXT NOT NULL,
        next_request_at INTEGER NOT NULL,
        queued INTEGER NOT NULL,
        PRIMARY KEY (channel, key)
      );
      INSERT INTO durability_semaphore_queue_keys
        (channel, key, next_request_at, queued)
      SELECT 'default', key, next_request_at, queued
      FROM durability_semaphore_queue_keys_before_channels;
      DROP TABLE durability_semaphore_queue_keys_before_channels;
      CREATE INDEX durability_semaphore_queue_keys_due_idx
      ON durability_semaphore_queue_keys (channel, next_request_at) WHERE queued > 0;

      ALTER TABLE durability_semaphore_queue_leases RENAME TO durability_semaphore_queue_leases_before_channels;
      CREATE TABLE durability_semaphore_queue_leases (
        channel TEXT NOT NULL DEFAULT 'default',
        lease_id TEXT NOT NULL,
        key TEXT NOT NULL,
        grp TEXT NOT NULL,
        permits INTEGER NOT NULL,
        drawn INTEGER NOT NULL DEFAULT 0,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        renew_at INTEGER NOT NULL DEFAULT 0,
        renew_ms INTEGER NOT NULL DEFAULT 30000,
        confirmed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel, lease_id)
      );
      INSERT INTO durability_semaphore_queue_leases
        (channel, lease_id, key, grp, permits, drawn, released, created_at,
         expires_at, renew_at, renew_ms, confirmed)
      SELECT 'default', lease_id, key, grp, permits, drawn, released,
        created_at, expires_at, renew_at, renew_ms, confirmed
      FROM durability_semaphore_queue_leases_before_channels;
      DROP TABLE durability_semaphore_queue_leases_before_channels;
      CREATE INDEX durability_semaphore_queue_leases_key_idx
      ON durability_semaphore_queue_leases (channel, key, created_at);
    `,
    down: `
      CREATE TABLE durability_semaphore_queue_channel_guard (
        channel TEXT CONSTRAINT cannot_downgrade_nondefault_channels CHECK (channel = 'default')
      );
      INSERT INTO durability_semaphore_queue_channel_guard
      SELECT channel FROM durability_semaphore_queue_items
      UNION SELECT channel FROM durability_semaphore_queue_grants
      UNION SELECT channel FROM durability_semaphore_queue_keys
      UNION SELECT channel FROM durability_semaphore_queue_leases;
      DROP TABLE durability_semaphore_queue_channel_guard;

      ALTER TABLE durability_semaphore_queue_items RENAME TO durability_semaphore_queue_items_with_channels;
      CREATE TABLE durability_semaphore_queue_items (
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
        next_attempt_at INTEGER NOT NULL,
        lease_id TEXT
      );
      INSERT INTO durability_semaphore_queue_items
        (id, key, grp, payload, status, grant_id, created_at, admitted_at,
         notified, attempt, next_attempt_at, lease_id)
      SELECT id, key, grp, payload, status, grant_id, created_at, admitted_at,
        notified, attempt, next_attempt_at, lease_id
      FROM durability_semaphore_queue_items_with_channels;
      DROP TABLE durability_semaphore_queue_items_with_channels;
      CREATE INDEX durability_semaphore_queue_items_key_idx
      ON durability_semaphore_queue_items (key, status, created_at, id);
      CREATE INDEX durability_semaphore_queue_items_grant_idx
      ON durability_semaphore_queue_items (grant_id, created_at, id);
      CREATE INDEX durability_semaphore_queue_items_notify_idx
      ON durability_semaphore_queue_items (next_attempt_at)
      WHERE status = 'admitted' AND notified = 0;

      ALTER TABLE durability_semaphore_queue_grants RENAME TO durability_semaphore_queue_grants_with_channels;
      CREATE TABLE durability_semaphore_queue_grants (
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
      INSERT INTO durability_semaphore_queue_grants
      SELECT grant_id, key, grp, permits, claimed, confirmed, admitted,
        released, created_at
      FROM durability_semaphore_queue_grants_with_channels;
      DROP TABLE durability_semaphore_queue_grants_with_channels;
      CREATE INDEX durability_semaphore_queue_grants_key_idx
      ON durability_semaphore_queue_grants (key, created_at);

      ALTER TABLE durability_semaphore_queue_keys RENAME TO durability_semaphore_queue_keys_with_channels;
      CREATE TABLE durability_semaphore_queue_keys (
        key TEXT PRIMARY KEY,
        next_request_at INTEGER NOT NULL,
        queued INTEGER NOT NULL
      );
      INSERT INTO durability_semaphore_queue_keys
      SELECT key, next_request_at, queued
      FROM durability_semaphore_queue_keys_with_channels;
      DROP TABLE durability_semaphore_queue_keys_with_channels;
      CREATE INDEX durability_semaphore_queue_keys_due_idx
      ON durability_semaphore_queue_keys (next_request_at) WHERE queued > 0;

      ALTER TABLE durability_semaphore_queue_leases RENAME TO durability_semaphore_queue_leases_with_channels;
      CREATE TABLE durability_semaphore_queue_leases (
        lease_id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        grp TEXT NOT NULL,
        permits INTEGER NOT NULL,
        drawn INTEGER NOT NULL DEFAULT 0,
        released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        renew_at INTEGER NOT NULL DEFAULT 0,
        renew_ms INTEGER NOT NULL DEFAULT 30000,
        confirmed INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO durability_semaphore_queue_leases
      SELECT lease_id, key, grp, permits, drawn, released, created_at,
        expires_at, renew_at, renew_ms, confirmed
      FROM durability_semaphore_queue_leases_with_channels;
      DROP TABLE durability_semaphore_queue_leases_with_channels;
      CREATE INDEX durability_semaphore_queue_leases_key_idx
      ON durability_semaphore_queue_leases (key, created_at);
    `,
  },
] satisfies DurableMigrations;
