---
'durability': minor
---

Stop a Durable Object from running into the runtime's limit of 10,000 pending `setTimeout` timers. Attempt, delivery, and publish timeouts and `DurabilityTracker` waits used to set one native timer each, so an object with enough of them open at once had `setTimeout` throw `QuotaExceededError`. They now sit in a min-heap ordered by due time behind a single native timer set for the earliest, so the number of native timers no longer grows with the number of open timeouts. Every other timer the helpers set inside a Durable Object goes through the same heap, and a `DurabilitySocketClient` connection keeps its call timeouts, reconnect backoff, and keep-alive ping behind one native timer of its own.

Add `DurabilityScheduler.setTimeout(callback, delayMs)`, which schedules an in-memory timeout on that same heap and returns a function that cancels it, so application code in a Durable Object can hold any number of timeouts without reaching the limit.
