---
'@durability/transforms': patch
---

Add `memoryTier` to `@durability/transforms/cache`, which caches planned methods in the caller's isolate with their own `memory` windows. Cache tiers now pass results to each other with the time the target returned them, so a tier judges the age of what the tiers behind it answered with. Plan windows are now per tier: `location` is optional, and only methods with `location` windows go through the Workers cache.
