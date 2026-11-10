import type { DurableMigrations } from '@durability/storage';

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
  {
    // Each channel numbers its own events, so existing events keep their
    // sequence numbers on the default channel.
    name: 'durability_0023_socket_channels',
    up: `
      ALTER TABLE durability_socket_events RENAME TO durability_socket_events_before_channels;
      CREATE TABLE durability_socket_events (
        seq INTEGER NOT NULL,
        name TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        channel TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (channel, seq)
      );
      INSERT INTO durability_socket_events (seq, name, payload, created_at, channel)
      SELECT seq, name, payload, created_at, 'default'
      FROM durability_socket_events_before_channels;
      DROP TABLE durability_socket_events_before_channels;
    `,
    down: `
      CREATE TABLE durability_socket_events_channel_guard (
        channel TEXT CONSTRAINT cannot_downgrade_nondefault_channels CHECK (channel = 'default')
      );
      INSERT INTO durability_socket_events_channel_guard
      SELECT DISTINCT channel FROM durability_socket_events;
      DROP TABLE durability_socket_events_channel_guard;
      ALTER TABLE durability_socket_events RENAME TO durability_socket_events_with_channels;
      CREATE TABLE durability_socket_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO durability_socket_events (seq, name, payload, created_at)
      SELECT seq, name, payload, created_at
      FROM durability_socket_events_with_channels;
      DROP TABLE durability_socket_events_with_channels;
    `,
  },
] satisfies DurableMigrations;
