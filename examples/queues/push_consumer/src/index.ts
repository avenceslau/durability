/**
 * A Worker on the other side of the queue. It sends orders, and it is one of
 * the queue's targets: the queue calls `Orders.queue()` with each batch.
 *
 * The queue reaches this class through a service binding in its own
 * `wrangler.jsonc`; `POST /setup` then registers it as a target.
 */
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

const queue = 'orders';

/** Stands in for the real work. It fails for one customer, to show a retry. */
const charge = async (order: Order): Promise<void> => {
  if (order.customer === 'declined') {
    throw new Error(`Card of ${order.customer} was declined`);
  }
  console.log({ event: 'order.charged', ...order });
};

export class Orders extends QueueEntrypoint<Env, Order> {
  async queue(batch: MessageBatch<Order>): Promise<void> {
    // Messages of one key arrive in order. Once one of them fails, the rest
    // of that key wait for it, so stop working on the key.
    const failedKeys = new Set<string>();
    for (const message of batch.messages) {
      if (failedKeys.has(message.key)) {
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await charge(message.body);
        message.ack();
      } catch (error) {
        console.error({ event: 'order.failed', id: message.id, error });
        failedKeys.add(message.key);
        // Back off a little longer each time; after the target's maxRetries
        // the queue moves the message to its dead letters.
        message.retry({ delaySeconds: 2 ** message.attempts });
      }
    }
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== 'POST') {
      return new Response('POST /setup once, then POST /orders', {
        status: 405,
      });
    }

    if (pathname === '/setup') {
      const queues = await env.QUEUE_ADMIN.list();
      if (!queues.some((entry) => entry.name === queue)) {
        await env.QUEUE_ADMIN.create(queue, {
          partitions: { min: 1, max: 8 },
        });
      }
      await env.QUEUE_ADMIN.putTarget(queue, 'billing', {
        // The name of the queue's service binding to `Orders`.
        destination: { type: 'rpc', binding: 'ORDERS' },
        maxBatchSize: 10,
        maxRetries: 3,
      });
      return Response.json(await env.QUEUE_ADMIN.overview(queue));
    }

    if (pathname === '/orders') {
      // Demo input only: authenticate and validate it in an application.
      const orders = await request.json<Order[]>();
      const outcome = await env.QUEUE.send(
        queue,
        // One customer's orders stay in order.
        orders.map((order) => ({ key: order.customer, body: order }))
      );
      return Response.json(outcome, {
        status: outcome.rejected.length === 0 ? 202 : 503,
      });
    }
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
