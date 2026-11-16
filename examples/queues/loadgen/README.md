# Queue load generator

Sends a steady load to many queues at once, from inside Cloudflare, and is driven from the [queue](../queue)'s dashboard. Use it to see how the queue behaves at a rate a laptop cannot produce: many Durable Objects each send a little.

A run has **tenants**, each with a queue of its own named `load-0`, `load-1`, and so on. Every tenant's queue receives the same number of send requests per second, and each request carries a random number of messages between two bounds, on a random one of the tenant's keys. Each queue has one target, `sink`, which acknowledges everything, so the run measures the queue and not a consumer.

## Deploy

The generator binds to the queue and the queue binds to the generator, so deploy in this order:

```sh
pnpm --filter @queues-example/queue deploy      # as it is, without the generator
pnpm --filter @queues-example/loadgen deploy
# Uncomment the LOADGEN and LOAD_SINK services in ../queue/wrangler.jsonc, then:
pnpm --filter @queues-example/queue deploy
```

| Binding       | Declared in              | Points at                      | Used for                                       |
| ------------- | ------------------------ | ------------------------------ | ---------------------------------------------- |
| `QUEUE`       | `loadgen/wrangler.jsonc` | `fifo-queue`, `QueueBinding`   | Sending.                                       |
| `QUEUE_ADMIN` | `loadgen/wrangler.jsonc` | `fifo-queue`, `QueueAdmin`     | Creating the tenants' queues and their target. |
| `LOADGEN`     | `queue/wrangler.jsonc`   | `queue-loadgen`, `LoadControl` | The dashboard's start, stop, and status.       |
| `LOAD_SINK`   | `queue/wrangler.jsonc`   | `queue-loadgen`, `Sink`        | The `rpc` target of every tenant's queue.      |

The generator has no URL of its own. The dashboard shows a **Load test** card on its first page once the queue has the `LOADGEN` binding.

## Run

On the dashboard, set the tenants, the requests per second for each, the messages per request, the keys per tenant, how long to run, and the partition range of the tenants' queues, then **Start**. The card shows requests and messages per second, what the queue rejected, requests that failed, and send latency; each tenant's queue has its own page with the usual charts.

Set **Quiet, seconds** above 0 for a load that comes in bursts: every generator sends for the burst, stops for the quiet time, and repeats, all at the same moments. The requests per second are the rate during a burst. That is the way to watch a backlog build and drain on the dashboard's first page.

A run always ends by itself after the seconds given, at most an hour. **Stop** ends it at once. **Delete the load queues** removes every `load-<n>` queue and what it holds.

The same over HTTP, for scripts:

```sh
curl -X POST https://<queue>/api/load -H 'Content-Type: application/json' -d '{
  "tenants": 50, "requestsPerSecond": 100, "minMessages": 100, "maxMessages": 300,
  "keys": 1000, "seconds": 300, "burstSeconds": 30, "quietSeconds": 60,
  "partitions": { "min": 8, "max": 32 } }'
curl https://<queue>/api/load            # status; `url` opens the run in the dashboard
curl -X DELETE https://<queue>/api/load  # stop
```

## How it works

| Class            | Role                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `LoadController` | One object. Creates the tenants' queues, hands the run to every generator, wakes them again every 30 seconds, and adds up what they report.    |
| `LoadGenerator`  | Sends to one tenant's queue at up to 25 requests per second, in ticks of ten seconds spread over 100 ms slices, and reports to the controller. |
| `LoadControl`    | The entrypoint the queue's dashboard API calls.                                                                                                |
| `Sink`           | A `QueueEntrypoint` whose `queue()` returns at once, which acknowledges the batch.                                                             |

A tenant at 100 requests per second has four generators; fifty such tenants have two hundred. The load is an **open loop**: a generator starts its requests on schedule whether or not earlier ones were answered, so a queue that falls behind does not slow the load down. What it cannot take shows as rejected messages, failed requests, and latency.

## Limits

- At most 2,000 generators, which is 50,000 requests per second.
- A generator waits for the queue's answer however long it takes, so a request counts as failed only when it throws. The queue has no timeout of its own on a send either.
- Counts are kept by the controller in memory between reports; a restart of the controller during a run loses the per-second numbers for one tick, not the totals.
- This sends real traffic and stores real messages: a run at 5,000 requests per second with 200 messages each is a million messages, and several million Durable Object storage rows, every second. Mind what that costs on your account.
