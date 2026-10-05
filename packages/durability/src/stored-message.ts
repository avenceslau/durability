import type { SerializedError } from './errors.js';

/**
 * One message as handed to a storage destination. Archive and dead-letter
 * writes share this envelope; only `failure` distinguishes them.
 */
export type StoredMessage<Body = unknown> = {
  /** Unique to this registration and target; stable across delivery attempts. */
  id: string;
  messageId: string;
  target: string;
  body: Body;
  enqueuedAt: number;
  storedAt: number;
  attempts: number;
  /** Present only when a target gave up on this message. */
  failure?:
    | {
        reason: 'exhausted' | 'explicit';
        error: SerializedError | null;
      }
    | undefined;
};

/**
 * Everything a storage destination must provide. Fanout only ever writes, so
 * any function is a valid storage target or dead-letter destination.
 *
 * Key each entry by `id` and refuse to overwrite it, so a retried write is
 * idempotent and a redrive removes exactly what it re-enqueued. Reading entries
 * back for replay or redrive is the application's concern.
 */
export type MessageWrite<Body = unknown> = (
  message: StoredMessage<Body>
) => Promise<void>;
