---
'durability': minor
---

Reject reuse of a durable operation ID with a different payload. Registering the same ID for the same operation with the same data (compared canonically, so object key order does not matter) stays a no-op; a different payload now throws `DuplicateDurablePayloadError` instead of being dropped silently, matching how fanout treats a reused `deduplicationKey`.
