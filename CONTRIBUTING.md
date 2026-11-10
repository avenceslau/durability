# Contributing

## Setup

Use Node.js 22.23.4 or newer to include the docs site, and the pnpm version declared in `package.json`.

```sh
pnpm install
pnpm check
```

## Documentation

Run `pnpm --filter durability-docs dev` to edit the docs site. Guides live in `docs/src/content/docs/`. Each primitive has its own authored file under `primitives/`, and end-to-end designs with architecture/failure diagrams live under `compositions/`. Keep the primitive docs aligned with implementation changes. Only companion package references are generated from package READMEs. See [docs/README.md](./docs/README.md) for Worker preview, validation, and deployment commands.

## Pull requests

Keep changes scoped to one concern and include tests for behavior changes. Add a changeset when a published package changes:

```sh
pnpm changeset
```

A changeset is not required for documentation, tests, or repository-only tooling that does not affect a published package.
