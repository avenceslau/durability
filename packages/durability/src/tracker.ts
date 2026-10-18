import { z } from 'zod';
import { traceMethods } from './dev.js';
import type {
  AnyDurabilityAlarms,
  DurabilityAlarms,
} from './durability-alarms.js';
import type {
  AnyDurability,
  Durability,
  OperationResults,
} from './durability.js';
import {
  trackedSourceOf,
  type Names,
  type TrackedEntry,
  type TrackedResults,
  type TrackedSource,
  type TrackedState,
  type TrackedStatus,
  type UntypedRecord,
  type UntypedSource,
} from './tracked-source.js';

/** A tracked state, or `not_found` when the record or its generation is gone. */
export type TrackedResult<Result> =
  | TrackedState<Result>
  | { status: 'not_found' };

type TrackerSources = Record<
  string,
  UntypedSource | AnyDurability | AnyDurabilityAlarms
>;

type SourceResults<Source> =
  Source extends Durability<infer Handlers>
    ? OperationResults<Handlers>
    : Source extends DurabilityAlarms<infer AlarmNames>
      ? Record<AlarmNames, undefined>
      : Source extends TrackedSource<infer Results>
        ? Results
        : never;

type SourceKey<Sources> = Extract<keyof Sources, string>;

export type TrackedWaitOptions = {
  /** Maximum time to wait before returning the latest state. */
  timeoutMs: number;
};

/**
 * A record plus the key of the source it came from. Plain data, so it can be
 * sent over JSON transports such as `DurabilitySocket`.
 */
export type TrackedItem<
  Source extends string,
  Results extends TrackedResults,
> = {
  [Name in Names<Results>]: TrackedEntry<Name, Results[Name]> & {
    source: Source;
  };
}[Names<Results>];

/**
 * A record snapshot plus functions to read or wait on it. Over Workers RPC or
 * Cap'n Web the data is copied and the functions become stubs.
 */
export type TrackedHandle<
  Source extends string,
  Results extends TrackedResults,
> = {
  [Name in Names<Results>]: TrackedEntry<Name, Results[Name]> & {
    source: Source;
    /** Reads the latest state of this generation. */
    get(): Promise<TrackedResult<Results[Name]>>;
    /** Resolves on settlement, or returns the latest state after the timeout. */
    wait(options: TrackedWaitOptions): Promise<TrackedResult<Results[Name]>>;
  };
}[Names<Results>];

export type TrackerRecord<
  Sources extends TrackerSources,
  Key extends SourceKey<Sources> = SourceKey<Sources>,
> = {
  [K in Key]: TrackedItem<K, SourceResults<Sources[K]>>;
}[Key];

export type TrackerHandle<
  Sources extends TrackerSources,
  Key extends SourceKey<Sources> = SourceKey<Sources>,
> = {
  [K in Key]: TrackedHandle<K, SourceResults<Sources[K]>>;
}[Key];

export type TrackerQuery<
  Sources extends TrackerSources,
  Key extends SourceKey<Sources> = SourceKey<Sources>,
> = {
  source?: Key | undefined;
  name?: string | undefined;
  status?: TrackedStatus | undefined;
  /** Defaults to 50; at most 100 because every handle carries RPC stubs. */
  limit?: number | undefined;
  cursor?: string | undefined;
};

export type TrackerPage<
  Sources extends TrackerSources,
  Key extends SourceKey<Sources> = SourceKey<Sources>,
> = {
  items: TrackerHandle<Sources, Key>[];
  cursor?: string;
};

export type TrackerRecordPage<
  Sources extends TrackerSources,
  Key extends SourceKey<Sources> = SourceKey<Sources>,
> = {
  records: TrackerRecord<Sources, Key>[];
  cursor?: string;
};

export type DurabilityTrackerConfig<Sources extends TrackerSources> = {
  /** Keys name each source and become the records' `source` discriminator. */
  sources: Sources;
};

type AnyResult = TrackedResult<unknown>;
type AnyItem = UntypedRecord & { source: string };
type AnyHandle = AnyItem & {
  get(): Promise<AnyResult>;
  wait(options: TrackedWaitOptions): Promise<AnyResult>;
};
type Found = { source: UntypedSource; item: AnyItem };

const limitSchema = z.number().int().min(1).max(100);
const cursorSchema = z.tuple([
  z.number().int().nonnegative(),
  z.string().nullable(),
]);

const resultFor = (
  entry: UntypedRecord,
  record: UntypedRecord | undefined
): AnyResult =>
  record?.generation === entry.generation
    ? record.state
    : { status: 'not_found' };

// Copy only contract fields so extras from custom sources never leave the object.
const itemFor = (key: string, record: UntypedRecord): AnyItem => ({
  source: key,
  id: record.id,
  name: record.name,
  generation: record.generation,
  createdAt: record.createdAt,
  state: record.state,
});

/**
 * Lists work across `Durability`, `DurabilityAlarms`, and custom sources.
 * `list` and `get` return handles that can be read or waited on, locally or
 * over RPC; `records` returns the same pages as plain data.
 *
 * @experimental
 *
 * @example
 * ```ts
 * class ImageJobs extends DurableObject<Env> {
 *   private readonly tracker = new DurabilityTracker({
 *     sources: { jobs: this.durability, alarms: this.alarms },
 *   });
 *
 *   listWork(cursor?: string) {
 *     return this.tracker.list({ status: 'pending', cursor });
 *   }
 * }
 * ```
 */
