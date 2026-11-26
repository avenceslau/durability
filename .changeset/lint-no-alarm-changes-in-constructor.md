---
'@durability/lint': minor
---

Add `no-alarm-changes-in-constructor`, which rejects `setAlarm()`, `deleteAlarm()` and durability calls that schedule work in a Durable Object constructor or instance field initializer, where they run again on every load and replace the pending alarm.
