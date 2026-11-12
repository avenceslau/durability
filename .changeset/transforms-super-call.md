---
'@durability/transforms': patch
---

Fix `super.method()` from a transformed override recursing until the stack overflowed. Each method wrapper installed by `applyTransforms` now starts dispatch at the prototype it was installed on, so the super call runs the base class's transforms once around the base method and returns.