export class DurabilityTracker<Sources extends TrackerSources> {
  readonly #sources: Array<[string, UntypedSource]>;

  constructor(config: DurabilityTrackerConfig<Sources>) {
    this.#sources = Object.entries(config.sources).map(([key, input]) => [
      key,
      trackedSourceOf(input) ?? (input as UntypedSource),
    ]);
  }

  /** Returns one page of handles; pass `cursor` back with the same query. */
  async list<Key extends SourceKey<Sources> = SourceKey<Sources>>(
    query: TrackerQuery<Sources, Key> = {}
  ): Promise<TrackerPage<Sources, Key>> {
    const { found, cursor } = await this.#collect(query);
    const items = found.map(({ source, item }) => this.#handle(source, item));
    const page = cursor === undefined ? { items } : { items, cursor };
    return page as unknown as TrackerPage<Sources, Key>;
  }

  /**
   * Returns one page of plain records, for transports that cannot carry
   * functions; pass `cursor` back with the same query.
   */
  async records<Key extends SourceKey<Sources> = SourceKey<Sources>>(
    query: TrackerQuery<Sources, Key> = {}
  ): Promise<TrackerRecordPage<Sources, Key>> {
    const { found, cursor } = await this.#collect(query);
    const records = found.map(({ item }) => item);
    const page = cursor === undefined ? { records } : { records, cursor };
    return page as unknown as TrackerRecordPage<Sources, Key>;
  }

  /** Reacquires a handle by id, for example after an RPC disconnect. */
  async get<Key extends SourceKey<Sources>>(
    source: Key,
    id: string
  ): Promise<TrackerHandle<Sources, Key> | undefined> {
    const [key, resolved] = this.#source(source);
    const record = await resolved.get(id);
    if (!record) {
      return undefined;
    }
    return this.#handle(
      resolved,
      itemFor(key, record)
    ) as unknown as TrackerHandle<Sources, Key>;
  }

  async #collect(
    query: TrackerQuery<Sources, SourceKey<Sources>>
  ): Promise<{ found: Found[]; cursor: string | undefined }> {
    const limit = limitSchema.parse(query.limit ?? 50);
    const candidates =
      query.source === undefined ? this.#sources : [this.#source(query.source)];
    const [start, startCursor] =
      query.cursor === undefined
        ? [0, null]
        : cursorSchema.parse(JSON.parse(query.cursor));

    const found: Found[] = [];
    for (const [offset, [key, source]] of candidates.slice(start).entries()) {
      const index = start + offset;
      if (found.length >= limit) {
        return { found, cursor: JSON.stringify([index, null]) };
      }

      // Sources are paged in order so the cursor only tracks one position.
      // eslint-disable-next-line no-await-in-loop
      const page = await source.list({
        limit: limit - found.length,
        cursor: offset === 0 ? (startCursor ?? undefined) : undefined,
        status: query.status,
        name: query.name,
      });
      for (const record of page.records) {
        found.push({ source, item: itemFor(key, record) });
      }
      if (page.cursor !== undefined) {
        return { found, cursor: JSON.stringify([index, page.cursor]) };
      }
    }
    return { found, cursor: undefined };
  }

  #source(key: string): [string, UntypedSource] {
    const found = this.#sources.find(([candidate]) => candidate === key);
    if (!found) {
      throw new Error(`Unknown tracked source "${key}"`);
    }
    return found;
  }

  #handle(source: UntypedSource, item: AnyItem): AnyHandle {
    return {
      ...item,
      get: async () => resultFor(item, await source.get(item.id)),
      wait: (options) => this.#wait(source, item, options),
    };
  }

  #wait(
    source: UntypedSource,
    entry: UntypedRecord,
    options: TrackedWaitOptions
  ): Promise<AnyResult> {
    const timeoutMs = options?.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(
        new RangeError('timeoutMs must be a non-negative safe integer')
      );
    }

    const read = async () => resultFor(entry, await source.get(entry.id));
    return new Promise<AnyResult>((resolve, reject) => {
      let done = false;
      let unwatch: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (settle: () => void) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        unwatch?.();
        settle();
      };
      const fail = (error: unknown) => finish(() => reject(error));
      const resolveIfSettled = (result: AnyResult) => {
        if (result.status !== 'pending') {
          finish(() => resolve(result));
        }
      };
      const check = (settled?: UntypedRecord) => {
        if (settled) {
          resolveIfSettled(resultFor(entry, settled));
          return;
        }
        read().then(resolveIfSettled, fail);
      };

      // Subscribe before the first read so a settlement in between is not missed.
      unwatch = source.watch?.(entry.id, check);
      if (done) {
        unwatch?.();
        return;
      }
      timer = setTimeout(() => {
        read().then((result) => finish(() => resolve(result)), fail);
      }, timeoutMs);
      check();
    });
  }
}

traceMethods(DurabilityTracker.prototype, 'DurabilityTracker');
