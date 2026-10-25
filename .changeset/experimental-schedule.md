---
'durability': minor
---

Add the experimental `DurabilitySchedule` capability, exported from `durability/experimental`: one versioned recurring schedule per Durable Object whose ticks start overlapping, individually tracked runs, bounded by `maxConcurrentRuns` and queued durably beyond it. A tick inserts its run in the transaction that advances the stored next tick, so a tick fires at most once without retaining finished runs, and missed ticks collapse into one run. While runs are in flight the alarm invocation stays open and hands off before the wall-time limit; a run left running by a previous instance is reported as errored with `ScheduledRunInterruptedError` instead of re-run. Each outcome is persisted, delivered to `onOutcome` at least once with capped retries and a `dead_lettered` lifecycle event, and the run's row is deleted on delivery, for four rows and one `setAlarm()` written per run. `durabilityScheduleMigrations` creates its two tables under their own migration name.

Add an experimental `liveTimers` scheduler option that starts due work from exact in-memory timers and keeps long handlers from delaying newly due work, with the physical alarm kept as the eviction fallback, and an experimental `cancel()` on each named alarm method that deletes its pending occurrence.

Add an `onAlarmRetry` scheduler option, called best effort with the serialized error, the retry delay, and the platform retry count whenever an alarm run fails and the scheduler re-arms its fallback alarm.
