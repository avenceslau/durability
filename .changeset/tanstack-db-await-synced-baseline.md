---
'@durability/tanstack-db': patch
---

Fix `awaitSynced()` waiting out its full timeout when the confirming event arrived before the RPC answered. The baseline write counts are now taken when the mutation handler starts, not when it calls `awaitSynced()`, so the documented `await rpc.create(...); await awaitSynced();` pattern resolves as soon as the server's event has been applied.
