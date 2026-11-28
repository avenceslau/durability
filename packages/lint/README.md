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
    "durability/no-alarm-changes-in-constructor": "error",
    "durability/no-delete-all-in-transaction": "error",
    "durability/no-deferred-storage-writes": "error",
    "durability/transaction-sync-callback": "error",
    "durability/transform-next-once": "error"
  }
}
```

## Called functions

Rules that check what runs in a place, such as the constructor, `alarm()` or a transaction callback, also follow the functions called there, through any number of calls: methods of the same class called through `this`, including function-valued fields, and functions declared in the same file. The call written in that place is reported. Inherited methods, functions imported from another file and functions passed around as values are not followed.

## `abort-after-sync`

`ctx.abort()` resets the Durable Object before its pending storage writes are flushed, and those writes are discarded. That includes `put()`, `delete()`, `setAlarm()`, `deleteAlarm()`, synchronous `kv` and SQL writes, `transactionSync()`, and `put()` calls that were awaited, because awaiting a write does not wait for it to be flushed. Awaiting a storage read or yielding a microtask does not flush writes either. The statement directly before every `abort()` on a `ctx` or `state` receiver must await that object's `storage.sync()`:

```ts
async reset() {
  await this.ctx.storage.sync();
  this.ctx.abort('reset');
}
```

The statement before `abort()` may also await a [called function](#called-functions) whose last statement awaits that `sync()`. Writes made after `sync()` resolves are not covered, so anything between the two statements, an abort inside a callback such as `queueMicrotask(() => this.ctx.abort())`, and an abort in a branch after the `sync()` are rejected. Abort calls on other receivers, such as `AbortController`, are ignored.

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

A `setAlarm()` or `deleteAlarm()` reached through a [function declared outside the class](#called-functions) is rejected too. When several helpers share a `DurabilityScheduler`, delegate to the scheduler instead. Helpers imported from `durability` under another name (`import { Durability as Jobs }`) or through a namespace import (`new durability.Durability(...)`) are recognized too.

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

[Functions called from the handler](#called-functions) are followed, and the call that leads to the alarm change is reported.

## `no-alarm-changes-in-constructor`

The constructor runs every time the object is loaded: after an eviction, a deploy or a reset, and to deliver an alarm. A Durable Object has one alarm, so a constructor that calls `setAlarm()` or `deleteAlarm()` replaces or removes whatever was pending, such as the retry of a failed run or the alarm durability scheduled, on every load. Scheduling through durability there repeats the work on every load too: it moves the object's alarm, and a named alarm or schedule set there replaces its pending occurrence each time, so it may never fire.

The rule rejects, in a constructor and in instance field initializers:

- `setAlarm()` and `deleteAlarm()` on any receiver, including a transaction handle;
- durability calls that schedule work: `Durability` and `DurabilityAlarms` handler methods, `purgeBefore()`, a named alarm's `cancel()`, and `alarm()` on every helper, `DurabilityFanout.enqueue()`, `DurabilityOutbox.stage()`, `DurabilitySchedule.set()`, `reschedule()` and `cancel()`, `DurabilityTopology.update()` and `delete()`, `DurabilitySemaphore.handle()`, and `DurabilitySemaphoreQueue.enqueue()`, `release()` and `cancel()`.

Code that runs as part of the constructor counts: callbacks passed to `blockConcurrencyWhile()`, functions invoked in place, and `.then()`, `.catch()` and `.finally()` callbacks. Handlers and listeners declared there run later and are not checked. Constructing a helper, registering a `lifecycle()` listener and reads such as `getResult()` are accepted. Schedule from the request that creates the work instead:

```ts
class Subscription extends DurableObject<Env> {
  private readonly alarms = new DurabilityAlarms({
    context: this.ctx,
    handlers,
  });

  subscribe(at: number) {
    return this.alarms.renew(at);
  }

  alarm(info?: AlarmInvocationInfo) {
    return this.alarms.alarm(info);
  }
}
```

Helpers are recognized as class fields, `this` fields assigned in the constructor and local variables created with `new`, under imported aliases too. [Functions called during construction](#called-functions) are followed, and the call in the constructor is reported.

## `no-delete-all-in-transaction`

`deleteAll()` cannot be part of a transaction. Inside `transaction()`, through `ctx.storage` or the transaction handle, it rejects with `Cannot call deleteAll() within a transaction`. Inside `transactionSync()` it runs immediately, outside the transaction: the call fails with an internal error, but the data, the alarm and the SQL tables stay deleted even when the callback throws. The rule rejects `deleteAll()` anywhere inside a `transaction()` or `transactionSync()` callback. Call it before or after the transaction:

```ts
await this.ctx.storage.deleteAll();
await this.ctx.storage.transaction(async (txn) => {
  await txn.put('state', 'empty');
});
```

A `deleteAll()` reached through a [function called in the callback](#called-functions) is rejected too. Writing after `deleteAll()` outside a transaction works. SQLite-backed objects lose their tables, so recreate the schema before inserting again.

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

A write issued before the request returns is held by the output gate even when it is not awaited, so `void this.ctx.storage.put('job', job)` and `this.ctx.waitUntil(this.ctx.storage.put('job', job))` are accepted. Await the work, or store what is needed before responding and finish the work from an alarm. Best-effort writes that may be lost can be exempted with an `oxlint-disable-next-line` comment. Storage is recognised by a receiver named `storage`. [Called functions](#called-functions) are followed: a call from deferred work to a function that writes is rejected, and so is a dropped call, such as `void this.save()`, to an async function that writes after an await.

## `transaction-sync-callback`

`transactionSync()` commits when its callback returns. An async callback returns at its first `await`: the statements before it are committed, the rest run outside the transaction, and a later error rolls nothing back. The rule rejects an `async` function passed to `transactionSync()`, including a method passed by reference such as `transactionSync(this.reset)`. It also follows the [functions the callback calls](#called-functions) and rejects a call that leads to an async function writing to storage after an await, since those writes land outside the transaction.

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
