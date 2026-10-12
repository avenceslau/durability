---
'durability': minor
---

Add `DurabilitySocket` (`durability/socket`) and `DurabilitySocketClient` (`durability/client`): typed WebSocket RPC and event push between browsers and a Durable Object over hibernatable WebSockets. Inbound handlers are validated with any Standard Schema validator, outbound events become typed methods on the socket, every event is persisted to SQLite with a sequence number so reconnecting clients replay what they missed or are told to resync, and `on.lifecycle` can stream `Durability` progress to browsers. Each helper now also exposes `lifecycle(hook)` to attach additional lifecycle hooks after construction, and operation `completed` events carry the handler's typed `result`.
