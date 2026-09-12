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
    "durability/durability-migrations-only": "error",
    "durability/transform-next-once": "error"
  }
}
```

## `alarm-runner-only`

A class holding a `Durability`, `DurabilityAlarms`, `DurabilityFanout`, or `DurabilityScheduler` instance must delegate its alarm method directly to that instance's alarm handler. Additional alarm work can replace or delay the single Durable Object alarm that durability owns.

```ts
class ImageJobs extends DurableObject<Env> {
  private readonly durability = new Durability({ context: this.ctx, handlers });

  alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }
}
```

When several helpers share a `DurabilityScheduler`, delegate to the scheduler instead.

## `transform-next-once`

Each transform handler may contain one call site for its `next` function. Multiple call sites are rejected conservatively, even when they appear in mutually exclusive branches, because later edits can make both paths execute. A single call site may still execute repeatedly when placed in a loop or repeatedly invoked callback, so intentional retry transforms remain the author's responsibility.

```ts
const invalid = defineTransform().caller((_options) => async ({ next }) => {
  await next();
  return next();
});
```

Caller and callee handlers are checked separately. The rule supports inline context-style access such as `transformContext.next()`, renamed destructured bindings such as `{ next: proceed }`, simple aliases, and calls from nested closures. Unrelated bindings that shadow the transform's `next` function are ignored. Because Oxlint plugins do not receive TypeScript type information, separately declared handlers are recognized by a destructured `next` property in their first parameter.

## `durability-migrations-only`

Every static `CREATE TABLE`, `CREATE TEMP TABLE`, or `CREATE TEMPORARY TABLE` statement must live in a migration list typed with `DurableMigrations`. Keywords are matched case-insensitively across whitespace. The rule supports explicit annotations, `satisfies`, and aliased type imports from `@durability/storage`.

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

Static analysis covers string literals, template literals whose substitutions are themselves static strings, and nested `+` concatenations of those expressions. The outermost static expression is reported once. Expressions containing identifiers, calls, or other values that cannot be resolved without executing the program are ignored.

The rule also requires `DOQB` migration builders imported from `workers-qb` to use the namespaced migration-history table:

```ts
const builder = new DOQB(this.ctx.storage.sql).migrations({
  migrations,
  tableName: 'durability_migrations',
});
```

Imported `DOQB` aliases, direct construction, local builder variables, and public or private class fields used through `this` are recognized. Simple assignments are followed only when every write can be proven to originate from the imported constructor. Lexically shadowed and unrelated same-name values are ignored.
