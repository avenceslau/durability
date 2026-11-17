---
'durability': minor
---

Add `DurabilityLog.discardBefore(offset, limit?)`, which deletes the records an object still holds below an offset without handing them to cold storage. Retention removes records by age and size, whoever has read them, so a log whose consumers had all moved on kept those records until it was full or they were old. A caller that tracks its consumers can now free them as soon as nobody needs them.
