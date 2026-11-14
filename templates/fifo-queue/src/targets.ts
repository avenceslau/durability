import { env } from 'cloudflare:workers';
import type { Destination } from './model';
import { send } from './send';

export type Delivery = {
  queue: string;
  target: string;
  /** `queue/epoch/index` of the partition this batch came from. */
  partition: string;
  /** One-based; a batch is redelivered until it succeeds or is dead-lettered. */
  attempt: number;
  messages: {
    id: string;
    key: string;
    offset: number;
    body: unknown;
    sentAt: number;
  }[];
};

export type DeliveryOutcome =
  | { ok: true }
  | { ok: false; error: string; retryAfterMs?: number };

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

/** The first and last offsets identify a batch across redeliveries. */
export const batchKey = (delivery: Delivery): string => {
  const first = delivery.messages[0]!.offset;
  const last = delivery.messages[delivery.messages.length - 1]!.offset;
  return `${delivery.partition}/${first}-${last}`;
};

const retryAfterMs = (response: Response): number | undefined => {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
};

const post = async (
  fetcher: { fetch: typeof fetch },
  url: string,
  delivery: Delivery,
  timeoutMs: number,
  secret?: string
): Promise<DeliveryOutcome> => {
  const body = JSON.stringify(delivery);
  const response = await fetcher.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Two targets may share a receiver, so the target is part of the key.
      'Idempotency-Key': `${delivery.target}/${batchKey(delivery)}`,
      ...(secret === undefined
        ? {}
        : { 'X-Queue-Signature': `sha256=${await sign(secret, body)}` }),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  // The body is not needed; an unread one would hold the connection open.
  await response.body?.cancel();
  if (response.ok) {
    return { ok: true };
  }

  const wait = retryAfterMs(response);
  return {
    ok: false,
    error: `Target answered ${response.status}`,
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
  };
};

const forward = async (
  queue: string,
  delivery: Delivery
): Promise<DeliveryOutcome> => {
  const outcome = await send(
    queue,
    delivery.messages.map((message) => ({
      key: message.key,
      body: message.body,
      // Stable across redeliveries, so the destination accepts each once.
      id: `${delivery.target}/${delivery.partition}/${message.offset}`,
    }))
  );
  const rejection = outcome.rejected[0];
  return rejection
    ? {
        ok: false,
        error: `${rejection.error.name}: ${rejection.error.message}`,
      }
    : { ok: true };
};

const archive = async (delivery: Delivery): Promise<DeliveryOutcome> => {
  await env.STORAGE.put(
    `archive/${delivery.queue}/${delivery.target}/${batchKey(delivery)}`,
    JSON.stringify(delivery),
    // A redelivered batch must not replace the copy already written.
    { onlyIf: { etagDoesNotMatch: '*' } }
  );
  return { ok: true };
};

/** Hands one batch to a target. A thrown error counts as a failed attempt. */
export const deliver = (
  destination: Destination,
  delivery: Delivery,
  timeoutMs: number
): Promise<DeliveryOutcome> => {
  if (destination.type === 'webhook') {
    return post(
      { fetch: (input, init) => fetch(input, init) },
      destination.url,
      delivery,
      timeoutMs,
      destination.secret
    );
  }
  if (destination.type === 'queue') {
    return forward(destination.queue, delivery);
  }
  if (destination.type === 'archive') {
    return archive(delivery);
  }

  const service = (env as unknown as Record<string, unknown>)[
    destination.binding
  ];
  if (
    typeof service !== 'object' ||
    service === null ||
    !('fetch' in service) ||
    typeof service.fetch !== 'function'
  ) {
    return Promise.resolve({
      ok: false,
      error: `No service binding named "${destination.binding}"`,
    });
  }
  return post(
    service as { fetch: typeof fetch },
    'https://queue-target/',
    delivery,
    timeoutMs
  );
};
