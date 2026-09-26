import { RoutingError } from './errors.js';
import type { EnqueueResult, LoadSnapshot } from './load.js';

export type RoutingTarget =
  | string
  | { shard: string; locationHint?: DurableObjectLocationHint };

export type RoutingAddress = {
  shard: string;
  locationHint?: DurableObjectLocationHint;
};

/** Routing context is caller-owned and is not persisted or sent to consumers. */
export type Sharding<Input, Context = unknown> = (
  input: Input,
  context: Context | undefined,
  observations: ReadonlyMap<string, LoadSnapshot>
) => RoutingTarget | Promise<RoutingTarget>;

export type RoutingClientConfig<Input, Value, Context = unknown> = {
  invoke(address: RoutingAddress, input: Input): Promise<EnqueueResult<Value>>;
  sharding?: Sharding<Input, Context>;
  softBacklogLimit?: number;
};

/**
 * Transport-independent selection and observation. Every push invokes ONE
 * shard once. A false result is returned unchanged; transport failures throw.
 * Only caller policy decides whether, where, or when to retry.
 */
export class RoutingClient<Input, Value, Context = unknown> {
  readonly #config: RoutingClientConfig<Input, Value, Context>;
  readonly #observations = new Map<string, LoadSnapshot>();
  readonly #limit: number;
  #width = 1;
  #lastResize = -Infinity;

  constructor(config: RoutingClientConfig<Input, Value, Context>) {
    this.#limit = config.softBacklogLimit ?? 1_000;
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1) {
      throw new RangeError('softBacklogLimit must be a positive safe integer');
    }
    this.#config = config;
  }

  /** Returns a copy; stale observations cannot influence custom routing. */
  observations(): ReadonlyMap<string, LoadSnapshot> {
    for (const [key, load] of this.#observations) {
      if (Date.now() - load.observedAt >= load.windowMs) {
        this.#observations.delete(key);
      }
    }
    return new Map(
      [...this.#observations].map(([key, load]) => [key, structuredClone(load)])
    );
  }

  async push(input: Input, context?: Context): Promise<EnqueueResult<Value>> {
    const observed = this.observations();
    const target = this.#config.sharding
      ? await this.#config.sharding(input, context, observed)
      : this.#select(observed);
    const address = typeof target === 'string' ? { shard: target } : target;
    if (
      !address ||
      typeof address.shard !== 'string' ||
      address.shard.length === 0
    ) {
      throw new RoutingError(
        'Sharding must return a non-empty shard key or { shard, locationHint }'
      );
    }
    const response = await this.#config.invoke(address, input);
    const prior = this.#observations.get(address.shard);
    if (!prior || response.load.observedAt >= prior.observedAt) {
      this.#observations.delete(address.shard);
      this.#observations.set(address.shard, structuredClone(response.load));
    }
    // Advisory state must stay bounded for high-cardinality tenant routing.
    if (this.#observations.size > 1_024) {
      const oldest = this.#observations.keys().next().value;
      if (oldest !== undefined) {
        this.#observations.delete(oldest);
      }
    }
    if (!this.#config.sharding) {
      this.#resize(response.load);
    }
    return response;
  }

  #select(observations: ReadonlyMap<string, LoadSnapshot>): string {
    const first = `shard-${Math.floor(Math.random() * this.#width)}`;
    const second = `shard-${Math.floor(Math.random() * this.#width)}`;
    const a = observations.get(first);
    const b = observations.get(second);
    if (!a || !b) {
      return !a ? first : second;
    }
    // Backlog counts are message-target pairs; timing describes target batches.
    // Compare these separately rather than claiming a bogus drain-time estimate.
    if (a.outbound.pendingDeliveries !== b.outbound.pendingDeliveries) {
      return a.outbound.pendingDeliveries < b.outbound.pendingDeliveries
        ? first
        : second;
    }
    const pressure = (load: LoadSnapshot) =>
      load.inbound.inFlight * (load.inbound.averageProcessingMs ?? 0) +
      load.outbound.inFlight * (load.outbound.averageProcessingMs ?? 0);
    return pressure(a) <= pressure(b) ? first : second;
  }

  #resize(load: LoadSnapshot): void {
    const now = Date.now();
    if (now - load.observedAt >= load.windowMs) {
      return;
    }
    if (
      load.outbound.pendingDeliveries > this.#limit &&
      now - this.#lastResize >= 1_000
    ) {
      this.#width += 1;
      this.#lastResize = now;
      return;
    }
    if (
      this.#width > 1 &&
      now - this.#lastResize >= load.windowMs &&
      load.outbound.pendingDeliveries < this.#limit / 4 &&
      load.inbound.inFlight === 0 &&
      load.outbound.inFlight === 0
    ) {
      this.#width -= 1;
      this.#lastResize = now;
    }
  }
}
