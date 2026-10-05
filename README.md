# Durability

Durable operation tooling for Cloudflare Workers and SQLite- or KV-backed Durable Objects.

## Packages

| Package                                           | Description                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`durability`](./packages/durability)             | Composable `Durability` operations, `DurabilityAlarms`, `DurabilityFanout`, and `DurabilityRouting` for application-owned Durable Objects on SQLite or KV storage. |
| [`@durability/storage`](./packages/storage)       | Shared migration types for Durable Object storage.                                                                                                                 |
| [`@durability/transforms`](./packages/transforms) | Typed caller and callee transforms for Cloudflare RPC, including a Vite plugin.                                                                                    |
| [`@durability/lint`](./packages/lint)             | Oxlint rules for durability migrations and alarm delegation.                                                                                                       |

Each package has its own API documentation. Complete example Workers for every primitive live in [`examples/`](./examples); they are type-checked as part of the validation suite.

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

GitHub Actions creates and updates a version pull request. After that pull request is merged, the release workflow uploads the new package versions to npm as private staged packages with provenance. Each package's trusted publisher must allow staged publishing from the `release.yaml` workflow and the `npm` GitHub environment. Do not grant direct `npm publish` permission.

The workflow summary records each stage ID and the release commit. Use npm 11.18 or newer to inspect and approve the packages with npm 2FA:

```sh
npm stage list --json
npm stage view <stage-id> --json
npm stage download <stage-id>
npm stage approve <stage-id>
```

Approve workspace dependencies before their dependents. If a staging job fails, inspect `npm stage list` before retrying only the failed job; staged versions cannot be staged again. After every package in the release is public, run the **Finalize Release** workflow from `main` with the recorded release commit to create the package tags and GitHub releases.

To recover versions that were bumped before staged publishing was enabled, manually run the **Release** workflow with **Stage unpublished package versions** selected and provide the commit that introduced those versions.

## License

[ISC](./LICENSE)
