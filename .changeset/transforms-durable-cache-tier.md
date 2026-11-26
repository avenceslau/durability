---
'@durability/transforms': patch
---

Add `durableTier` to `@durability/transforms/cache`, which caches planned methods with `durable` windows in the storage of the Durable Object making the calls, so cached results survive its eviction.
