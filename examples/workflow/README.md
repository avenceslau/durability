# Durable Object workflow example

This example runs a workflow directly inside a SQLite-backed Durable Object. `step.do` persists each result, while `step.sleep` releases the object and resumes through its alarm. [`itty-time`](https://github.com/kwhitley/itty-time) converts the readable duration to milliseconds.

```ts
import { ms } from 'itty-time';

const [startedAt, preparedAt] = await Promise.all([
  step.do(
    'record start',
    {
      retries: {
        limit: 3,
        delay: ms('1 second'),
        backoff: 'exponential',
      },
      timeout: ms('30 seconds'),
    },
    async ({ attempt }) => {
      console.log({ attempt });
      return Date.now();
    }
  ),
  step.do('prepare report', async () => Date.now()),
]);

await step.sleep('wait before finishing', ms('2 seconds'));
```

Install dependencies and start Wrangler from the repository root:

```sh
pnpm install
pnpm --filter @durability/example-workflow dev
```

Start a workflow and read its status:

```sh
curl -X POST http://localhost:8787/report-1
curl http://localhost:8787/report-1
```

The HTTP Worker only routes the initial RPC call to the Durable Object. The workflow handler, durable steps, retries, and sleep wake-up all execute inside `ReportWorkflow`; there is no separate Worker invocation between steps.
