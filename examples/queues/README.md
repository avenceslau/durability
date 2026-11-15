# Queues

A queue service and a consumer for it, as two Workers in their own small workspace.

| Worker                             | Name            | What it is                                                                                                                                  |
| ---------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [`queue`](./queue)                 | `fifo-queue`    | A partitioned FIFO queue on Durable Objects: ordered per key, autoscaling, push and pull consumers, dead letters, redrive, and a dashboard. |
| [`push_consumer`](./push_consumer) | `push-consumer` | A Worker that sends orders to the queue and consumes them over RPC, by extending `QueueEntrypoint`.                                         |

The [queue's README](./queue/README.md) documents its API, and the [architecture guide](https://durability.shirei.dev/compositions/fifo-queue/) explains how it works.

## How they are wired

Each Worker has service bindings to the other:

| Binding       | Declared in                    | Points at                       | Used for                                                  |
| ------------- | ------------------------------ | ------------------------------- | --------------------------------------------------------- |
| `QUEUE`       | `push_consumer/wrangler.jsonc` | `fifo-queue`, `QueueBinding`    | Sending, and pulling for pull consumers.                  |
| `QUEUE_ADMIN` | `push_consumer/wrangler.jsonc` | `fifo-queue`, `QueueAdmin`      | Creating the `orders` queue and registering its target.   |
| `ORDERS`      | `queue/wrangler.jsonc`         | `push-consumer`, `Orders` class | The `rpc` target the queue delivers `orders` messages to. |

`push_consumer` imports `QueueEntrypoint` and `MessageBatch` from `@queues-example/queue/consumer`, which depends only on the Workers runtime, and the binding types `QueueBinding` and `QueueAdmin` from `@queues-example/queue`. The queue knows a consumer only by the name of a service binding in its own `wrangler.jsonc`, so adding an `rpc` target for a new Worker means adding a binding and redeploying the queue.

## Deploy

The queue's `ORDERS` binding needs `push-consumer` to exist, so deploy the consumer first:

```sh
pnpm --filter @queues-example/push-consumer deploy
pnpm --filter @queues-example/queue deploy
```

`push-consumer` binds to `fifo-queue` in turn. If Cloudflare refuses the first deploy of either Worker because the other does not exist yet, deploy the queue once with its `services` entry removed, then the consumer, then the queue with the entry restored.

The queue also needs its three secrets (`wrangler secret put ADMIN_TOKEN`, `PRODUCER_TOKEN`, `CONSUMER_TOKEN`), the KV namespace `TOPOLOGY`, and the R2 buckets `fifo-queue` and `fifo-queue-pull` declared in its `wrangler.jsonc`.

## Develop locally

Install from the repository root with `pnpm install`, then copy `queue/.dev.vars.example` to `queue/.dev.vars`. Run the two Workers in two terminals; `wrangler dev` sessions on one machine find each other's service bindings:

```sh
pnpm --filter @queues-example/queue dev                       # dashboard on http://localhost:8787
pnpm --filter @queues-example/push-consumer dev --port 8788
```

Or run both in one session by passing both configurations. The first is the one served over HTTP; the other is reachable only through bindings:

```sh
cd queue
pnpm build
pnpm exec wrangler dev -c wrangler.jsonc -c ../push_consumer/wrangler.jsonc
```

## Use it

`push_consumer` creates the queue and registers itself as a target on `POST /setup`, and sends orders on `POST /orders`. Both routes are open to anyone who can reach the Worker, which suits a demo only: an application sets its queue up from a deploy script or behind authentication.

```sh
curl -X POST http://localhost:8788/setup
curl -X POST http://localhost:8788/orders \
  -d '[{ "customer": "ada", "total": 12 }, { "customer": "declined", "total": 7 }]'
```

The code behind it, shortened:

```ts
import {
  QueueEntrypoint,
  type MessageBatch,
} from '@queues-example/queue/consumer';
import type { QueueAdmin, QueueBinding } from '@queues-example/queue';

type Env = {
  QUEUE: Service<QueueBinding>;
  QUEUE_ADMIN: Service<QueueAdmin>;
};

type Order = {
  customer: string;
  total: number;
};

// The queue calls this with each batch through its `ORDERS` binding.
export class Orders extends QueueEntrypoint<Env, Order> {
  async queue(batch: MessageBatch<Order>): Promise<void> {
    for (const message of batch.messages) {
      await charge(message.body);
      message.ack();
    }
  }
}

// Once: create the queue and register `Orders` as its target.
await env.QUEUE_ADMIN.create('orders', { partitions: { min: 1, max: 8 } });
await env.QUEUE_ADMIN.putTarget('orders', 'billing', {
  destination: { type: 'rpc', binding: 'ORDERS' },
});

// Messages with the same key reach `Orders.queue()` in the order they were sent.
const outcome = await env.QUEUE.send('orders', [
  { key: 'ada', body: { customer: 'ada', total: 12 } },
]);
```

A message whose `charge` throws is retried, because `queue()` threw before acknowledging it. The full `Orders` class in [`push_consumer/src/index.ts`](./push_consumer/src/index.ts) retries a failed order with a delay and skips the rest of that customer's orders in the batch, which the queue would deliver again after the failed one anyway.
