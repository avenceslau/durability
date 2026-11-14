/**
 * The template's Worker plus a target the tests can observe: a service
 * binding whose deliveries are recorded in a Durable Object.
 */
import {
  DurableObject,
  WorkerEntrypoint,
  exports as workerExports,
} from 'cloudflare:workers';
import type { Delivery } from '../src/targets';

export * from '../src/index';
export { default } from '../src/index';
// The test runner finds entrypoints by name in this file, not through `export *`.
export { QueueBinding } from '../src/index';

export type Behaviour = {
  /** Deliveries answered with 500 before the target starts accepting. */
  failures?: number;
  /** How long each delivery takes. */
  delayMs?: number;
};

export type Received = {
  target: string;
  partition: string;
  attempt: number;
  keys: string[];
  bodies: number[];
};

const stores = () =>
  (workerExports as Record<string, unknown>)[
    'SinkStore'
  ] as DurableObjectNamespace<SinkStore>;

export class SinkStore extends DurableObject {
  private received: Received[] = [];
  private behaviours = new Map<string, Behaviour>();
  private running = 0;
  private mostRunning = 0;

  behave(target: string, behaviour: Behaviour): void {
    this.behaviours.set(target, behaviour);
  }

  async receive(delivery: Delivery): Promise<number> {
    const behaviour = this.behaviours.get(delivery.target) ?? {};
    this.running += 1;
    this.mostRunning = Math.max(this.mostRunning, this.running);
    try {
      if (behaviour.delayMs !== undefined) {
        await scheduler.wait(behaviour.delayMs);
      }
      if ((behaviour.failures ?? 0) > 0) {
        behaviour.failures! -= 1;
        return 500;
      }
      this.received.push({
        target: delivery.target,
        partition: delivery.partition,
        attempt: delivery.attempt,
        keys: delivery.messages.map((message) => message.key),
        bodies: delivery.messages.map((message) => message.body as number),
      });
      return 200;
    } finally {
      this.running -= 1;
    }
  }

  deliveries(target: string): Received[] {
    return this.received.filter((entry) => entry.target === target);
  }

  mostRunningAtOnce(): number {
    return this.mostRunning;
  }
}

export class Sink extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const delivery = await request.json<Delivery>();
    const status = await stores().getByName(delivery.queue).receive(delivery);
    return new Response(null, { status });
  }
}
