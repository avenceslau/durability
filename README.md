# Durability

Durable operation tooling for Cloudflare Workers and SQLite- or KV-backed Durable Objects.

## Packages

| Package                                           | Description                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`durability`](./packages/durability)             | `Durability` operations and `DurabilityAlarms` named alarms: alarm-backed, effectively-once execution with retries and idempotency, on SQLite or KV storage. |
| [`@durability/storage`](./packages/storage)       | Shared migration types for Durable Object storage.                                                                                                           |
| [`@durability/transforms`](./packages/transforms) | Typed caller and callee transforms for Cloudflare RPC, including a Vite plugin.                                                                              |
| [`@durability/lint`](./packages/lint)             | Oxlint rules for durability migrations and alarm delegation.                                                                                                 |

Each package has its own API documentation and examples.

## Development

This repository requires Node.js 22 or newer and uses pnpm.

```sh
pnpm install
pnpm check
```

The validation suite formats, lints, builds, type-checks, tests, and validates the publishable package manifests. Run an individual task with a workspace filter when needed:

```sh
pnpm --filter durability test
pnpm --filter @durability/transforms test
```

The Worker integration tests run locally through `@cloudflare/vitest-pool-workers`; they do not require Cloudflare credentials.

## Releases

Package versions and release notes are managed with [Changesets](https://github.com/changesets/changesets). Add a changeset to every pull request that changes a published package:

```sh
pnpm changeset
```

GitHub Actions creates and updates a version pull request, but it never publishes packages. After merging that pull request, publish manually from an up-to-date `main` checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm release
git push --follow-tags
```

Manual publishing requires npm authentication with access to each package.

## License

[ISC](./LICENSE)
