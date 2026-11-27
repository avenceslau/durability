/**
 * A load generator for the queue in `../queue`, driven from its dashboard.
 * It runs inside Cloudflare, so it reaches rates a laptop or a browser tab
 * cannot: many Durable Objects each send a little.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { QueueEntrypoint } from '@queues-example/queue/consumer';
import type { LoadOptions, LoadStatus } from '@queues-example/queue/load';
import { controller, type Env } from './run';

export { LoadController } from './controller';
export { LoadGenerator } from './generator';

/** What the queue's dashboard calls, through the queue's `LOADGEN` binding. */
export class LoadControl extends WorkerEntrypoint<Env> {
  start(options: LoadOptions): Promise<LoadStatus> {
    return controller().start(options);
  }

  stop(): Promise<LoadStatus> {
    return controller().stop();
  }

  status(): Promise<LoadStatus> {
    return controller().status();
  }

  deleteQueues(): Promise<number> {
    return controller().deleteQueues();
  }
}

/**
 * The target of every tenant's queue, through the queue's `LOAD_SINK`
 * binding. Returning acknowledges the whole batch, so the test measures the
 * queue and not a consumer.
 */
export class Sink extends QueueEntrypoint<Env, unknown> {
  queue(): void {}
}

export default {
  fetch: () => new Response('Not found', { status: 404 }),
} satisfies ExportedHandler<Env>;
