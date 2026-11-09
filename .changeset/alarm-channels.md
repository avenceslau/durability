---
'durability': minor
---

`DurabilityAlarms` takes a `channel` option, so several instances share one scheduler: each channel holds one instance, alarm names are unique within a channel, and each instance runs, lists, and purges only its own alarms with its own policy and lifecycle hooks. A library can bring its own named alarms into an object that already has some, even with the same names. A migration adds the `channel` column; existing alarms join the default channel and keep their keys. Due alarms of a channel no instance attached are kept and postponed until their channel's helper attaches again. On the default channel, handler names of the form `["<channel>","<name>"]` are reserved.
