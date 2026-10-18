---
'durability': patch
---

`DurabilitySemaphoreQueue` (experimental) renews leases that have permits in use. A client reported a lease only with a permit request or when its counts changed, so a client running long work with nothing else queued let the lease expire at the holder, which then leased the same permits again and exceeded the limit. The queue now reports such a lease at half its lifetime at the holder, on its own alarm.

The holder no longer forgets a lease nobody reported for `ttlMs`: it retires it and keeps its permits counted until the client reports what it drew and released, as it does for claimed grant permits. A client cut off from the holder for longer than the TTL could otherwise have its running work's permits leased again. The queue reports a stopped lease until the holder confirms it settled.

The queue also recovers faster from faults: claim and release reports retry at most every 5 seconds instead of backing off for minutes (a claim the holder has not heard about within `grantTimeoutMs` is reclaimed), and a request whose reply cannot be applied is retried after the retry delay instead of waiting for the request deadline.
