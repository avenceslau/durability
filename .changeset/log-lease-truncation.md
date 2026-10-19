---
'durability': patch
---

`DurabilityLog` leased consumers no longer wedge when retention trims records they have not finished. A range awaiting redelivery (nacked or expired) that retention trimmed made every `lease()` re-claim it and throw `LogTruncatedError`, so nothing past it was delivered again; `lease()` now throws once, drops the trimmed offsets from the range, and continues from the retained records. A leased consumer's cursor also moves past offsets trimmed before they were ever leased, instead of staying behind every acked range.
