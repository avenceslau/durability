/**
 * The queue's Worker plus targets the tests can observe: a service binding
 * that is POSTed to, and a `QueueEntrypoint` consumer. Both record what they
 * accept in a Durable Object.
 */
import {
  DurableObject,
  WorkerEntrypoint,
  exports as workerExports,
} from 'cloudflare:workers';
import { QueueEntrypoint, type MessageBatch } from '../src/consumer';
import type { Delivery } from '../src/targets';

export * from '../src/index';
export { default } from '../src/index';
// The test runner finds entrypoints by name in this file, not through `export *`.
export { QueueAdmin, QueueBinding } from '../src/index';

export type Behaviour = {
  /** Deliveries refused outright before the target starts accepting. */
  failures?: number;
  /** How long each delivery takes. */
  delayMs?: number;
  /** Bodies the target retries the first time it is handed them. */
  retryOnce?: number[];
  /** The delay a POSTed target asks for with each retry. */
  retryDelaySeconds?: number;
};

/** Messages a target acknowledged in one delivery. */
export type Received = {
  target: string;
  partition: string;
  keys: string[];
  bodies: number[];
  attempts: number[];
};

const stores = () =>
  (workerExports as Record<string, unknown>)[
    'SinkStore'
  ] as DurableObjectNamespace<SinkStore>;

export class SinkStore extends DurableObject {
  private received: Received[] = [];
  private behaviours = new Map<string, Behaviour>();
  private retriedOnce = new Set<string>();
  private running = 0;
  private mostRunning = 0;

  behave(target: string, behaviour: Behaviour): void {
    this.behaviours.set(target, behaviour);
  }

  /** Resolves to the ids the target retries, or `refused` for the whole delivery. */
  async receive(delivery: Delivery): Promise<string[] | 'refused'> {
    const behaviour = this.behaviours.get(delivery.target) ?? {};
    this.running += 1;
    this.mostRunning = Math.max(this.mostRunning, this.running);
    try {
      if (behaviour.delayMs !== undefined) {
        await scheduler.wait(behaviour.delayMs);
      }
      if ((behaviour.failures ?? 0) > 0) {
        behaviour.failures! -= 1;
        return 'refused';
      }

      // Like a consumer that cares about order, it stops working on a key
      // at the first message it retries.
      const stoppedKeys = new Set<string>();
      const retried = delivery.messages.filter((message) => {
        const once = `${delivery.target}/${message.id}`;
        const retry =
          stoppedKeys.has(message.key) ||
          (behaviour.retryOnce?.includes(message.body as number) === true &&
            !this.retriedOnce.has(once));
        this.retriedOnce.add(once);
        if (retry) {
          stoppedKeys.add(message.key);
        }
        return retry;
      });
      const accepted = delivery.messages.filter(
        (message) => !retried.includes(message)
      );
      this.received.push({
        target: delivery.target,
        partition: delivery.partition,
        keys: accepted.map((message) => message.key),
        bodies: accepted.map((message) => message.body as number),
        attempts: accepted.map((message) => message.attempts),
      });
      return retried.map((message) => message.id);
    } finally {
      this.running -= 1;
    }
  }

  retryDelaySeconds(target: string): number | undefined {
    return this.behaviours.get(target)?.retryDelaySeconds;
  }

  deliveries(target: string): Received[] {
    return this.received.filter(
      (entry) => entry.target === target && entry.keys.length > 0
    );
  }

  mostRunningAtOnce(): number {
    return this.mostRunning;
  }
}

/** A target the queue POSTs to. It names the messages to retry in its answer. */
export class Sink extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const delivery = await request.json<Delivery>();
    const store = stores().getByName(delivery.queue);
    const retried = await store.receive(delivery);
    if (retried === 'refused') {
      return new Response(null, { status: 500 });
    }
    const delaySeconds = await store.retryDelaySeconds(delivery.target);
    return Response.json({
      retried:
        delaySeconds === undefined
          ? retried
          : retried.map((id) => ({ id, delaySeconds })),
    });
  }
}

/** A target the queue calls over RPC. */
export class RpcSink extends QueueEntrypoint<unknown, number> {
  // The store wants the delivery as the queue sent it, so keep it.
  private delivery: Delivery | undefined;

  override deliverQueueBatch(delivery: Delivery) {
    this.delivery = delivery;
    return super.deliverQueueBatch(delivery);
  }

  async queue(batch: MessageBatch<number>): Promise<void> {
    const retried = await stores()
      .getByName(batch.queue)
      .receive(this.delivery!);
    if (retried === 'refused') {
      throw new Error('The consumer is down');
    }
    for (const message of batch.messages) {
      if (retried.includes(message.id)) {
        message.retry();
      }
    }
  }
}

/** Does what each message's body says, to exercise how a batch is settled. */
export class ScriptedConsumer extends QueueEntrypoint<unknown, string> {
  queue(batch: MessageBatch<string>): void {
    for (const message of batch.messages) {
      if (message.body === 'ack then retry') {
        message.ack();
        message.retry();
      }
      if (message.body === 'retry then ack') {
        message.retry({ delaySeconds: 5 });
        message.ack();
      }
    }
    const bodies = batch.messages.map((message) => message.body);
    if (bodies.includes('retry all')) {
      batch.retryAll({ delaySeconds: 9 });
      batch.ackAll();
    }
    if (bodies.includes('ack all')) {
      batch.ackAll();
    }
    if (bodies.includes('throw')) {
      throw new Error('The consumer failed');
    }
  }
}
