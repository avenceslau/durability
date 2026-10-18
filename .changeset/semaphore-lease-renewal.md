---
'durability': patch
---

`DurabilitySemaphoreQueue` (experimental) renews leases that have permits in use. A client reported a lease only with a permit request or when its counts changed, so a client running long work with nothing else queued let the lease expire at the holder, which then leased the same permits again and exceeded the limit. The queue now reports such a lease at half its lifetime at the holder, on its own alarm.
