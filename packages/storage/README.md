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

Each migration list should use its own namespaced migration-history table when it is applied. This prevents a library's migration state from colliding with application-owned migrations in the same Durable Object database.

`@durability/lint` can enforce that static `CREATE TABLE` statements are declared inside a `DurableMigrations` list.
