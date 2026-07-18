# @durability/storage

Shared migration types for Cloudflare Durable Object SQLite storage.

## Install

```sh
npm install @durability/storage
```

## Define reversible migrations

`DurableMigrations` requires stable migration names and both directions of every schema change. Explicit down migrations allow durability helpers to move a Durable Object database to a requested schema target.

```ts
import type { DurableMigrations } from '@durability/storage';

export const migrations = [
  {
    name: '0001_create_jobs',
    up: `
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
    `,
    down: 'DROP TABLE jobs;',
  },
] satisfies DurableMigrations;
```

Each helper should choose and explicitly pass a package-specific migration-history table when applying a migration list. Do not share a generic `migrations` table or assume every helper uses `durability_migrations`:

```ts
new DOQB(storage.sql).migrations({
  migrations,
  tableName: 'queue_schema_migrations',
});
```

A package-specific name prevents helper migration state from colliding with application-owned migrations or another helper in the same Durable Object database. `@durability/lint` enforces the `DurableMigrations` declaration and a static migration-history identifier ending in `_migrations`; it cannot prove that the prefix is unique.
