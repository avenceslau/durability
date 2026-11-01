---
title: Development tracing
description: Development tracing for durable capabilities.
---

## Dev mode tracing

Define `__DURABILITY_DEV__` as `true` at build time to log every operation the package performs. Each entry is a structured `console.debug` object whose `event` starts with `durability.dev.`:

| `event`                                            | Logged for                                                                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `durability.dev.call`                              | Each public method call on every helper, including the experimental outbox and semaphores, generated operation, alarm, and socket outbound methods, `memoize`, and fanout `ack`, `retry`, and `deadLetter`, with its arguments. |
| `durability.dev.call.return` / `.call.throw`       | The call's result or serialized error, linked to the call by `call`.                                                                                                                                                            |
| `durability.dev.storage`                           | Each storage method: transactions and alarm reads and writes, including those inside `transaction`.                                                                                                                             |
| `durability.dev.storage.return` / `.storage.throw` | The storage call's result or serialized error, linked by `call`.                                                                                                                                                                |
| `durability.dev.sql`                               | Each SQL statement, whitespace-compacted, with its bindings.                                                                                                                                                                    |
| `durability.dev.lifecycle`                         | Every lifecycle event, whether or not a hook is attached.                                                                                                                                                                       |
| `durability.dev.scheduler.early_alarm`             | An in-memory timer that runs due work before the physical alarm.                                                                                                                                                                |
| `durability.dev.socket.send` / `.socket.close`     | Each frame sent to a browser socket, and each socket closed for a protocol error.                                                                                                                                               |

Every entry carries `seq`, a process-wide counter that orders entries across interleaved async work, and `at`, the `Date.now()` reading when it was logged. A deterministic simulation that controls time, randomness, and scheduling gets a replayable transcript by collecting the entries in order, for example with `vi.spyOn(console, 'debug')`.

Set the flag with the bundler's `define`:

```jsonc
// wrangler.jsonc
{ "define": { "__DURABILITY_DEV__": "true" } }
```

```ts
// vite.config.ts or vitest.config.ts
export default defineConfig({
  define: { __DURABILITY_DEV__: 'true' },
});
```

Leave it undefined or define it as `false` in production. With `false`, the bundler drops the tracing code entirely; left undefined, each traced call costs one branch. Tracing logs payloads, results, and SQL bindings verbatim, so never enable it where those contain secrets. In this repository, `DURABILITY_DEV=1 pnpm --filter durability test` runs the test suite in dev mode.
