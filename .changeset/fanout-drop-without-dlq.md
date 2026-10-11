---
'durability': minor
---

Drop terminal fanout deliveries when no `dlq` is configured instead of retaining them with a 60-second retry, which kept the Durable Object awake indefinitely. The `terminal` lifecycle event still reports each dropped delivery.
