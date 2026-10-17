---
'durability': minor
---

Add `DurabilityOutbox`, keyed latest-state publication for application-owned Durable Objects. Stage the newest value for a key in the same transaction as the state it describes; the outbox coalesces superseded versions and republishes the newest one until `publish` acknowledges it. Several named channels share one scheduler and one set of tables.
