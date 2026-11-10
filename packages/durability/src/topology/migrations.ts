import type { DurableMigrations } from '@durability/storage';

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
