---
'@durability/transforms': minor
---

Wrap every object binding in the Vite plugin, including KV, R2, Workflows, and queues, so caller transforms apply to any binding call. Stubs without transforms now pass calls through unchanged, preserving synchronous methods and RPC promise pipelining, and transformed calls support pipelined member access. Transforms that keep the result type preserve overloaded method signatures.
