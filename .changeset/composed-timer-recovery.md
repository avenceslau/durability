---
'durability': patch
---

Prevent zero-delay alarm loops when slow operations or semaphore callbacks share a scheduler with other helpers. Keep active work's physical alarm fallback, but exclude it from in-memory timers and continue requesting permits while admission or completion checks are pending.
