---
'durability': minor
---

Classify an undecodable stored operation payload as a distinct terminal failure instead of a handler error. The payload is now decoded before any attempt is claimed, so a corrupt payload fails with the new `DurablePayloadDecodeError` without entering the handler or consuming its retry budget. A failed `getResult` for a `DurableResultSerializationError` now also reports `outcomeMayBeUnknown: true`, signalling that the handler's side effect may have committed even though its result could not be recorded.
