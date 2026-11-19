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
    "durability/abort-after-sync": "error",
    "durability/alarm-runner-only": "error",
    "durability/durability-migrations-only": "error",
    "durability/no-alarm-changes-in-alarm-handler": "error",
    "durability/no-deferred-storage-writes": "error",
    "durability/transaction-sync-callback": "error",
    "durability/transform-next-once": "error"
  }
}
```

## `abort-after-sync`

`ctx.abort()` resets the Durable Object before its pending storage writes are flushed, and those writes are discarded. That includes `put()`, `delete()`, `setAlarm()`, `deleteAlarm()`, synchronous `kv` and SQL writes, `transactionSync()`, and `put()` calls that were awaited, because awaiting a write does not wait for it to be flushed. Awaiting a storage read or yielding a microtask does not flush writes either. The statement directly before every `abort()` on a `ctx` or `state` receiver must await that object's `storage.sync()`:

```ts
async reset() {
  await this.ctx.storage.sync();
  this.ctx.abort('reset');
}
```

Writes made after `sync()` resolves are not covered, so anything between the two statements, an abort inside a callback such as `queueMicrotask(() => this.ctx.abort())`, and an abort in a branch after the `sync()` are rejected. Abort calls on other receivers, such as `AbortController`, are ignored.

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

When several helpers share a `DurabilityScheduler`, delegate to the scheduler instead. Helpers imported from `durability` under another name (`import { Durability as Jobs }`) or through a namespace import (`new durability.Durability(...)`) are recognized too.

## `no-alarm-changes-in-alarm-handler`

A failing `alarm()` is retried with backoff. Calling `setAlarm()` or `deleteAlarm()` inside the handler replaces that retry: an error thrown afterwards is not retried before the new alarm time, an earlier alarm reruns the handler as a fresh alarm with no backoff and no retry limit, and after `deleteAlarm()` the failed run never happens again. Every `setAlarm()` and `deleteAlarm()` call inside an `alarm` method or class field is rejected, including calls on a transaction handle. Schedule follow-up work through durability instead:

```ts
class Reports extends DurableObject<Env> {
  private readonly durability = new Durability({ context: this.ctx, handlers });

  alarm(info?: AlarmInvocationInfo) {
    return this.durability.alarm(info);
  }
}
```

The rule checks calls written inside the handler; a helper method called from it is not followed.

## `no-deferred-storage-writes`

The output gate holds a response until the storage writes issued before it are stored. A write that starts later, in work the request does not await, is not covered: the caller is told the request succeeded, and the write is lost if the object resets first, for example during a deploy or an eviction. The rule rejects storage writes (`put()`, `delete()`, `deleteAll()`, `setAlarm()`, `deleteAlarm()`, `transaction()`, `transactionSync()`, `kv.put()`, `kv.delete()` and `sql.exec()` other than a static `SELECT`) in:

- `setTimeout()` and `setInterval()` callbacks;
- `.then()`, `.catch()` and `.finally()` callbacks on a promise that is discarded with `void`, left as a statement, or passed to `waitUntil()`;
- an async function invoked in place and discarded the same way, when the write comes after any `await` in it.

```ts
this.ctx.waitUntil(
  (async () => {
    const result = await this.env.RENDERER.render(job);
    await this.ctx.storage.put('result', result); // rejected
  })()
);
```

A write issued before the request returns is held by the output gate even when it is not awaited, so `void this.ctx.storage.put('job', job)` and `this.ctx.waitUntil(this.ctx.storage.put('job', job))` are accepted. Await the work, or store what is needed before responding and finish the work from an alarm. Best-effort writes that may be lost can be exempted with an `oxlint-disable-next-line` comment. Storage is recognised by a receiver named `storage`, and writes inside a separately declared function or method that is called without being awaited are not followed.

## `transaction-sync-callback`

`transactionSync()` commits when its callback returns. An async callback returns at its first `await`: the statements before it are committed, the rest run outside the transaction, and a later error rolls nothing back. The rule rejects an `async` function passed to `transactionSync()`.

```ts
this.ctx.storage.transactionSync(() => {
  this.ctx.storage.sql.exec('UPDATE jobs SET state = ?', 'done');
});
```

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

Every static `CREATE TABLE`, `CREATE TEMP TABLE`, or `CREATE TEMPORARY TABLE` statement must live in a migration list typed with `DurableMigrations`. Keywords are matched case-insensitively across whitespace. The rule supports explicit annotations, `satisfies`, and aliased type imports from `durability` or `@durability/storage`.

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
