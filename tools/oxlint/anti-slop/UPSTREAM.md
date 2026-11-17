# anti-slop

Vendored from https://github.com/dmmulroy/anti-slop at commit
`13909c9e07590f5a85d93c62712259fe14a883f7`, copied with
`skills/install-anti-slop/scripts/install.mjs`.

Local deviations:

- `effect/` is not vendored; no package depends on Effect.
- `package.json` marks the directory as an ES module so Node loads the
  TypeScript sources without a module-type warning.
- `rules/no-reflect-get.ts` allows `Reflect.get` directly inside the `get`
  trap of a `new Proxy(target, { get })` handler literal, where forwarding the
  trapped read is what `Reflect.get` is for.
- `rules/no-reflect-apply.ts` likewise allows `Reflect.apply` directly inside
  the `apply` trap of a `new Proxy(target, { apply })` handler literal. Both
  rules share the check in `shared/proxy-trap.ts`.
- `rules/no-unsafe-dictionary-type.ts` no longer treats a mapped type over a
  finite key set as a dictionary: literal keys, unions of them, local aliases
  of them, or a type parameter not instantiated in the file, as in
  `{ readonly [Key in Name]?: unknown }`. Mapped types over `string`,
  `number`, `symbol`, `PropertyKey`, template literals, `keyof`, keys
  remapped with `as` to anything but literals, keys that cannot be resolved in
  the file, and in-file instantiations such as `Members<string>`, are
  still reported, as is `Record` with any key. The check is
  `isFiniteMappedKey` in `shared/dictionary-types.ts`.
