# Durability documentation

This is an Astro 7 / Nimbus site deployed as a static-assets Cloudflare Worker.
The framework provides content/runtime helpers; the layouts, UI, and custom architecture
walkthroughs in this directory are project-owned source. Preserve the separate page and
source file for every primitive.

## Content and navigation

- `src/content/docs/primitives/*.mdx`: one primitive each, including API, internals,
  durable versus in-memory state, and recovery semantics. Each has a
  `## How it uses your Durable Object` section with its walkthrough: the tables it keeps
  in `ctx.storage.sql`, how it uses the object's one alarm, what only the live instance
  holds, and which methods the class must delegate.
- `src/content/docs/compositions/*.mdx`: end-to-end systems with code-linked
  walkthroughs. Failure sequences are walkthrough scenarios.
- Every diagram is an interactive walkthrough. Do not add Mermaid or static images of
  architecture.
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

- `src/components/architecture/ArchitectureWalkthrough.astro`: preview and explorer UI.
- `src/components/architecture/walkthrough.client.ts`: synchronized source, node, and step
  interactions; renders the diagram with React. Use Nimbus's `mount()` cleanup lifecycle
  for client-side navigation.
- `src/architecture/<example>.ts`: one model per page, exporting `walkthrough` with
  `id` equal to the file name. `index.ts` globs the directory; pages pass the file name
  as `<ArchitectureWalkthrough example="...">`.
- `src/lib/architecture.ts`: source extraction, focus ranges, validation, source URLs,
  and the per-scenario diagrams.
- `src/kit/architecture/`: slide-kit's `<Architecture>` renderer, copied from
  `~/projects/slide-kit` (commit `b3c1f48`) without the slide engine, the sketch variant,
  or framer-motion, plus `onSelectNode`. Its layout, routing, and stage tokens are
  documented in slide-kit's README ("Architecture diagrams"). Keep local changes small so
  upstream fixes can be copied over; the directory keeps slide-kit's formatting and is
  excluded from oxfmt.

A model's `diagram` is a slide-kit definition without `stages`. Every step shows the
whole diagram, like the preview, and dims what it is not about: give each step a
`focus:<node>` or `flow:<name>` spotlight. An `id` or `+id` token marks a node the step
introduces; the step card points at it, and it is focused when the step has no
spotlight. Other visibility tokens are validated but have no effect. `details`
holds every node's inspector text, contract link, and the excerpt to jump to.

Diagram conventions: `direction: 'down'`, `routing: 'auto'`, a canvas near
1000×900, one group box per Durable Object around what lives in it, external systems
outside with `tone: 'external'`, explicit `rank`/`row` hints, sublabels of about 20
characters or fewer, and no two parallel edges between one pair of nodes. Flows: blue
writes and registration, orange execution, green recovery.

Import actual example and library files with `?raw`; never maintain copied code or line numbers.
Use unique anchors with `sourceExcerpt()` / `sourceFocus()`. Build-time validation must
fail when an anchor disappears or graph references become invalid. Example files and
`packages/durability/src` and `tests` are docs Turbo inputs.

Walkthroughs are explanatory traces, **not executable simulations**. Keep failure windows
and unimplemented recovery explicit. A passed idempotency header is not receiver-side
deduplication. A lifecycle hook is best effort even if it calls a durable enqueue. Snapshot
resync cannot invent a projection event that was never enqueued.

After changing a diagram, run the layout test (no overlapping nodes, no crossing edges,
in any stage), then screenshot every scenario and dark mode against a running dev server
and look at the images: `node .shots/shoot.mjs <path> <name> <last step> [scenario] [dark]`
(`.shots/` is ignored by git). Check that labels sit on their own edge, nothing is
clipped, text stays inside its box, and the spotlight matches the step's text.

Keep the guide lightweight: show only a diagram preview. Open a full-screen native
dialog for the linked diagram and complete source files. Use anchors for highlighting,
not for truncating displayed code. Selecting a node must switch/scroll to its code.
Escape/close must restore focus and release the page scroll lock, including on navigation.
The step title, description, and ← / → buttons are a card placed beside the node the
step is about (the focused node, else the nodes the step adds), on the side that covers
the least of what the step spotlights; on narrow screens the card sits under the
diagram. Scenario selection, the step list, durable/volatile notes, and the inspector
stay behind Details. Do not restore an
inline dashboard.

Keep semantic buttons, focus indicators, source-line keyboard activation, durable/volatile
text notes, reduced-motion support, and no-JavaScript fallback. The preview loops through
the whole system and then each flow with edges (`previewDiagram`), only while it is on
screen and the explorer is closed; under reduced motion it stays the static build-time
drawing. The explorer itself never autoplays.
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

`pnpm --filter durability-docs test` includes the kit's own tests and the diagram layout
test. Browser tests cover all scenario transitions, code/graph synchronization, keyboard controls,
client navigation, theme changes, mobile overflow, and no-JavaScript content. `pnpm check`
includes normal docs tasks through Turbo; CI also runs browser checks. `deploy:check` is
only a Wrangler dry run. Do not deploy or change live domains without user authorization.

## Styling and framework updates

- Nimbus tokens: `src/styles/globals.css` (`--nb-*`, dark mode `data-mode="dark"`).
- Durability overrides: `src/styles/custom.css`.
- Walkthrough styling is local to `src/components/architecture/walkthrough.css`, which
  also maps Nimbus tokens onto the tokens the copied kit reads (`--accent`, `--flow-*`, …).

Keep `AgentDirective` in the base layout and the generated agent-readable routes. Do not
remove discovery or search as a shortcut around a build failure. `nimbus.json` records the
scaffold baseline; review versioned migrations with the installed Nimbus CLI before
updating that baseline. Do not reset or discard unrelated work to update scaffold files.

## Deployment invariants

Keep the existing Worker entry and `ASSETS` binding, both Custom Domains, and
`run_worker_first: true`. `durability.shirei.dev` serves docs; `shirei.dev` returns a
path/query-preserving permanent redirect. No SSR adapter, database, or remote execution
service is needed for these walkthroughs.
