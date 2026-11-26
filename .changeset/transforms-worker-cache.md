---
'@durability/transforms': patch
---

Add experimental `@durability/transforms/cache`, which answers planned Durable Object methods through the Workers cache. `cachePlan<Target>()(...)` declares the cached methods and their fresh and stale windows, `serveCached` answers cached calls from an entrypoint with the cache enabled, and the `workerCacheTier` caller transform sends calls through that entrypoint and falls back to RPC when it fails. The Vite plugin's new `cacheEntrypoints` option generates the entrypoint for every plan in the main module and checks that Wrangler enables the cache for it.
