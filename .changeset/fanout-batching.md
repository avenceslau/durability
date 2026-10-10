---
'durability': minor
---

Add `ackOnReturn` to fanout deliver targets, which acknowledges every message a consumer leaves unsettled in one transaction when `deliver` returns, and `batchDelayMs` to fanout, which holds first deliveries so messages enqueued together share one batch.
