---
'durability': minor
---

A Durable Object now has one scheduler. Helpers configured with `context` and every `DurabilityScheduler` for the same object join it instead of each creating their own, which used to let one delete or move the physical alarm another had set and strand its work. Scheduler options merge across attachments; a different value for an option already set throws. Any helper's `alarm` runs the due work of every helper on the object, so a library can build helpers from the context it is given without asking for a scheduler. A second copy of durability reaching the same object throws.
