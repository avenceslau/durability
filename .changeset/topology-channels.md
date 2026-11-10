---
'durability': minor
---

`DurabilityTopology` takes a `channel` option, so several topologies share one coordinator and scheduler: each channel holds one instance, with its own groups, state values, versions, stale-write fencing, publisher, and deliveries, and the same group and state names in two channels do not meet. A second instance on a channel already in use throws, even without a publisher. The default channel keeps its outbox channels (`durability.topology` and `durability.topology.<state>`), so publications and deliveries pending across the upgrade still go out; other channels use JSON outbox channel names that cannot collide. A migration adds an `owner_channel` column to the topology tables and moves existing groups, states, and write records to `default`. Downgrading refuses to discard rows of other channels; delete them explicitly first.
