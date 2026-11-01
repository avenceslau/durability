---
title: Load envelope
description: Load envelope for durable capabilities.
---

## Load envelope

`pnpm bench:load` runs an opt-in Workerd characterization suite (`bench/`, excluded from `pnpm test`) that drains large backlogs, a zero-delay retry storm, and a mixed operation plus named-alarm workload, emitting one machine-readable `BENCH {...}` JSON line per scenario. The numbers below come from that suite on `compatibility_date` `2026-07-07` with the default `alarmConcurrency` of 10; treat them as a tested envelope on one machine, not a platform capacity promise.

- A live object drains its backlog eagerly and through in-memory timers, so 100, 1,000, and 10,000 simultaneously due operations all complete with no lost calls, no extra terminal transitions, and nothing left pending. The physical alarm is a post-eviction fallback, not the live drain path.
- Each retained completed row costs roughly 200–260 bytes plus the serialized payload and result; 10,000 empty-payload operations occupy about 2 MB of `databaseSize`. Rows are never reclaimed automatically, so storage grows linearly until `purgeBefore` runs.
- `alarmConcurrency` is one shared budget: a mixed backlog of overlapping operations and a named alarm never exceeds 10 concurrent handlers in total, rather than 10 per category.
- A zero-delay retry storm performs exactly one attempt per retry with no extra work and settles every operation.
