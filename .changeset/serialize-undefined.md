---
'durability': patch
---

Accept `undefined` properties and array elements in payloads, results, log bodies and socket events, treating them as `JSON.stringify` does (dropped and `null` respectively). Previously any value that merely contained an `undefined`, such as the lifecycle event of an operation or named alarm whose handler returned nothing, was rejected, so forwarding `lifecycle` to a `DurabilitySocket` or into another operation failed for those handlers.
