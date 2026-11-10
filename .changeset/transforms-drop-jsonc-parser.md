---
'@durability/transforms': patch
---

Remove the unused `jsonc-parser` dependency. Nothing in the package imported it, so installs are smaller and behavior is unchanged.
