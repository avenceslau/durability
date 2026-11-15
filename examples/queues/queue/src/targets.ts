import { env } from 'cloudflare:workers';
import type { QueueDelivery, QueueSettlement } from './consumer';
import { pullLogKey } from './layout';
import type { TargetDestination } from './model';
import { send } from './send';

export type Delivery = QueueDelivery;
export type Settlement = QueueSettlement;

/** Destinations that keep whole batches, so a batch is written or it is not. */
export type StorageDestination = Extract<
  TargetDestination,
  { type: 'archive' | 'pull' }
>;
/** Destinations that answer for each message. */
export type ConsumerDestination = Exclude<
  TargetDestination,
  StorageDestination
>;

export const storesBatches = (
  destination: TargetDestination
): destination is StorageDestination =>
  destination.type === 'archive' || destination.type === 'pull';

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const sign = async (secret: string, body: string): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
};

/** The first and last offsets name a batch in storage. */
export const batchKey = (delivery: Delivery): string => {
  const first = delivery.messages[0]!.offset;
  const last = delivery.messages[delivery.messages.length - 1]!.offset;
  return `${delivery.partition}/${first}-${last}`;
};

export const retryAll = (
  delivery: Delivery,
  delaySeconds?: number
): Settlement => ({
  acked: [],
  retried: delivery.messages.map((message) =>
    delaySeconds === undefined
      ? { id: message.id }
      : { id: message.id, delaySeconds }
  ),
});

/**
 * Reads what a consumer answered. The answer crossed a trust boundary, so it
 * only counts for messages that were in the batch; a message the consumer did
 * not acknowledge is retried.
 */
const settlementFrom = (delivery: Delivery, answer: unknown): Settlement => {
  const listed = (name: 'acked' | 'retried'): unknown[] => {
    const list =
      typeof answer === 'object' && answer !== null
        ? (answer as Record<string, unknown>)[name]
        : undefined;
    return Array.isArray(list) ? list : [];
  };
  const acked = new Set(listed('acked').filter((id) => typeof id === 'string'));
  const delays = new Map<string, number | undefined>();
  for (const entry of listed('retried')) {
    if (typeof entry === 'string') {
      delays.set(entry, undefined);
      continue;
    }
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const { id, delaySeconds } = entry as Record<string, unknown>;
    if (typeof id === 'string') {
      delays.set(
        id,
        typeof delaySeconds === 'number' ? delaySeconds : undefined
      );
    }
  }

  const settlement: Settlement = { acked: [], retried: [] };
  for (const { id } of delivery.messages) {
    if (acked.has(id) && !delays.has(id)) {
      settlement.acked.push(id);
      continue;
    }
    const delaySeconds = delays.get(id);
    settlement.retried.push(
      delaySeconds === undefined ? { id } : { id, delaySeconds }
    );
  }
  return settlement;
};

/**
 * POSTs the batch. Any answer but 2xx retries every message. A 2xx answer
 * acknowledges every message, except those its JSON body lists as `retried`:
 * `{ "retried": ["id", { "id": "…", "delaySeconds": 30 }] }`.
 */
const post = async (
  fetcher: { fetch: typeof fetch },
  url: string,
  delivery: Delivery,
  timeoutMs: number,
  secret?: string
): Promise<Settlement> => {
  const body = JSON.stringify(delivery);
  const response = await fetcher.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret === undefined
        ? {}
        : { 'X-Queue-Signature': `sha256=${await sign(secret, body)}` }),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    // The body is not needed; an unread one would hold the connection open.
    await response.body?.cancel();
    const seconds = Number(response.headers.get('Retry-After'));
    return retryAll(
      delivery,
      Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
    );
  }

  const answer: unknown = await response.json().catch(() => undefined);
  return settlementFrom(delivery, {
    acked: delivery.messages.map((message) => message.id),
    retried:
      typeof answer === 'object' && answer !== null
        ? (answer as Record<string, unknown>)['retried']
        : undefined,
  });
};

const binding = (name: string): object => {
  const service = (env as unknown as Record<string, unknown>)[name];
  if (typeof service !== 'object' || service === null) {
    throw new Error(`No service binding named "${name}"`);
  }
  return service;
};

/**
 * One call to a `QueueEntrypoint`. A call cannot be cancelled: after the
 * timeout the messages are retried while the consumer may still be running.
 */
const call = async (
  name: string,
  delivery: Delivery,
  timeoutMs: number
): Promise<Settlement> => {
  const consumer = binding(name) as {
    deliverQueueBatch(delivery: Delivery): Promise<unknown>;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      consumer.deliverQueueBatch(delivery),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Consumer took longer than ${timeoutMs} ms`)),
          timeoutMs
        );
      }),
    ]);
    return settlementFrom(delivery, answer);
  } finally {
    clearTimeout(timer);
  }
};

const forward = async (
  queue: string,
  delivery: Delivery
): Promise<Settlement> => {
  // Stable across redeliveries, so the destination accepts each once.
  const forwardedId = (offset: number) =>
    `${delivery.target}/${delivery.partition}/${offset}`;
  const outcome = await send(
    queue,
    delivery.messages.map((message) => ({
      key: message.key,
      body: message.body,
      id: forwardedId(message.offset),
    }))
  );
  const accepted = new Set(outcome.accepted);
  return settlementFrom(delivery, {
    acked: delivery.messages
      .filter((message) => accepted.has(forwardedId(message.offset)))
      .map((message) => message.id),
  });
};

/**
 * Hands one batch to a consumer and resolves to what it did with each
 * message. A thrown error means nothing is known: retry every message.
 */
export const deliver = (
  destination: ConsumerDestination,
  delivery: Delivery,
  timeoutMs: number
): Promise<Settlement> => {
  if (destination.type === 'rpc') {
    return call(destination.binding, delivery, timeoutMs);
  }
  if (destination.type === 'queue') {
    return forward(destination.queue, delivery);
  }
  if (destination.type === 'service') {
    return post(
      binding(destination.binding) as { fetch: typeof fetch },
      'https://queue-target/',
      delivery,
      timeoutMs
    );
  }
  return post(
    { fetch: (input, init) => fetch(input, init) },
    destination.url,
    delivery,
    timeoutMs,
    destination.secret
  );
};

/**
 * Writes one batch as one object and resolves to its key. A thrown error
 * means it was not written.
 */
export const store = async (
  destination: StorageDestination,
  delivery: Delivery
): Promise<string> => {
  const first = delivery.messages[0]!.offset;
  const last = delivery.messages[delivery.messages.length - 1]!.offset;
  const [bucket, key] =
    destination.type === 'pull'
      ? [env.PULL, pullLogKey(delivery.partition, first, last)]
      : [
          env.STORAGE,
          `archive/${delivery.queue}/${delivery.target}/${batchKey(delivery)}`,
        ];
  await bucket.put(
    key,
    JSON.stringify(delivery),
    // A redelivered batch must not replace the copy already written.
    { onlyIf: { etagDoesNotMatch: '*' } }
  );
  return key;
};
