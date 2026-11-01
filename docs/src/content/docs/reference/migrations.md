---
title: Storage and migrations
description: Storage and migrations for durable capabilities.
---

## Storage

Durability stores its records in the object's SQLite database. Configure the Durable Object class with `new_sqlite_classes`:

```jsonc
{
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ImageJobs"] }],
}
```

`Durability` creates and migrates `durability_calls`; `DurabilityAlarms` does the same for `durability_alarms`. Both also create `durability_memos`, which they share. All histories are tracked in the shared `durability_migrations` table and only the constructed helpers' tables exist. Reverting either helper's schema leaves `durability_memos` in place for the other.

### Explicit migrations

Rollbacks are explicit because reverting the initial migration deletes records:

```ts
import { Durability, DurabilityAlarms } from 'durability';

Durability.migrate(this.ctx, 'durability_0001_create_calls');
Durability.migrate(this.ctx, null); // remove the operations schema entirely
DurabilityAlarms.migrate(this.ctx, null); // remove the named alarm schema
```

Passing a name moves that capability's schema to exactly that version. Each batch of migrations applies or reverts in one synchronous transaction, so a failure leaves the schema untouched.

Every history row stores its migration's `down` script. If a Durable Object later runs an older `durability` version, that version reverts the migrations it does not recognize using the stored scripts, so downgrades are safe without code changes. To guard against deploying a very old version by mistake, at most two unknown migrations are reverted; beyond that, construction throws. The `durability_migrations` table is dropped once no durability history remains.

### Application schemas

`migrate` gives an application's own tables the same guarantees. Its history lives in a separate table (`schema_migrations` unless `table` is set), so it never mixes with durability's:

```ts
import { DurableObject } from 'cloudflare:workers';
import { migrate, type DurableMigrations } from 'durability';

const migrations: DurableMigrations = [
  {
    name: '0001_create_jobs',
    up: 'CREATE TABLE jobs (id TEXT PRIMARY KEY);',
    down: 'DROP TABLE jobs;',
  },
];

export class Jobs extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, migrations);
  }
}
```

Pass `target` to move to a named migration, or `null` to revert every migration and drop the history table.
