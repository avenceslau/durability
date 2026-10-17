---
'durability': minor
---

`conn.on.resync` now receives `{ names }`: the outbound events whose subscribers start without history. It fires for newly subscribed names on a live connection as well as for every name when replay fails, so a collection added later can seed itself without a connection-wide reload.
