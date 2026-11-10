---
'durability': minor
---

`DurabilitySchedule` takes a `channel` option, so several schedules share one scheduler: each channel holds one instance with its own schedule, versions, cancels, runs, outcomes, and lifecycle hooks, and two channels may tick at the same scheduled time. A channel whose runs hold the alarm invocation open no longer delays another channel's ticks, and interrupted-run recovery only touches the instance's own channel. Named channels' idempotency keys end with `:` and the JSON-encoded channel name, so they never equal default-channel keys, which are unchanged. The `durability_0018_schedule_channels` migration changes the primary keys to `(channel, id)` and `(channel, scheduled_time)` and moves an existing schedule and its runs to the default channel. The schedule and runs of a channel no instance attached are kept unchanged, without arming the alarm, until it attaches again. Downgrading refuses to discard named channels' schedules or runs.
