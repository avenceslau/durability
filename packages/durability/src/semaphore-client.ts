import { SemaphoreProtocolError } from './errors.js';
import {
  permitGrantSchema,
  permitSyncResultSchema,
  type PermitGrant,
  type PermitRequest,
  type PermitSync,
  type PermitSyncResult,
  type SemaphoreRequest,
  type SemaphoreResponse,
} from './semaphore-protocol.js';

export type SemaphoreAddress = {
  /** The semaphore key: the name of the Durable Object holding the limit. */
  key: string;
  locationHint?: DurableObjectLocationHint;
};

export type SemaphoreClientConfig = {
  invoke(
    address: SemaphoreAddress,
    message: SemaphoreRequest
  ): Promise<SemaphoreResponse>;
  locationHint?: (key: string) => DurableObjectLocationHint | undefined;
};

/**
 * Transport-independent protocol core. Validates responses and remembers each
 * key's `nextRequestAt` so callers can pace requests the way the holder asked.
 */
export class SemaphoreClient {
  readonly #config: SemaphoreClientConfig;
  readonly #nextRequestAt = new Map<string, number>();

  constructor(config: SemaphoreClientConfig) {
    this.#config = config;
  }

  /** Earliest time the holder of `key` accepts another request, if known. */
  nextRequestAt(key: string): number | undefined {
    return this.#nextRequestAt.get(key);
  }

  async request(key: string, message: PermitRequest): Promise<PermitGrant> {
    const response = await this.#config.invoke(this.#address(key), message);
    const parsed = permitGrantSchema.safeParse(response);
    if (!parsed.success) {
      throw new SemaphoreProtocolError(
        `Unexpected response to a permit request for "${key}"`
      );
    }
    this.#nextRequestAt.set(key, parsed.data.nextRequestAt);
    // Advisory state must stay bounded for high-cardinality keys.
    if (this.#nextRequestAt.size > 1_024) {
      const oldest = this.#nextRequestAt.keys().next().value;
      if (oldest !== undefined) {
        this.#nextRequestAt.delete(oldest);
      }
    }
    return parsed.data;
  }

  async sync(key: string, message: PermitSync): Promise<PermitSyncResult> {
    const response = await this.#config.invoke(this.#address(key), message);
    const parsed = permitSyncResultSchema.safeParse(response);
    if (!parsed.success) {
      throw new SemaphoreProtocolError(
        `Unexpected response to a permit sync for "${key}"`
      );
    }
    return parsed.data;
  }

  #address(key: string): SemaphoreAddress {
    if (typeof key !== 'string' || key.length === 0) {
      throw new SemaphoreProtocolError(
        'Semaphore keys must be non-empty strings'
      );
    }
    const locationHint = this.#config.locationHint?.(key);
    return locationHint === undefined ? { key } : { key, locationHint };
  }
}
