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
