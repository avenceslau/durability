import type { SerializedError } from './errors.js';

/** Completion counts and timings cover the same rolling observation window. */
export type ProcessingLoad = {
  inFlight: number;
  completed: number;
  averageProcessingMs: number | null;
};

export type LoadSnapshot = {
  observedAt: number;
  windowMs: number;
  inbound: ProcessingLoad;
  outbound: ProcessingLoad & { pendingDeliveries: number };
};

/** Success means accepted durably, not delivered to any target. */
export type EnqueueResult<T, E = SerializedError> =
  | { success: true; value: T; load: LoadSnapshot }
  | { success: false; error: E; load: LoadSnapshot };

type Bucket = { second: number; count: number; durationMs: number };
type Direction = 'inbound' | 'outbound';

/**
 * Local advisory telemetry, reset on eviction. Sixty one-second buckets bound
 * memory independently of traffic; in-flight counts are instantaneous.
 */
export class RoutingLoad {
  private readonly buckets: Record<Direction, Map<number, Bucket>> = {
    inbound: new Map(),
    outbound: new Map(),
  };
  private readonly active: Record<Direction, number> = {
    inbound: 0,
    outbound: 0,
  };

  /** Begins an observed request and returns an idempotent completion callback. */
  begin(direction: Direction): () => void {
    const startedAt = Date.now();
    this.active[direction] += 1;
    let finished = false;
    return () => {
      if (finished) {
        return;
      }
      finished = true;
      this.active[direction] -= 1;
      const now = Date.now();
      const second = Math.floor(now / 1_000);
      const slot = second % 60;
      const previous = this.buckets[direction].get(slot);
      const bucket =
        previous?.second === second
          ? previous
          : { second, count: 0, durationMs: 0 };
      bucket.count += 1;
      bucket.durationMs += Math.max(0, now - startedAt);
      this.buckets[direction].set(slot, bucket);
    };
  }

  /** Backlog comes from durable state, never reconstructed from telemetry. */
  snapshot(pendingDeliveries: number): LoadSnapshot {
    const now = Date.now();
    return {
      observedAt: now,
      windowMs: 60_000,
      inbound: this.processing('inbound', now),
      outbound: {
        ...this.processing('outbound', now),
        pendingDeliveries,
      },
    };
  }

  private processing(direction: Direction, now: number): ProcessingLoad {
    const second = Math.floor(now / 1_000);
    let completed = 0;
    let durationMs = 0;
    for (const bucket of this.buckets[direction].values()) {
      if (bucket.second <= second && bucket.second > second - 60) {
        completed += bucket.count;
        durationMs += bucket.durationMs;
      }
    }
    return {
      inFlight: this.active[direction],
      completed,
      averageProcessingMs: completed === 0 ? null : durationMs / completed,
    };
  }
}
