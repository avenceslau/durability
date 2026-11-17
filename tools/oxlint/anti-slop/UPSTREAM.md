# anti-slop

Vendored from https://github.com/dmmulroy/anti-slop at commit
`13909c9e07590f5a85d93c62712259fe14a883f7`, copied with
`skills/install-anti-slop/scripts/install.mjs`.

Local deviations:

- `effect/` is not vendored; no package depends on Effect.
- `package.json` marks the directory as an ES module so Node loads the
  TypeScript sources without a module-type warning.
