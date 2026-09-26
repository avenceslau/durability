import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import {
  DurabilityAlarms,
  DurabilityFanout,
  DurabilityScheduler,
  type DurabilityFanoutMessage,
  type FanoutInput,
  type FanoutEnqueueOptions,
  type StoredMessage,
} from '../src';
import { DurabilityRouting } from '../src/routing';

export type TestMessage = {
  action: 'ack' | 'retry' | 'deadLetter' | 'ignore';
  shard: string;
};
export type BatchRequest = {
  messages: FanoutInput<TestMessage>[];
  options?: FanoutEnqueueOptions;
};
export type RouteContext = { shard?: string };

export const archivePrefix = 'archive/';
export const deadLetterPrefix = 'dead-letters/';

const writeTo =
  (bucket: R2Bucket, prefix: string) =>
  async (message: StoredMessage<TestMessage>): Promise<void> => {
    await bucket.put(
      `${prefix}${encodeURIComponent(message.id)}`,
      JSON.stringify(message),
      { onlyIf: { etagDoesNotMatch: '*' } }
    );
  };

type Env = { DEAD_LETTERS: R2Bucket; CONSUMER: Service<FanoutConsumer> };

export class FanoutConsumer extends WorkerEntrypoint<Env> {
  async consume(messages: DurabilityFanoutMessage<TestMessage>[]) {
    await Promise.all(
      messages.map(async (message) => {
        await this.env.DEAD_LETTERS.put(
          `received/${message.id}/${message.attempt}`,
          JSON.stringify({ target: message.target, attempt: message.attempt })
        );
        if (message.body.action === 'ack') {
          await message.ack();
        } else if (message.body.action === 'retry') {
          await (message.attempt === 1 ? message.retry(10) : message.ack());
        } else if (message.body.action === 'deadLetter') {
          await message.deadLetter();
        }
      })
    );
  }
}

export class DeliveryObject extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly routing = new DurabilityRouting();
  private readonly alarms = new DurabilityAlarms({
    scheduler: this.scheduler,
    handlers: {
      cleanup: async () => {
        await this.ctx.storage.put('cleaned', true);
      },
    },
  });
  private readonly fanout = new DurabilityFanout<TestMessage>({
    scheduler: this.scheduler,
    routing: this.routing,
    targets: {
      consumer: { deliver: (messages) => this.env.CONSUMER.consume(messages) },
      archive: { storage: writeTo(this.env.DEAD_LETTERS, archivePrefix) },
    },
    retries: { maxAttempts: 2, delay: () => 10 },
    dlq: writeTo(this.env.DEAD_LETTERS, deadLetterPrefix),
  });

  async enqueue(request: BatchRequest) {
    const result = await this.fanout.enqueue(request.messages, request.options);
    if (!result.success) {
      return result;
    }
    return {
      ...result,
      value: { ids: result.value, shardId: this.ctx.id.toString() },
    };
  }

  load() {
    return this.fanout.load();
  }
  scheduleCleanup(at: number) {
    return this.alarms.cleanup(at);
  }
  cleaned() {
    return this.ctx.storage.get<boolean>('cleaned');
  }
  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export const routing = DurabilityRouting.client({
  target: DeliveryObject,
  exportName: 'DeliveryObject',
  invoke: (stub, input: BatchRequest) => stub.enqueue(input),
  sharding: async (input, context: RouteContext | undefined) => ({
    shard: context?.shard ?? input.messages[0]?.body.shard ?? 'default',
    locationHint: 'weur',
  }),
});
