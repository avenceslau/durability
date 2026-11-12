---
'durability': patch
---

Keep the topology client's version fence across a missing read. After a read returned nothing, the client forgot the newest version it had seen, so a lagging replica could hand back an older snapshot from the same coordinator and readers resumed routing to members that had already left. The client now remembers the newest version separately from the cached view; an older snapshot that arrives with no view to keep serving is answered like the failed read before it, and the negative TTL is renewed.
