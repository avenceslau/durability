---
'durability': minor
---

`Durability` takes a `channel` option, so several instances share one scheduler: each channel holds one instance, call IDs are unique within a channel, and each instance runs, lists, and purges only its own calls. A library can use a channel of its own without its calls meeting the application's. Due calls of a channel no instance attached are kept and postponed, with a `durability.channel_missing` report, until their channel's helper attaches again. A migration adds the `channel` column; existing calls join the default channel and keep their keys. On the default channel, IDs of the form `["<channel>","<id>"]` are reserved. `DurabilityOutbox` channels now share the same mechanism, and their unattached channels report `durability.channel_missing`.
