---
'@durability/transforms': patch
---

Add `kvTier` to `@durability/transforms/cache`, which caches planned methods with `global` windows in Workers KV for every location. `serveCached` takes a new `tiers` option to read storage tiers before calling the target, and its `Cache-Control` now subtracts the age of the entry it answers with.
