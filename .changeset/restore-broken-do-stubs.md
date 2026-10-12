---
'@durability/transforms': minor
---

Add the `restoreBrokenStubs` Vite plugin option and `createRestorableStubFactory`, which replace a Durable Object stub after a call through it throws so later calls and `retry` attempts use a fresh stub.
