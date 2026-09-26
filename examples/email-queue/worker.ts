import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { defineTransform, timeout } from '@durability/transforms';
import {
  DurabilityFanout,
  DurabilityScheduler,
  type DurabilityFanoutMessage,
  type FanoutEnqueueOptions,
  type FanoutInput,
  type StoredMessage,
} from 'durability';
import { DurabilityRouting, type RoutingSession } from 'durability/routing';

type Env = {
  DEAD_LETTERS: R2Bucket;
  EMAIL_API: Fetcher;
  EMAIL_CONSUMER: Service<EmailConsumer>;
};

type Email = {
  to: string;
  subject: string;
  body: string;
  customerId: string;
  region?: DurableObjectLocationHint;
};
type Batch = { messages: FanoutInput<Email>[]; options?: FanoutEnqueueOptions };
type Context = { lane?: string };

export class EmailConsumer extends WorkerEntrypoint<Env> {
  async consume(messages: DurabilityFanoutMessage<Email>[]) {
    for (const message of messages) {
      // The upstream must deduplicate successful side effects across redeliveries.
      // eslint-disable-next-line no-await-in-loop
      const response = await this.env.EMAIL_API.fetch(
        'https://email-api/send',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': message.id },
          body: JSON.stringify(message.body),
        }
      );
      if (response.ok) {
        // eslint-disable-next-line no-await-in-loop
        await message.ack();
      } else if (response.status === 400) {
        // eslint-disable-next-line no-await-in-loop
        await message.deadLetter();
      } else if (response.status === 429) {
        // eslint-disable-next-line no-await-in-loop
        await message.retry(30_000);
      }
      // Unsettled messages retry; exhausting the budget dead-letters this target only.
    }
  }
}

// One bucket, two prefixes: every message is archived, failures are parked.
const archivePrefix = 'email-archive/';
const deadLetterPrefix = 'email-dlq/';
const replayWindowMs = 30 * 24 * 60 * 60 * 1_000;

/** The application owns this DO and composes its capabilities explicitly. */
export class EmailDelivery extends DurableObject<Env> {
  private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
  private readonly routing = new DurabilityRouting();
  private readonly fanout = new DurabilityFanout<Email>({
    scheduler: this.scheduler,
    routing: this.routing,
    targets: {
      email: {
        deliver: (messages) => this.env.EMAIL_CONSUMER.consume(messages),
      },
      // A storage destination is just a callback. Keying each object by the
      // delivery identity and refusing to overwrite makes retried writes
      // idempotent, so a redrive deletes exactly what it re-enqueued.
      archive: {
        storage: async (message) => {
          await this.env.DEAD_LETTERS.put(
            `${archivePrefix}${encodeURIComponent(message.id)}`,
            JSON.stringify(message),
            { onlyIf: { etagDoesNotMatch: '*' } }
          );
        },
      },
    },
    dlq: async (message) => {
      await this.env.DEAD_LETTERS.put(
        `${deadLetterPrefix}${encodeURIComponent(message.id)}`,
        JSON.stringify(message),
        { onlyIf: { etagDoesNotMatch: '*' } }
      );
    },
    maxBatchSize: 25,
    attemptTimeoutMs: 30_000,
    retries: { maxAttempts: 5 },
  });

  enqueue(batch: Batch) {
    return this.fanout.enqueue(batch.messages, batch.options);
  }

  override alarm(info?: AlarmInvocationInfo) {
    return this.scheduler.alarm(info);
  }
}

export const routing = DurabilityRouting.client({
  target: EmailDelivery,
  // Vite injects exportName from this application class and Wrangler's config.
  invoke: (stub, batch: Batch) => stub.enqueue(batch),
  sharding: (batch, context: Context | undefined) => ({
    shard:
      context?.lane ??
      `customer-${batch.messages[0]?.body.customerId ?? 'unknown'}`,
    ...(batch.messages[0]?.body.region === undefined
      ? {}
      : { locationHint: batch.messages[0].body.region }),
  }),
});

const lane = defineTransform<
  RoutingSession<Batch, string[], Context>,
  Context
>().caller(
  (name: string) =>
    async ({ next }) =>
      next({ context: { lane: name } })
);

/**
 * Administrative redrive: read the parked entries, route each failed target
 * again, and delete only what was accepted. Reading is application policy, so
 * this walks the bucket directly.
 */
export async function redrive(env: Env, after: number): Promise<number> {
  // Entries older than the replay window are ignored here; an R2 lifecycle
  // rule on the prefix does the physical deletion.
  const cutoff = Math.max(after, Date.now() - replayWindowMs);
  let cursor: string | undefined;
  let accepted = 0;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await env.DEAD_LETTERS.list({
      prefix: deadLetterPrefix,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) {
      // eslint-disable-next-line no-await-in-loop
      const stored = await env.DEAD_LETTERS.get(object.key);
      if (!stored) {
        continue;
      }
      // This Worker wrote the entry; an application reading foreign data should
      // validate it instead of casting.
      // eslint-disable-next-line no-await-in-loop
      const entry = (await stored.json()) as StoredMessage<Email>;
      if (entry.storedAt < cutoff) {
        continue;
      }
      // The entry ID distinguishes this redrive from the original registration,
      // so it cannot collide with siblings still delivering.
      // eslint-disable-next-line no-await-in-loop
      const result = await routing.push({
        messages: [
          { id: entry.messageId, body: entry.body, deduplicationKey: entry.id },
        ],
        options: { targets: [entry.target] },
      });
      if (!result.success) {
        continue;
      }
      // Never delete on rejection or transport uncertainty. A crash between
      // acceptance and deletion can still duplicate work: this is at-least-once.
      // eslint-disable-next-line no-await-in-loop
      await env.DEAD_LETTERS.delete(object.key);
      accepted += 1;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return accepted;
}

export default {
  async fetch(request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('POST an email array', { status: 405 });
    }
    // Demo input only: authenticate and validate untrusted payloads in an application.
    const messages = (await request.json<Email[]>()).map((body) => ({ body }));
    const result = await routing
      .with(lane, 'vip')
      .with(timeout, 5_000)
      .push({ messages });
    return Response.json(result, { status: result.success ? 202 : 409 });
  },
} satisfies ExportedHandler<Env>;
