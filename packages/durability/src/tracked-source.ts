/** Result types keyed by record name: operation, alarm name, or custom names. */
export type TrackedResults = Record<string, unknown>;

export type TrackedStatus = 'pending' | 'completed' | 'failed';

/**
 * The persisted state of one tracked record. Finer outcomes, such as
 * cancellation or expiry, are `failed` with a specific `error.name`.
 */
export type TrackedState<Result> =
  | {
      status: 'pending';
      attempt?: number;
      nextAttemptAt?: number;
      lastError?: string | null;
      /** Keys whose memoized results the next attempt reuses, in the order they were saved. */
      memoized?: string[];
    }
  | {
      status: 'completed';
      result: Result;
    }
  | {
      status: 'failed';
      attempt?: number;
      error: { name: string; message: string };
    };

export type Names<Results> = Extract<keyof Results, string>;

export type TrackedEntry<Name extends string, Result> = {
  /** Unique within its source. */
  id: string;
  name: Name;
  /** Opaque; changes when an id is reused for new work. */
  generation: string;
  createdAt: number;
  state: TrackedState<Result>;
};

/** One record of a source, narrowed by `name` to that name's result type. */
export type TrackedRecord<Results extends TrackedResults> = {
  [Name in Names<Results>]: TrackedEntry<Name, Results[Name]>;
}[Names<Results>];

export type TrackedQuery<Results extends TrackedResults> = {
  limit: number;
  /** Opaque position from a previous page. */
  cursor?: string | undefined;
  status?: TrackedStatus | undefined;
  name?: Names<Results> | undefined;
};

export type TrackedPage<Results extends TrackedResults> = {
  /** May hold fewer than `limit` records even when `cursor` is present. */
  records: TrackedRecord<Results>[];
  /** Present when more records may follow; omit it at the end. */
  cursor?: string;
};

/**
 * What a tracker reads from a source. New members are always optional, so
 * custom sources keep compiling across releases.
 *
 * @experimental
 */
export type TrackedSource<Results extends TrackedResults> = {
  get(id: string): Promise<TrackedRecord<Results> | undefined>;
  list(query: TrackedQuery<Results>): Promise<TrackedPage<Results>>;
  /**
   * Calls `listener` after the record may have settled and returns an
   * unsubscribe function. Pass the settled record when it can no longer be
   * read, for example because success deletes it; otherwise pass nothing and
   * the tracker re-reads. Without `watch`, `wait` re-reads at its timeout.
   */
  watch?(
    id: string,
    listener: (settled?: TrackedRecord<Results>) => void
  ): () => void;
};

export type UntypedRecord = TrackedEntry<string, unknown>;

/**
 * Any source regardless of its result types. Written out structurally because
 * `TrackedSource<R>` uses `keyof R`, which makes it invariant in `R`.
 */
export type UntypedSource = {
  get(id: string): Promise<UntypedRecord | undefined>;
  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: TrackedStatus | undefined;
    name?: string | undefined;
  }): Promise<{ records: UntypedRecord[]; cursor?: string }>;
  watch?(id: string, listener: (settled?: UntypedRecord) => void): () => void;
};

// Built-in capabilities register here instead of exposing a method, so the
// experimental contract never appears on their public types.
const builtInSources = new WeakMap<object, UntypedSource>();

export const registerTrackedSource = (
  owner: object,
  source: UntypedSource
): void => {
  builtInSources.set(owner, source);
};

export const trackedSourceOf = (owner: object): UntypedSource | undefined =>
  builtInSources.get(owner);
