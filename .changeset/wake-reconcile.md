---
'durability': patch
---

Keep the physical alarm armed when an alarm run fails. The platform drops an alarm after a limited number of failed deliveries, and a storage error while a helper reconciled its alarm propagated as such a failure, so enough in a row left pending operations, named alarms and deliveries with nothing scheduled until some request happened to write. A failed run now arms the alarm at `alarmMinDelayMs` and reports `durability.alarm.failed`; only a failing `setAlarm` still reaches the platform.
