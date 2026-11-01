# Durability documentation

This is an Astro 7 / Nimbus site deployed as a static-assets Cloudflare Worker.
The framework provides content/runtime helpers; the layouts, UI, and custom architecture
walkthroughs in this directory are project-owned source. Preserve the separate page and
source file for every primitive.

## Content and navigation

- `src/content/docs/primitives/*.md`: one primitive each, including API, internals,
  durable versus in-memory state, and recovery semantics.
- `src/content/docs/compositions/*.mdx`: end-to-end systems with native code-linked
  architecture walkthroughs and supplemental Mermaid failure sequences.
- `src/content/docs/reference/`: authored cross-cutting references and four ignored
  companion references generated from package READMEs by `scripts/sync-reference.mjs`.
- `src/content/partials/`: reusable prose rendered with `<Render file="..." />`.
- `src/components.ts`: global MDX registry. Register custom components here; Nimbus
  validates component names during builds.
- `astro.config.ts`: canonical URL, metadata, curated sidebar, Markdown plugins, and
  component-to-Markdown fallback mapping. Nimbus sidebar groups use `items`, not
  `children`.

Only `title` is required in frontmatter. Do not reintroduce Starlight `template`, `hero`,
`editUrl`, or Starlight imports. Companion references use our `sourceEditUrl` schema field.
Read the installed release guide when changing Nimbus integrations:
`node_modules/@cloudflare/nimbus-docs/dist/docs-for-agents.md`.

## Native architecture walkthroughs

- `src/components/architecture/ArchitectureWalkthrough.astro`: build-time graph/source UI.
- `src/components/architecture/walkthrough.client.ts`: synchronized source, node, and step
  interactions. Use Nimbus's `mount()` cleanup lifecycle for client-side navigation.
- `src/architecture/*.ts`: one typed model per composition.
- `src/lib/architecture.ts`: source extraction, focus ranges, graph validation, source URLs.

Import actual example files with `?raw`; never maintain copied code or line numbers.
Use unique anchors with `sourceExcerpt()` / `sourceFocus()`. Build-time validation must
fail when an anchor disappears or graph references become invalid. Example source files
are included in the docs Turbo inputs.

Walkthroughs are explanatory traces, **not executable simulations**. Keep failure windows
and unimplemented recovery explicit. A passed idempotency header is not receiver-side
deduplication. A lifecycle hook is best effort even if it calls a durable enqueue. Snapshot
resync cannot invent a projection event that was never enqueued.

Keep the guide lightweight: show only a diagram preview. Open a full-screen native
dialog for the linked diagram and complete source files. Use anchors for highlighting,
not for truncating displayed code. Selecting a node must switch/scroll to its code.
Escape/close must restore focus and release the page scroll lock, including on navigation.
Advanced controls/explanations stay behind Details; do not restore an inline dashboard.

Keep semantic buttons, focus indicators, source-line keyboard activation, durable/volatile
text notes, reduced-motion support, and no-JavaScript fallback. No autoplay is needed.
Preserve meaningful clean Markdown via `markdown.componentMap`; increment its revision
when fallback rendering changes. Do not import MDX files directly; use `Render` partials.

## Validation

From the repository root:

```sh
pnpm --filter durability-docs typecheck
pnpm --filter durability-docs build
pnpm --filter durability-docs test
pnpm --filter durability-docs exec playwright install chromium
pnpm --filter durability-docs test:browser
pnpm --filter durability-docs deploy:check
```

Browser tests cover all scenario transitions, code/graph synchronization, keyboard controls,
client navigation, theme changes, mobile overflow, and no-JavaScript content. `pnpm check`
includes normal docs tasks through Turbo; CI also runs browser checks. `deploy:check` is
only a Wrangler dry run. Do not deploy or change live domains without user authorization.

## Styling and framework updates

- Nimbus tokens: `src/styles/globals.css` (`--nb-*`, dark mode `data-mode="dark"`).
- Durability overrides: `src/styles/custom.css`.
- Native diagram styling is local to `src/components/architecture/walkthrough.css`.
- Mermaid needs `data-theme`; `BaseLayout.astro` bridges Nimbus's theme state. Its fence
  transform is registered in Nimbus's Sätteri pipeline in `src/lib/mermaid.ts`.

Keep `AgentDirective` in the base layout and the generated agent-readable routes. Do not
remove discovery or search as a shortcut around a build failure. `nimbus.json` records the
scaffold baseline; review versioned migrations with the installed Nimbus CLI before
updating that baseline. Do not reset or discard unrelated work to update scaffold files.

## Deployment invariants

Keep the existing Worker entry and `ASSETS` binding, both Custom Domains, and
`run_worker_first: true`. `durability.shirei.dev` serves docs; `shirei.dev` returns a
path/query-preserving permanent redirect. No SSR adapter, database, or remote execution
service is needed for these walkthroughs.
