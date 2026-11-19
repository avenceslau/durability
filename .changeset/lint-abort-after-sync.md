---
'@durability/lint': minor
---

Add `abort-after-sync`, which requires `await ctx.storage.sync()` directly before `ctx.abort()` so the abort cannot discard pending storage writes.
