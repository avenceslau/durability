# Durability docs Worker

The documentation site uses [Nimbus](https://nimbus-docs.com/) on Astro and deploys to **Cloudflare Workers Static Assets**, not Pages. It includes navigation, light/dark themes, mobile layouts, and a build-time Pagefind search index. A small Worker redirects `shirei.dev` to the canonical `durability.shirei.dev` host and serves the site's `ASSETS` binding. No SSR adapter or database is required.

## Develop

Use Node.js **22.23.4 or newer** (required by Astro) and the repository's pnpm version. From the repository root:

```sh
pnpm install
pnpm --filter durability-docs dev
```

Astro prints the local development URL. Search is available in the production build, not the Astro dev server.

## Build and preview the Worker

```sh
pnpm --filter durability-docs build
pnpm --filter durability-docs preview
```

`preview` runs Wrangler against `dist/` using the same static-asset configuration as deployment. Rebuild after content changes when using this preview.

## Validate

```sh
pnpm --filter durability-docs typecheck
pnpm --filter durability-docs build
pnpm --filter durability-docs test
pnpm --filter durability-docs deploy:check
```

The tests check every built page and internal link, search assets, and the separate primitive files and internals sections. To also exercise the code-linked walkthroughs and render every diagram in Chromium:

```sh
pnpm --filter durability-docs exec playwright install chromium
pnpm --filter durability-docs test:browser
```

The browser checks use the built site through Wrangler. They verify complete source against the repository, automatic scrolling/file switching, code/graph synchronization, full-screen close/focus behavior, client-side navigation, no-JavaScript fallback, themes, and mobile layout. `deploy:check` is a Wrangler dry run; it does not publish anything and requires no Cloudflare credentials. Repository-wide `pnpm build`, `pnpm typecheck`, and `pnpm test` also include the docs workspace through Turbo.

## Deploy

```sh
pnpm --filter durability-docs exec wrangler login
pnpm --filter durability-docs deploy
```

The deploy script builds first, then publishes the `durability-docs` Worker from [`wrangler.jsonc`](./wrangler.jsonc). It attaches two Custom Domains in the Cloudflare account that owns the `shirei.dev` zone:

- `https://durability.shirei.dev` serves the documentation.
- `https://shirei.dev` permanently redirects with HTTP `308`, preserving the path and query string.

`workers.dev` is disabled. The Worker must run before asset matching so the apex domain redirects even for paths that match existing assets. Local preview continues to serve the docs on localhost. No real deployment is performed by the validation commands above.

For CI, supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with permission to deploy this Worker. For Workers Builds with the repository root as the project root, use:

- Install command: `pnpm install --frozen-lockfile`
- Build command: `pnpm --filter durability-docs build`
- Deploy command: `pnpm --filter durability-docs exec wrangler deploy`

The `shirei.dev` zone must be active in the deploying Cloudflare account, with permission to manage Custom Domains. Remove or resolve any conflicting existing DNS records or Worker routes before deployment. Wrangler manages the Custom Domain DNS and certificates; no account ID or zone ID is committed. Astro's `site` URL is set to `https://durability.shirei.dev` for canonical links and the sitemap. Keep it aligned with the Worker's redirect target and Wrangler domains if the hostname changes.

## Edit content

- Guides live in [`src/content/docs/`](./src/content/docs/).
- Every primitive has a separate authored Markdown file in [`src/content/docs/primitives/`](./src/content/docs/primitives/), including its behind-the-scenes implementation model. Keep these pages aligned with API/source changes.
- End-to-end guides live in [`src/content/docs/compositions/`](./src/content/docs/compositions/). Their native architecture walkthroughs are authored as MDX; supplemental failure-sequence and primitive diagrams still use locally bundled Mermaid.
- Navigation and metadata live in [`astro.config.ts`](./astro.config.ts). Nimbus's layouts and UI are source-owned under `src/layouts/` and `src/components/`; `nimbus.json` records their scaffold provenance.
- Theme tokens live in [`src/styles/globals.css`](./src/styles/globals.css); Durability overrides live in [`src/styles/custom.css`](./src/styles/custom.css).
- Companion package references for storage types, transforms, lint, and TanStack DB are generated from their package READMEs by [`scripts/sync-reference.mjs`](./scripts/sync-reference.mjs) before development, build, and typecheck. Edit those READMEs, not their four ignored generated Markdown files. Cross-cutting references such as retries and migrations are authored separately. There is no monolithic Durability API page.

After editing a package README, restart the dev server or rerun the build to refresh its reference page. The self-contained quickstart source lives in [`examples/getting-started/`](../examples/getting-started/) and is typechecked by the examples workspace.

## Author a code-linked architecture walkthrough

`ArchitectureWalkthrough` is a project-owned Nimbus/MDX component, not a Mermaid overlay or a live execution sandbox:

```mdx
<ArchitectureWalkthrough example="billing">
  <Render file="architecture-help" />
</ArchitectureWalkthrough>
```

Existing models are `billing`, `email`, `dashboard`, `concurrency`, and `event-stream`.

- The [Astro component](./src/components/architecture/ArchitectureWalkthrough.astro) shows a small diagram preview in the guide. Clicking it opens a full-screen native dialog with the diagram and **complete source files**, not snippets. Component selection switches files and scrolls to the relevant lines. ← / → keys and the on-screen arrows walk through the flow; Escape/close restores focus and the guide's scroll position. Keyboard shortcuts only apply in the open explorer and leave file selectors and text selection alone. Extra controls and state notes stay under **Details**; no-JavaScript readers get source links and an ordered text fallback. Its small client module synchronizes the views using Nimbus's `mount()` lifecycle; no React island or server is required.
- Each model has its own file in [`src/architecture/`](./src/architecture/). A model declares nodes, edges, source excerpts, and named scenarios. Every step names the affected nodes/edges, a source range, and durable versus in-memory state.
- Import the actual example using `?raw`. Use `sourceExcerpt()` and `sourceFocus()` from [`src/lib/architecture.ts`](./src/lib/architecture.ts) with unique text anchors. **Do not copy code or hardcode line numbers.** Anchors locate the corresponding repository lines; `sourceFiles()` deduplicates and renders each entire file. Missing/ambiguous anchors and invalid graph references fail the build.
- Add a model to `src/architecture/index.ts`, then use its key in MDX. Registering the component globally happens in `src/components.ts`. If generated Markdown behavior changes, increment its `markdown.componentMap` revision in `astro.config.ts`; the textual fallback is preserved in `index.md` and `llms-full.txt`.
- Describe failures as illustrative assumptions, not as code the component executes. Never imply that caller-side headers implement remote idempotency, that a best-effort hook is durable, or that an unimplemented reconciliation step exists.
- Add the composition to `tests/browser/architecture.spec.ts`. Every scenario is checked for source highlights, graph highlights, state notes, and control boundaries. The docs Turbo task includes example source files as inputs so code changes invalidate the built walkthroughs.

Nimbus supplies the docs shell and authoring pipeline; the architecture component is owned here and can evolve independently of Nimbus releases.
