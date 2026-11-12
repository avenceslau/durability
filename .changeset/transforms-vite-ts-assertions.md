---
'@durability/transforms': patch
---

Fix the Vite plugin failing on `.ts`, `.mts`, and `.cts` files that use `<T>value` type assertions. Every module was parsed with JSX enabled, which rejects that syntax and broke `vite build` once any binding was configured; JSX is now enabled only for `.tsx`, `.jsx`, and JavaScript modules, and bindings reached through an angle-bracket assertion such as `(<Env>env).MY_BINDING` are wrapped like any other access.
