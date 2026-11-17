---
'durability': patch
---

Accept any WebSocket implementation in the socket client's `webSocket` option whose instances have `send`, `close` and `addEventListener`, the only members the client uses. Implementations that previously had to satisfy the full `WebSocket` interface still work.
