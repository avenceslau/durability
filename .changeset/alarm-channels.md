---
'durability': minor
---

`DurabilityAlarms` takes a `channel` option, so several instances share one scheduler: each channel holds one instance, alarm names are unique within a channel, and each instance runs, lists, and purges only its own alarms with its own policy and lifecycle hooks. A library can bring its own named alarms into an object that already has some, even with the same names. A migration changes the primary key to `(channel, name)`; existing alarms and memoized results stay on the default channel without changing their names. Due alarms of a channel no instance attached are kept and postponed until their channel's helper attaches again. Downgrading refuses to discard records on non-default channels; drain or explicitly purge them first.
