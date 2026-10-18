import {
  TopologyUnavailableError,
  type TopologyFallbackReason,
} from './errors.js';
import { assertPositiveInteger } from './policy.js';
import {
  decodeSnapshot,
  type TopologyMemberInput,
  type TopologySnapshot,
} from './topology-snapshot.js';

export type TopologySource = 'published' | 'stale' | 'seed' | 'fallback';

export type TopologyView<Meta = undefined> = TopologySnapshot<Meta> & {
  source: TopologySource;
  fetchedAt: number;
};

export type TopologyClientConfig<Meta = undefined> = {
  /** Returns the `encoded` value the coordinator's publisher stored, or null. */
  read(group: string): Promise<string | null | undefined>;
  /** Defaults to 1 second. */
  readTimeoutMs?: number;
  /** Defaults to 30 seconds, jittered by ±20% so isolates do not refresh together. */
  ttlMs?: number;
  /** How long a missing or failed read is remembered before reading again. Defaults to 5 seconds. */
  negativeTtlMs?: number;
  /** Expected holder for a group, computed locally. Snapshots from any other holder are `invalid`. */
  holder?(group: string): string | DurableObjectId;
  /** Opt-in: serve this isolate's last good snapshot for this long after it expires when a read fails. */
  staleIfErrorMs?: number;
  /** Opt-in: members derived locally, without I/O. */
  seed?(group: string): readonly TopologyMemberInput<Meta>[] | undefined;
  /** Opt-in and application-owned. Not cached: whatever it calls runs on every fallback. */
  fallback?(
    group: string,
    reason: TopologyFallbackReason
  ): Promise<TopologySnapshot<Meta> | undefined>;
  onFallback?(event: {
    group: string;
    reason: TopologyFallbackReason;
    source: TopologySource | 'none';
  }): void;
};

type Entry<Meta> = {
  /** The last good published snapshot. */
  view?: TopologyView<Meta>;
  staleUntil: number;
  /** When the next get reads the store again. */
  expiresAt: number;
  failure?: { reason: TopologyFallbackReason; cause?: unknown };
};

// High-cardinality groups (one per tenant) must not grow an isolate without bound; the least recently used go first.
const maxCachedGroups = 1_024;

class ReadTimeoutError extends Error {}

const jittered = (ms: number): number =>
  Math.round(ms * (0.8 + Math.random() * 0.4));

/** Read-only. Created by `DurabilityTopology.client`. */
export class TopologyClient<Meta = undefined> {
  readonly #config: TopologyClientConfig<Meta>;
  readonly #readTimeoutMs: number;
  readonly #ttlMs: number;
  readonly #negativeTtlMs: number;
  readonly #cache = new Map<string, Entry<Meta>>();
  readonly #inflight = new Map<string, Promise<TopologyView<Meta>>>();

