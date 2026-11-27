---
'durability': patch
---

Stop operations and named alarms from retrying before their retry delay. An alarm pass lists due rows before it has permits for them, so a row whose attempt failed and was rescheduled while the pass waited used to start its next attempt at once.
