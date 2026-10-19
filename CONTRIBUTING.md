# Contributing

## Setup

Use Node.js 22 or newer and the pnpm version declared in `package.json`.

```sh
pnpm install
pnpm check
```

## Pull requests

Keep changes scoped to one concern and include tests for behavior changes. Add a changeset when a published package changes:

```sh
pnpm changeset
```

A changeset is not required for documentation, tests, or repository-only tooling that does not affect a published package.

## Packed artifact gate

`pnpm check` runs `publint` as a fast static check. The deeper consumer gate packs
the published packages, installs the tarballs into a throwaway project outside the
workspace, and runs a real SQLite Durable Object smoke test against the shipped
artifacts:

```sh
pnpm pack:consumer
```

It fails with the stage that broke — `pack`, `manifest`, `install`, `resolve`,
`types`, `bundle`, or `runtime` — covering packed manifests that still carry
`workspace:` ranges, missing export targets, internal dependencies resolving from
the registry instead of the packed tarballs, broken public imports
(`durability`, `durability/utils`), Worker bundling, and durable operation,
alarm-retry, result-lookup, and named-alarm behavior. It runs in CI on every pull
request and again in the release workflow before publishing.

### Supported toolchain

The gate is hard-gated against the toolchain the packages are tested with, read
from their own manifests so the fixture cannot drift from the pinned versions:

- Node.js 22 or newer.
- `@cloudflare/vitest-pool-workers`, `vitest`, `@cloudflare/workers-types`, and
  `typescript` as pinned in `packages/durability/package.json`.
- `wrangler` as pinned in `packages/transforms/package.json`.
- Generated Wrangler types are the preferred path; `@cloudflare/workers-types` is
  an optional peer.

The scheduled `Packed artifact smoke (latest toolchain)` workflow runs the same
gate against the latest releases as a non-blocking early-warning signal; run it on
demand with `PACK_CONSUMER_CHANNEL=latest pnpm pack:consumer`.
