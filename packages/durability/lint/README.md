# @durability/lint

Oxlint rules for Cloudflare Durable Object durability integrations.

## Install

```sh
npm install --save-dev oxlint @durability/lint
```

## Configure

Add the JavaScript plugin and enable the rules in `.oxlintrc.json`:

```json
{
  "jsPlugins": [{ "name": "durability", "specifier": "@durability/lint" }],
  "rules": {
    "durability/alarm-runner-only": "error",
    "durability/durability-migrations-only": "error"
  }
}
```

## `alarm-runner-only`

A class using `createDurability` must delegate its alarm method directly to the generated alarm handler. Additional alarm work can replace or delay the single Durable Object alarm that durability owns.

```ts
class ImageJobs extends DurableObject<Env> {
  private readonly durability = createDurability(this.ctx, handlers);

  alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }
}
```

## `durability-migrations-only`

Every static `CREATE TABLE` statement must live in a migration list typed with `DurableMigrations`. The rule supports explicit annotations, `satisfies`, and aliased type imports.

```ts
import type { DurableMigrations } from '@durability/storage';

const migrations = [
  {
    name: '0001_create_jobs',
    up: 'CREATE TABLE jobs (id TEXT PRIMARY KEY);',
    down: 'DROP TABLE jobs;',
  },
] satisfies DurableMigrations;
```

Raw table creation is rejected:

```ts
this.ctx.storage.sql.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY);');
```

The rule also requires `DOQB` migration builders imported from `workers-qb` to use the namespaced migration-history table:

```ts
const builder = new DOQB(this.ctx.storage.sql).migrations({
  migrations,
  tableName: 'durability_migrations',
});
```

Unrelated APIs with a method named `migrations` are ignored.
