/**
 * What a Worker needs to consume from the queue over RPC. It depends on
 * nothing but the Workers runtime, so a consumer Worker can import it without
 * pulling in the queue itself.
 *
 * The consumer side has the shape of a Cloudflare Queues consumer: a batch of
 * messages, each acknowledged or retried on its own.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';

export type QueueRetryOptions = {
  /** How long to wait before the message is delivered again. */
  delaySeconds?: number;
};

export interface Message<Body = unknown> {
  /** The same on every delivery of this message: deduplicate on it. */
  readonly id: string;
  /** Messages that share a key are delivered in the order they were sent. */
  readonly key: string;
  readonly timestamp: Date;
  readonly body: Body;
  /** How many times this message has been delivered, this time included. Starts at 1. */
  readonly attempts: number;
  /** Marks the message as done, whether or not `queue()` returns. */
  ack(): void;
  /** Asks for the message to be delivered again. */
  retry(options?: QueueRetryOptions): void;
}

export interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly Message<Body>[];
  ackAll(): void;
  retryAll(options?: QueueRetryOptions): void;
}

/** A batch as the queue sends it: plain data, in one call. */
export type QueueDelivery = {
  queue: string;
  target: string;
  /** `queue/epoch/index` of the partition the messages came from. */
  partition: string;
  messages: {
    id: string;
    key: string;
    offset: number;
    body: unknown;
    sentAt: number;
    attempts: number;
  }[];
};

/** What happened to a batch. A message in neither list is delivered again. */
export type QueueSettlement = {
  acked: string[];
  retried: {
    id: string;
    delaySeconds?: number;
  }[];
};

type Decision = 'ack' | { retry: QueueRetryOptions };

declare const consumesQueue: unique symbol;

/**
 * `WorkerEntrypoint` as a consumer sees it, without `queue`. The runtime
 * declares that name as the handler Cloudflare Queues calls, with its own
 * batch type. A consumer of this queue is never registered for that, so the
 * name is taken back for the batch type above.
 */
declare abstract class EntrypointWithoutQueue<Env>
  implements Rpc.WorkerEntrypointBranded
{
  // eslint-disable-next-line no-undef, no-underscore-dangle
  [Rpc.__WORKER_ENTRYPOINT_BRAND]: never;
  protected ctx: ExecutionContext;
  protected env: Env;
  constructor(ctx: ExecutionContext, env: Env);
  fetch?(request: Request): Response | Promise<Response>;
}

const Entrypoint = WorkerEntrypoint as unknown as typeof EntrypointWithoutQueue;

/**
 * Extend this in a Worker to receive a queue's messages, then add the class
 * to the queue as an `rpc` target.
 *
 * ```ts
 * export class Orders extends QueueEntrypoint<Env, Order> {
 *   async queue(batch: MessageBatch<Order>) {
 *     for (const message of batch.messages) {
 *       await charge(message.body);
 *       message.ack();
 *     }
 *   }
 * }
 * ```
 *
 * Settlement follows Cloudflare Queues. The first `ack()` or `retry()` on a
 * message wins, and a call on a message beats `ackAll()` and `retryAll()`.
 * When `queue()` returns, messages it left alone are acknowledged; when it
 * throws, they are retried. A message is delivered at least once, so the work
 * has to be safe to repeat for the same `id`.
 *
 * Order is per key. If an earlier message of a key is retried, the later ones
 * of that key in the batch are delivered again after it, whatever was decided
 * for them; stop at the first failure of a key if its order matters.
 */
export abstract class QueueEntrypoint<
  Env = unknown,
  Body = unknown,
> extends Entrypoint<Env> {
  /** Lets a binding be typed as a queue consumer and nothing else. */
  declare readonly [consumesQueue]: true;

  abstract queue(batch: MessageBatch<Body>): void | Promise<void>;

  /**
   * The one call the queue makes. The batch is settled here, when `queue()`
   * finishes, so settling costs no call back to the queue per message.
   */
  async deliverQueueBatch(delivery: QueueDelivery): Promise<QueueSettlement> {
    const decisions = new Map<string, Decision>();
    let forAll: Decision | undefined;

    const batch: MessageBatch<Body> = {
      queue: delivery.queue,
      messages: delivery.messages.map((message) => ({
        id: message.id,
        key: message.key,
        timestamp: new Date(message.sentAt),
        body: message.body as Body,
        attempts: message.attempts,
        ack: () => {
          if (!decisions.has(message.id)) {
            decisions.set(message.id, 'ack');
          }
        },
        retry: (options = {}) => {
          if (!decisions.has(message.id)) {
            decisions.set(message.id, { retry: options });
          }
        },
      })),
      ackAll: () => {
        forAll ??= 'ack';
      },
      retryAll: (options = {}) => {
        forAll ??= { retry: options };
      },
    };

    let unsettled: Decision = 'ack';
    try {
      await this.queue(batch);
    } catch (error) {
      console.error({ event: 'queue.consumer.failed', error });
      unsettled = { retry: {} };
    }

    const settlement: QueueSettlement = { acked: [], retried: [] };
    for (const { id } of delivery.messages) {
      const decision = decisions.get(id) ?? forAll ?? unsettled;
      if (decision === 'ack') {
        settlement.acked.push(id);
        continue;
      }
      const { delaySeconds } = decision.retry;
      settlement.retried.push(
        delaySeconds === undefined ? { id } : { id, delaySeconds }
      );
    }
    return settlement;
  }
}