  constructor(config: TopologyClientConfig<Meta>) {
    if (typeof config.read !== 'function') {
      throw new TypeError('A topology client needs a read function');
    }
    this.#readTimeoutMs = config.readTimeoutMs ?? 1_000;
    this.#ttlMs = config.ttlMs ?? 30_000;
    this.#negativeTtlMs = config.negativeTtlMs ?? 5_000;
    assertPositiveInteger('readTimeoutMs', this.#readTimeoutMs);
    assertPositiveInteger('ttlMs', this.#ttlMs);
    assertPositiveInteger('negativeTtlMs', this.#negativeTtlMs);
    if (
      config.staleIfErrorMs !== undefined &&
      (!Number.isSafeInteger(config.staleIfErrorMs) ||
        config.staleIfErrorMs < 0)
    ) {
      throw new RangeError('staleIfErrorMs must be a non-negative integer');
    }
    this.#config = config;
  }

  /**
   * Returns the group's snapshot from this isolate's cache or the read store.
   * Concurrent calls share one read, and a newer snapshot is never replaced by
   * an older one. Throws {@link TopologyUnavailableError} when the published
   * snapshot is unusable and no opt-in fallback produced one.
   */
  get(group: string): Promise<TopologyView<Meta>> {
    const entry = this.#cache.get(group);
    if (entry && Date.now() < entry.expiresAt) {
      if (entry.failure) {
        return this.#fallback(group, entry);
      }
      if (entry.view) {
        this.#remember(group, entry);
        return Promise.resolve(entry.view);
      }
    }

    const inflight = this.#inflight.get(group);
    if (inflight) {
      return inflight;
    }
    const run = this.#load(group).finally(() => this.#inflight.delete(group));
    this.#inflight.set(group, run);
    return run;
  }

  async #load(group: string): Promise<TopologyView<Meta>> {
    const previous = this.#cache.get(group);
    const result = await this.#read(group);
    const now = Date.now();

    if ('snapshot' in result) {
      const { snapshot } = result;
      // The store is eventually consistent; a lagging replica must not move readers backwards.
      const keep =
        previous?.view !== undefined &&
        previous.view.holder === snapshot.holder &&
        previous.view.version > snapshot.version;
      const view = keep
        ? previous.view!
        : { ...snapshot, source: 'published' as const, fetchedAt: now };
      const expiresAt = now + jittered(this.#ttlMs);
      this.#remember(group, {
        view,
        expiresAt,
        staleUntil: expiresAt + (this.#config.staleIfErrorMs ?? 0),
      });
      return view;
    }

    const entry: Entry<Meta> = {
      // A missing group is not an error, so nothing stale may be served for it.
      ...(result.failure.reason === 'missing' || !previous?.view
        ? {}
        : { view: previous.view }),
      staleUntil: previous?.staleUntil ?? 0,
      expiresAt: now + jittered(this.#negativeTtlMs),
      failure: result.failure,
    };
    this.#remember(group, entry);
    return this.#fallback(group, entry);
  }

  async #read(
    group: string
  ): Promise<
    | { snapshot: TopologySnapshot<Meta> }
    | { failure: NonNullable<Entry<Meta>['failure']> }
  > {
    let encoded: string | null | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      encoded = await Promise.race([
        Promise.resolve().then(() => this.#config.read(group)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ReadTimeoutError()),
            this.#readTimeoutMs
          );
        }),
      ]);
    } catch (cause) {
      return {
        failure: {
          reason: cause instanceof ReadTimeoutError ? 'timeout' : 'error',
          cause,
        },
      };
    } finally {
      clearTimeout(timer);
    }

    if (encoded === null || encoded === undefined) {
      return { failure: { reason: 'missing' } };
    }
    try {
      const snapshot = decodeSnapshot<Meta>(encoded);
      if (snapshot.group !== group) {
        throw new Error(`Snapshot belongs to group "${snapshot.group}"`);
      }
      const holder = this.#config.holder?.(group);
      if (holder !== undefined && String(holder) !== snapshot.holder) {
        throw new Error(
          `Snapshot was published by holder "${snapshot.holder}"`
        );
      }
      return { snapshot };
    } catch (cause) {
      return { failure: { reason: 'invalid', cause } };
    }
  }

  async #fallback(
    group: string,
    entry: Entry<Meta>
  ): Promise<TopologyView<Meta>> {
    const { reason, cause } = entry.failure!;
    const notify = (source: TopologySource | 'none') =>
      this.#config.onFallback?.({ group, reason, source });

    if (
      this.#config.staleIfErrorMs !== undefined &&
      entry.view !== undefined &&
      Date.now() < entry.staleUntil
    ) {
      notify('stale');
      return { ...entry.view, source: 'stale' };
    }

    const seeded = this.#config.seed?.(group);
    if (seeded !== undefined && seeded.length > 0) {
      notify('seed');
      return {
        group,
        version: 0,
        holder: '',
        members: seeded
          .map((member) => ({ ...member, joinedAt: 0 }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
        source: 'seed',
        fetchedAt: Date.now(),
      };
    }

    const fallback = await this.#config.fallback?.(group, reason);
    if (fallback !== undefined) {
      notify('fallback');
      return { ...fallback, source: 'fallback', fetchedAt: Date.now() };
    }

    notify('none');
    throw new TopologyUnavailableError(group, reason, { cause });
  }

  #remember(group: string, entry: Entry<Meta>): void {
    this.#cache.delete(group);
    this.#cache.set(group, entry);
    if (this.#cache.size > maxCachedGroups) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) {
        this.#cache.delete(oldest);
      }
    }
  }
}
