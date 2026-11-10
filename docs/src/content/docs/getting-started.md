---
title: Getting started
description: Run a SQLite-backed Durable Object, accept a job, and look up its result.
---

This guide runs a complete Worker with no external services. It accepts a word-count job and exposes a separate result endpoint. The handler is deliberately free of external side effects so it is safe to retry.

## Prerequisites

- Node.js 22 or newer and pnpm.
- A Cloudflare account only when deploying; local development needs no credentials.
- A **SQLite-backed** Durable Object. Legacy key-value-backed objects are not supported.

## Run the example

From a clone of the repository:

```sh
git clone https://github.com/avenceslau/durability.git
cd durability
pnpm install
pnpm dlx wrangler dev --config examples/getting-started/wrangler.jsonc
```

The source is in [`examples/getting-started/worker.ts`](https://github.com/avenceslau/durability/blob/main/examples/getting-started/worker.ts); it is typechecked with the other examples. Wrangler serves the Worker locally, normally at `http://localhost:8787`.

For an existing Worker project, install the library instead:

```sh
pnpm add durability
pnpm add -D wrangler typescript
```

## Define your Durable Object

Import `DurableObject` from the Workers runtime and attach a `Durability` instance. Each handler becomes a typed registration method:

```ts
import { DurableObject } from 'cloudflare:workers';
import { Durability, type DurableCall } from 'durability';

type Env = { JOBS: DurableObjectNamespace<Jobs> };
type CountWords = { text: string };

export class Jobs extends DurableObject<Env> {
  private readonly jobs = new Durability({
    context: this.ctx,
    handlers: {
      countWords: async ({ payload }: DurableCall<CountWords>) => ({
        words: payload.text.trim().split(/\s+/u).filter(Boolean).length,
      }),
    },
  });

  submit(id: string, text: string) {
    return this.jobs.countWords({ id, payload: { text } });
  }

  result(id: string) {
    return this.jobs.countWords.getResult(id);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.jobs.alarm(info);
  }
}
```

Do not wait for the handler result in `submit`: registration resolves with `void` once the work is persisted. New work may start eagerly, but pending work survives eviction through the object's physical alarm.

The complete example also exports a Worker fetch handler that routes `POST /jobs/:id` to `submit()` and `GET /jobs/:id` to `result()`. Copy the [complete source](https://github.com/avenceslau/durability/blob/main/examples/getting-started/worker.ts), including that default export, when creating a standalone Worker.

## Configure SQLite and the binding

The example's `wrangler.jsonc` declares both the binding and the class migration:

```jsonc
{
  "name": "durability-getting-started",
  "main": "worker.ts",
  "compatibility_date": "2026-07-07",
  "durable_objects": {
    "bindings": [{ "name": "JOBS", "class_name": "Jobs" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Jobs"] }],
}
```

`main` is relative to the config file. Keep `new_sqlite_classes`, not `new_classes`. In an existing project, add a **new migration tag** rather than changing an already-deployed migration. Durability creates and migrates its own SQL tables when the helper is constructed.

In a standalone project, run `pnpm exec wrangler types` to generate runtime types and include the generated file in your TypeScript configuration. The repository examples already use `@cloudflare/workers-types`.

## Submit and read a job

In another terminal:

```sh
curl -i http://localhost:8787/jobs/word-count-1 \
  -H 'Content-Type: application/json' \
  -d '{"text":"durable work survives retries"}'

curl http://localhost:8787/jobs/word-count-1
```

The POST returns `202` after acceptance. The GET eventually returns:

```json
{ "status": "completed", "result": { "words": 4 } }
```

A lookup can also return `not_found`, `pending`, or `failed`. A pending result includes retry context; a failed result includes a serialized error. See [reading results](/primitives/operations/#reading-results).

Repeat the same POST with the same ID and text: it is a no-op, including after completion. Change the text while reusing the ID and the example returns `409`: IDs cannot silently acquire a new payload. Use a new ID for new logical work.

## Deploy the example

```sh
pnpm dlx wrangler login
pnpm dlx wrangler deploy --config examples/getting-started/wrangler.jsonc
```

This is an unauthenticated demo with one object named `demo`. Before exposing real work, add authentication, authorization, request limits, and a naming strategy appropriate to your workload. For external effects, forward the stable operation `id` to an idempotent receiver.

Next: [concepts and guarantees](/concepts/), [choosing capabilities](/capabilities/), and the [production checklist](/production/).
