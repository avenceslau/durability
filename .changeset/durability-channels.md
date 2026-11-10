---
'durability': minor
---

`Durability` takes a `channel` option, so several instances share one scheduler: each channel holds one instance, call IDs are unique within a channel, and each instance runs, lists, and purges only its own calls. A library can use a channel of its own without its calls meeting the application's. Due calls of a channel no instance attached are kept and postponed, with a `durability.channel_missing` report, until their channel's helper attaches again. A migration changes the primary key to `(channel, id)`; existing calls and memoized results stay on the default channel, with no restrictions on IDs. Downgrading refuses to discard non-default-channel records; drain or explicitly purge those channels first. `DurabilityOutbox` channels now share the same mechanism, and their unattached channels report `durability.channel_missing`.
