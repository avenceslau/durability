import type { DurableMigrations } from '@durability/storage';

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
