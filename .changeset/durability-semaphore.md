---
'durability': minor
---

Add `DurabilitySemaphore` (`durability/semaphore`): one concurrency limit held in an application-owned Durable Object and shared by many client Durable Objects. Requests are allocated in arrival-ordered rounds, groups may carry their own ceiling, and clients report claimed and released permits as cumulative counts so replays never free capacity twice. `DurabilitySemaphore.client()` mirrors `DurabilityRouting.client()`.
