---
'durability': patch
---

Re-arm the alarm when an object wakes with pending work and none scheduled. The platform drops an alarm after six failing retries, which storage errors during reconciliation can cause, and pending operations, named alarms and deliveries then waited until some request happened to write.
