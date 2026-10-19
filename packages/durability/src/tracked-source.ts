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

/**
 * The summarized state returned by `list`. It deliberately omits results,
 * payloads, and error messages, which may hold secrets or customer data and
 * can make a list response unbounded; read those explicitly with `get`.
 */
export type TrackedSummaryState =
  | {
      status: 'pending';
      attempt?: number;
      nextAttemptAt?: number;
    }
  | {
      status: 'completed';
    }
  | {
      status: 'failed';
      attempt?: number;
      error: { name: string };
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

/** One summarized record of a source, narrowed by `name`. */
export type TrackedSummary<Name extends string> = {
  id: string;
  name: Name;
  generation: string;
  createdAt: number;
  state: TrackedSummaryState;
};

/** The summarized record of a source returned by `list`. */
export type TrackedListRecord<Results extends TrackedResults> = {
  [Name in Names<Results>]: TrackedSummary<Name>;
}[Names<Results>];

export type TrackedQuery<Results extends TrackedResults> = {
  limit: number;
  /** Opaque position from a previous page. */
  cursor?: string | undefined;
  status?: TrackedStatus | undefined;
  name?: Names<Results> | undefined;
};

export type TrackedPage<Results extends TrackedResults> = {
  /** May hold fewer than `limit` summaries even when `cursor` is present. */
  records: TrackedListRecord<Results>[];
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

export type UntypedSummary = TrackedSummary<string>;

/** Strips results, payloads, and error messages from a full state. */
export const summaryStateOf = (
  state: TrackedState<unknown> | TrackedSummaryState
): TrackedSummaryState => {
  if (state.status === 'pending') {
    return {
      status: 'pending',
      ...(state.attempt !== undefined ? { attempt: state.attempt } : {}),
      ...(state.nextAttemptAt !== undefined
        ? { nextAttemptAt: state.nextAttemptAt }
        : {}),
    };
  }
  if (state.status === 'failed') {
    return {
      status: 'failed',
      ...(state.attempt !== undefined ? { attempt: state.attempt } : {}),
      error: { name: state.error.name },
    };
  }
  return { status: 'completed' };
};

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
  }): Promise<{ records: UntypedSummary[]; cursor?: string }>;
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
