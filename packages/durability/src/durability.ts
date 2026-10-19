import { z } from 'zod';
import { traceFunction, traceMethods } from './dev.js';
import {
  DuplicateDurableCallError,
  DuplicateDurablePayloadError,
  DurableAttemptsExhaustedError,
  DurableAttemptTimeoutError,
  DurableCancellationError,
  DurablePayloadCompatibilityError,
  DurablePayloadDecodeError,
  DurableResultSerializationError,
  isErrorInstance,
  NonRetryableError,
  reportFailure,
  serializeError,
} from './errors.js';
import {
  createLifecycleHooks,
  type DurabilityLifecycleEvent,
  type LifecycleHook,
  type LifecycleHooks,
  type OperationLifecycleEntity,
} from './lifecycle.js';
import {
  durabilityOperationMigrations,
  migrate,
  type DurabilityMigrationResult,
  type MigrateOptions,
} from './migrations.js';
import {
  assertPositiveInteger,
  createPolicyResolver,
  methodOptionsSchema,
  type DurabilityMethodOptions,
  type ExecutionPolicyOptions,
  type MethodPolicy,
  type PayloadMigrator,
  type PolicyResolver,
} from './policy.js';
import {
  engineFor,
  type ActiveExecution,
  type Engine,
  type SchedulerAttachment,
} from './scheduler.js';
import { canonical, deserialize, serialize } from './serialization.js';
import { listCreated, updateAttempt, type DurableTable } from './storage.js';
import {
  registerTrackedSource,
  type TrackedState,
  type UntypedRecord,
  type UntypedSource,
  type UntypedSummary,
} from './tracked-source.js';

const callRowSchema = z.object({
  id: z.string(),
  operation: z.string(),
  payload: z.string(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  result: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  next_attempt_at: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  last_error_name: z.string().nullable(),
  completed_at: z.number().int().nonnegative().nullable(),
  created_at: z.number().int().nonnegative(),
  generation_id: z.string(),
  cancelled_at: z.number().int().nonnegative().nullable(),
  cancel_reason: z.string().nullable(),
  payload_version: z.number().int().positive(),
  retry_cycle: z.number().int().nonnegative(),
  total_attempts: z.number().int().nonnegative(),
});

/** Cancellation reasons longer than this are truncated before they are stored. */
const maxCancelReasonLength = 1_024;

const boundedReason = (reason: string | undefined): string | null => {
  if (reason === undefined) {
    return null;
  }
  return reason.length > maxCancelReasonLength
    ? reason.slice(0, maxCancelReasonLength)
    : reason;
};

/** Blocked work waits at least this long, instead of consuming a retry, before a recheck. */
const minCompatibilityBackoffMs = 60_000;
/** ...and at most this long, so an operation removed for good wakes the object hourly, not every minute. */
const maxCompatibilityBackoffMs = 60 * 60_000;

type OperationCompatibility = {
  version: number;
  migrators: Map<number, PayloadMigrator>;
};

const emptyCompatibility: OperationCompatibility = {
  version: 1,
  migrators: new Map(),
};

const resolveCompatibility = (
  methods: Record<string, DurabilityMethodOptions | undefined>
): ((operation: string) => OperationCompatibility) => {
  const parsed = new Map<string, OperationCompatibility>();
  for (const [name, option] of Object.entries(methods)) {
    const version = option?.payloadVersion ?? 1;
    assertPositiveInteger(`methods.${name}.payloadVersion`, version);
    const migrators = new Map<number, PayloadMigrator>();
    for (const [key, migrator] of Object.entries(
      option?.migratePayload ?? {}
    )) {
      const from = Number(key);
      assertPositiveInteger(`methods.${name}.migratePayload key`, from);
      if (typeof migrator !== 'function') {
        throw new TypeError(
          `methods.${name}.migratePayload[${key}] must be a function`
        );
      }
      migrators.set(from, migrator);
    }
    parsed.set(name, { version, migrators });
  }
  return (operation) => parsed.get(operation) ?? emptyCompatibility;
};

type CallRow = z.infer<typeof callRowSchema>;

const tombstoneRowSchema = z.object({
  id: z.string(),
  operation: z.string(),
  outcome: z.enum(['completed', 'failed']),
  created_at: z.number().int().nonnegative(),
  completed_at: z.number().int().nonnegative().nullable(),
  pruned_at: z.number().int().nonnegative(),
});

type TombstoneRow = z.infer<typeof tombstoneRowSchema>;

const callsTable: DurableTable = { name: 'durability_calls', key: 'id' };

const countRowSchema = z.object({ count: z.number().int().nonnegative() });

const prunePolicySchema = z.object({
  completedBefore: z.number().int().nonnegative().optional(),
  failedBefore: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().default(100),
});

/**
 * Selects which terminal records {@link Durability.prune} rewrites into identity
 * tombstones. Records are matched by creation time (`created_at`), like
 * {@link Durability.purgeBefore}; omit a cutoff to keep that status untouched.
 */
export type DurabilityPruneOptions = {
  /** Prune completed records created strictly before this Unix timestamp (ms). */
  completedBefore?: number;
  /** Prune failed records created strictly before this Unix timestamp (ms). */
  failedBefore?: number;
  /** Maximum records rewritten in one call. Defaults to 100. */
  limit?: number;
};

/** Counts operations a reset would destroy; absent table means no pending work. */
const countPendingOperations = (sql: SqlStorage): number => {
  const exists = sql
    .exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      callsTable.name
    )
    .toArray();
  if (exists.length === 0) {
    return 0;
  }
  return countRowSchema.parse(
    sql
      .exec(
        `SELECT COUNT(*) AS count FROM ${callsTable.name} WHERE status = 'pending'`
      )
      .toArray()[0]
  ).count;
};

const readCall = (sql: SqlStorage, id: string): CallRow | undefined =>
  callRowSchema
    .optional()
    .parse(
      sql.exec('SELECT * FROM durability_calls WHERE id = ?', id).toArray()[0]
    );

const readTombstone = (sql: SqlStorage, id: string): TombstoneRow | undefined =>
  tombstoneRowSchema
    .optional()
    .parse(
      sql
        .exec('SELECT * FROM durability_call_tombstones WHERE id = ?', id)
        .toArray()[0]
    );

/**
 * The context passed to a durable operation handler for each attempt.
 *
 * @example
 * ```ts
 * const sendEmail = async ({ id, payload, signal }: DurableCall<EmailPayload>) =>
 *   fetch(payload.url, {
 *     method: 'POST',
 *     headers: { 'Idempotency-Key': id },
 *     signal,
 *   });
 * ```
 */
export type DurableCall<Payload> = {
  /**
   * The stable idempotency key supplied when the operation was registered. This
   * is the operation's logical identity: key any external deduplication or
   * once-only effect by `id`, never by `attempt`.
   */
  id: string;
  /** The handler name used to register the operation. */
  operation: string;
  /** The JSON-serializable payload supplied when the operation was registered. */
  payload: Payload;
  /**
   * The one-based attempt ordinal, durably recorded before the handler runs. It
   * is retry and logging context, not a record of what the handler did: never
   * gate once-only work on it (such as `attempt === 1`). Key such work on
   * durable state keyed by `id` instead. See the README identity glossary.
   */
  attempt: number;
  /** Aborts when the attempt exceeds its configured timeout. */
  signal: AbortSignal;
};

/** A function that executes one attempt of a durable operation. */
export type DurableHandler<Payload, Result> = (
  call: DurableCall<Payload>
) => Result | Promise<Result>;

export type HandlerMap = Record<string, (...args: never[]) => unknown>;

type HandlerPayload<Handler> = Handler extends (
  call: DurableCall<infer Payload>
) => unknown
  ? Payload
  : never;

type HandlerResult<Handler> = Handler extends (...args: never[]) => infer Result
  ? Awaited<Result>
  : never;

/** Result types of every operation, keyed by handler name. */
export type OperationResults<Handlers extends HandlerMap> = {
  [Operation in Extract<keyof Handlers, string>]: HandlerResult<
    Handlers[Operation]
  >;
};

type DurableOperationInput<Handler> = {
  /** Stable idempotency key; bound to the operation and its payload. */
  id: string;
  /** JSON-serializable input passed to the operation handler. */
  payload: HandlerPayload<Handler>;
};

/**
 * The persisted state and result of a durable operation.
 *
 * Operation methods only wait for durable registration, not handler completion.
 * Call `getResult` later and narrow on `status` before reading a result or error.
 */
export type DurableOperationResult<Result> =
  | {
      /** No operation exists for the supplied idempotency key. */
      status: 'not_found';
    }
  | {
      /** The operation is waiting to run or retry. */
      status: 'pending';
      /** The number of attempts already started. */
      attempt: number;
      /** Unix timestamp in milliseconds when the next attempt becomes eligible. */
      nextAttemptAt: number;
      /** The previous attempt's error message, or null before the first attempt. */
      lastError: string | null;
    }
  | {
      /** The operation exhausted its attempts or failed with a non-retryable error. */
      status: 'failed';
      /** The number of attempts that were started. */
      attempt: number;
      /** The terminal error's serialized name and message. */
      error: { name: string; message: string };
      /**
       * True when a handler side effect may have completed but its result could
       * not be recorded, so the external outcome is unverified. Set for result
       * serialization failures; manual replay should acknowledge the risk.
       */
      outcomeMayBeUnknown?: boolean;
    }
  | {
      /** The operation completed successfully. */
      status: 'completed';
      /** The handler's persisted return value. */
      result: Result;
    }
  | {
      /** The operation was durably cancelled before completing. */
      status: 'cancelled';
      /** The number of attempts that had started when cancellation won. */
      attempt: number;
      /** Unix timestamp in milliseconds when the cancellation was recorded. */
      cancelledAt: number;
      /** The bounded reason supplied to `cancel`, or null. */
      reason: string | null;
      /**
       * True when an attempt had already started, so a protected side effect
       * may have committed before cancellation. Cancellation never proves that
       * no external effect occurred.
       */
      outcomeMayBeUnknown: boolean;
    }
  | {
      /**
       * The payload, result, and error were pruned, but an identity tombstone
       * still deduplicates the ID and records how the operation ended.
       */
      status: 'pruned';
      /** Whether the pruned operation had completed or failed. */
      outcome: 'completed' | 'failed';
    };

/**
 * The result of a cancellation request, discriminated by `status`.
 *
 * Cancellation durably prevents future library starts and retries and makes a
 * best-effort attempt to abort a running handler. It cannot forcibly terminate
 * arbitrary JavaScript or undo an external effect that already committed.
 */
export type DurableCancellationOutcome =
  | {
      /** A pending operation was transitioned to the cancelled state. */
      status: 'cancelled';
      /** Unix timestamp in milliseconds when the cancellation was recorded. */
      cancelledAt: number;
      /** The bounded reason that was stored, or null. */
      reason: string | null;
    }
  | {
      /** The operation was already cancelled; the call is idempotent. */
      status: 'already_cancelled';
    }
  | {
      /** No operation exists for the supplied idempotency key. */
      status: 'not_found';
    }
  | {
      /** The operation already reached a non-cancellable terminal state. */
      status: 'not_pending';
      /** The terminal status that blocked cancellation. */
      operationStatus: 'completed' | 'failed';
    };

/** Options accepted by an operation's `cancel` method. */
export type DurableCancellationOptions = {
  /** A human-readable reason stored with the cancellation and bounded in length. */
  reason?: string;
};

/**
 * The result of the cancellation transaction. A successful transition carries
 * the generation and attempt the post-commit step needs to abort the running
 * handler and emit the lifecycle event.
 */
type CancelTransition =
  | {
      outcome: Exclude<DurableCancellationOutcome, { status: 'cancelled' }>;
      generation?: undefined;
    }
  | {
      outcome: Extract<DurableCancellationOutcome, { status: 'cancelled' }>;
      generation: string;
      attempt: number;
    };

/**
 * Why a terminal operation failed. `attempts_exhausted` is a plain transient
 * failure that used up its retry budget; every other class carries an uncertain
 * or permanent outcome and requires {@link DurableReplayOptions.force} to replay.
 */
export type TerminalClassification =
  | 'attempts_exhausted'
  | 'non_retryable'
  | 'timeout'
  | 'policy_error'
  | 'serialization_error'
  | 'payload_decode_error';

/** Options for {@link DurableOperation.retryFailed}. */
export type DurableReplayOptions = {
  /**
   * When the replayed attempt becomes eligible, as a Unix timestamp in
   * milliseconds. Defaults to now, which starts the attempt immediately.
   */
  at?: number;
  /**
   * Acknowledge replaying a failure whose outcome is permanent or uncertain
   * (anything other than `attempts_exhausted`). Replay never undoes or detects
   * an external side effect a prior attempt may have already committed; set
   * this only when re-running is known to be safe or idempotent.
   */
  force?: boolean;
};

/** The outcome of a {@link DurableOperation.retryFailed} call. */
export type DurableReplayResult =
  | {
      /**
       * The failed record was moved back to pending in a fresh retry cycle.
       */
      status: 'replayed';
      /** The new one-based retry cycle. */
      cycle: number;
      /** When the replayed attempt becomes eligible. */
      nextAttemptAt: number;
    }
  | {
      /** No operation exists for the supplied idempotency key. */
      status: 'not_found';
    }
  | {
      /** The record is not in a terminal failed state and cannot be replayed. */
      status: 'not_failed';
      /** The record's current non-failed status. */
      current: 'pending' | 'completed' | 'cancelled';
    }
  | {
      /**
       * The failure is permanent or uncertain and needs
       * {@link DurableReplayOptions.force} to replay.
       */
      status: 'requires_force';
      /** The terminal classification that requires acknowledgement. */
      classification: TerminalClassification;
    };

// Exhausting the retry budget records the handler's own retryable error, so a
// name not listed here is a transient failure that is safe to replay. Only
// these known terminal errors mark an uncertain or permanent outcome.
const terminalClassifications: Record<string, TerminalClassification> = {
  DurableAttemptTimeoutError: 'timeout',
  DurableRetryPolicyError: 'policy_error',
  DurableResultSerializationError: 'serialization_error',
  NonRetryableError: 'non_retryable',
  DurablePayloadDecodeError: 'payload_decode_error',
};

const classifyTerminal = (errorName: string | null): TerminalClassification =>
  terminalClassifications[errorName ?? ''] ?? 'attempts_exhausted';

type OperationEvent = Extract<
  DurabilityLifecycleEvent,
  { entityKind: 'operation' }
>;

type TypedOperationEvent<
  Operation extends string,
  Result,
> = OperationEvent extends infer Event
  ? Event extends { outcome: 'completed' }
    ? Omit<Event, 'operation' | 'result'> & {
        operation: Operation;
        result: Result;
      }
    : Event extends object
      ? Omit<Event, 'operation'> & { operation: Operation }
      : never
  : never;

/**
 * A lifecycle event for one of this instance's operations. Completed events
 * carry the handler's typed result.
 */
export type DurabilityOperationEvent<Handlers extends HandlerMap> =
  | {
      [Operation in Extract<keyof Handlers, string>]: TypedOperationEvent<
        Operation,
        HandlerResult<Handlers[Operation]>
      >;
    }[Extract<keyof Handlers, string>]
  | Extract<DurabilityLifecycleEvent, { type: 'purged' }>;

/** Registers calls for one handler and reads their persisted results. */
export type DurableOperation<Handler> = ((
  input: DurableOperationInput<Handler>
) => Promise<void>) & {
  /** Reads the persisted state for an idempotency key. */
  getResult: (
    idempotencyKey: string
  ) => Promise<DurableOperationResult<HandlerResult<Handler>>>;
  /**
   * Durably cancels a pending call so it never starts or retries, and makes a
   * best-effort attempt to abort a running handler. Idempotent and safe when
   * no live instance owns the call.
   */
  cancel: (
    idempotencyKey: string,
    options?: DurableCancellationOptions
  ) => Promise<DurableCancellationOutcome>;
  /**
   * Replays a terminally failed operation under its original ID, operation, and
   * payload. It opens a fresh retry cycle with a new attempt budget while
   * preserving the lifetime attempt count and the previous terminal error.
   *
   * An `attempts_exhausted` failure replays without options; any other terminal
   * class needs {@link DurableReplayOptions.force}. The call resolves once the
   * durable transition commits, like registration.
   */
  retryFailed: (
    idempotencyKey: string,
    options?: DurableReplayOptions
  ) => Promise<DurableReplayResult>;
};

/**
 * Configuration for durable operations.
 *
 * @example
 * ```ts
 * const options: DurabilityOptions<typeof handlers> = {
 *   attemptTimeoutMs: 30_000,
 *   retries: { maxAttempts: 5 },
 *   methods: {
 *     resizeImage: { attemptTimeoutMs: 60_000, retries: { maxAttempts: 2 } },
 *   },
 * };
 * ```
 */
export type DurabilityOptions<Handlers extends HandlerMap = HandlerMap> =
  ExecutionPolicyOptions & {
    /** Execution policy overrides keyed by handler name. */
    methods?: Partial<
      Record<Extract<keyof NoInfer<Handlers>, string>, DurabilityMethodOptions>
    >;
    /** Receives best-effort, non-durable lifecycle metrics events. */
    onLifecycleEvent?: LifecycleHook;
  };

/**
 * Constructor configuration: the operation handlers, their policies, and
 * either a shared `scheduler` or the Durable Object `context` (plus scheduler
 * options) to create a private one.
 */
export type DurabilityConfig<Handlers extends HandlerMap = HandlerMap> =
  DurabilityOptions<Handlers> &
    SchedulerAttachment & {
      /** Operation handlers keyed by the method names they become. */
      handlers: Handlers;
    };

const assertOperation = (
  id: string,
  existingOperation: string,
  requestedOperation: string
): void => {
  if (existingOperation !== requestedOperation) {
    throw new DuplicateDurableCallError(
      id,
      existingOperation,
      requestedOperation
    );
  }
};

/**
 * The operation that owns `id`, resolved from either its live row or its pruned
 * tombstone. A pruned record keeps its operation binding, so ownership is one
 * rule across both states.
 */
type OwnedCall =
  | { kind: 'live'; call: CallRow }
  | { kind: 'pruned'; outcome: TombstoneRow['outcome'] }
  | { kind: 'absent' };

// Asserts the operation binding for `id` against a live row or, once pruned, its
// tombstone, so a wrong-operation reuse always throws instead of being accepted.
const resolveOwnedCall = (
  sql: SqlStorage,
  id: string,
  operation: string
): OwnedCall => {
  const call = readCall(sql, id);
  if (call) {
    assertOperation(id, call.operation, operation);
    return { kind: 'live', call };
  }
  const tombstone = readTombstone(sql, id);
  if (tombstone) {
    assertOperation(id, tombstone.operation, operation);
    return { kind: 'pruned', outcome: tombstone.outcome };
  }
  return { kind: 'absent' };
};

const callState = (
  call: CallRow
): Exclude<
  DurableOperationResult<unknown>,
  { status: 'not_found' | 'pruned' }
> => {
  if (call.status === 'pending') {
    return {
      status: 'pending',
      attempt: call.attempt,
      nextAttemptAt: call.next_attempt_at,
      lastError: call.last_error,
    };
  }
  if (call.status === 'failed') {
    return {
      status: 'failed',
      attempt: call.attempt,
      error: {
        name: call.last_error_name ?? 'Error',
        message: call.last_error ?? 'Durable operation failed',
      },
      // A serialization failure happens after the handler ran, so its external
      // side effect may have committed even though the result was not recorded.
      ...(call.last_error_name === DurableResultSerializationError.name
        ? { outcomeMayBeUnknown: true }
        : {}),
    };
  }
  if (call.status === 'cancelled') {
    return {
      status: 'cancelled',
      attempt: call.attempt,
      cancelledAt: call.cancelled_at ?? 0,
      reason: call.cancel_reason,
      // Lifetime, not cycle-local: a replay resets `attempt` to zero and carries
      // prior attempts in `total_attempts`, so an effect committed before replay
      // must still mark the cancelled outcome uncertain.
      outcomeMayBeUnknown: call.total_attempts + call.attempt > 0,
    };
  }
  if (call.result === null) {
    throw new Error(`Completed durable call "${call.id}" has no result`);
  }
  return { status: 'completed', result: deserialize(call.result) };
};

// The tracker represents finer outcomes as `failed` with a specific error name,
// so a cancelled call surfaces there as a DurableCancellationError failure.
const trackedCallState = (call: CallRow): TrackedState<unknown> => {
  const state = callState(call);
  if (state.status === 'cancelled') {
    return {
      status: 'failed',
      attempt: state.attempt,
      error: {
        name: 'DurableCancellationError',
        message: call.cancel_reason ?? 'Durable operation was cancelled',
      },
    };
  }
  return state;
};

const callRecord = (call: CallRow): UntypedRecord => ({
  id: call.id,
  name: call.operation,
  generation: call.generation_id,
  createdAt: call.created_at,
  state: trackedCallState(call),
});

// Summaries never read `payload` or `result`, so a list stays bounded and
// cannot leak secrets even when a completed result is large.
const callSummaryState = (call: CallRow): UntypedSummary['state'] => {
  if (call.status === 'completed') {
    return { status: 'completed' };
  }
  if (call.status === 'failed') {
    return {
      status: 'failed',
      attempt: call.attempt,
      error: { name: call.last_error_name ?? 'Error' },
    };
  }
  return {
    status: 'pending',
    attempt: call.attempt,
    nextAttemptAt: call.next_attempt_at,
  };
};

const callSummary = (call: CallRow): UntypedSummary => ({
  id: call.id,
  name: call.operation,
  generation: call.generation_id,
  createdAt: call.created_at,
  state: callSummaryState(call),
});

const operationEntity = (call: CallRow): OperationLifecycleEntity => ({
  entityKind: 'operation',
  operation: call.operation,
  id: call.id,
  generation: call.generation_id,
});

class DurabilityCore<Handlers extends HandlerMap> {
  readonly #engine: Engine;
  readonly #handlers: Handlers;
  readonly #policy: PolicyResolver<MethodPolicy>;
  readonly #compat: (operation: string) => OperationCompatibility;
  readonly #lifecycle: LifecycleHooks;
  readonly #emit: LifecycleHooks['emit'];
  readonly #active = new Map<string, ActiveExecution>();
  readonly #executionStarts = new Map<string, Promise<void>>();

  constructor(config: DurabilityConfig<Handlers>) {
    const { handlers } = config;
    this.#engine = engineFor(config);
    this.#handlers = handlers;
    this.#policy = createPolicyResolver(
      config,
      config.methods ?? {},
      methodOptionsSchema
    );
    this.#compat = resolveCompatibility(config.methods ?? {});
    this.#lifecycle = createLifecycleHooks(
      (hook) => this.#engine.emitter(hook),
      config.onLifecycleEvent
    );
    this.#emit = this.#lifecycle.emit;

    const reserved = new Set(
      Object.getOwnPropertyNames(DurabilityCore.prototype)
    );
    for (const operation of Object.keys(handlers)) {
      if (reserved.has(operation)) {
        throw new Error(`"${operation}" is reserved by Durability`);
      }
      const method = Object.assign(
        traceFunction(
          `Durability.${operation}`,
          (input: { id: string; payload: unknown }) =>
            this.#run({ ...input, operation })
        ),
        {
          getResult: traceFunction(
            `Durability.${operation}.getResult`,
            (idempotencyKey: string) =>
              this.#getResult(operation, idempotencyKey)
          ),
          cancel: traceFunction(
            `Durability.${operation}.cancel`,
            (idempotencyKey: string, options?: DurableCancellationOptions) =>
              this.#cancel(operation, idempotencyKey, options)
          ),
          retryFailed: traceFunction(
            `Durability.${operation}.retryFailed`,
            (idempotencyKey: string, options?: DurableReplayOptions) =>
              this.#retryFailed(operation, idempotencyKey, options)
          ),
        }
      );
      Object.defineProperty(this, operation, {
        value: method,
        enumerable: true,
      });
    }

    this.#engine.migrateSchema('operations', durabilityOperationMigrations);
    this.#engine.register({
      table: callsTable,
      runDue: (now) => this.#runDue(now),
    });
    registerTrackedSource(this, this.#trackedSource());
  }

  /**
   * Applies or reverts the `durability_calls` schema; see {@link migrate}.
   *
   * Forward migration is unchanged. A rollback is destructive: it requires
   * `{ allowDataLoss: true }`, refuses to run while operations are pending
   * unless `{ force: true }`, and a full reset deletes the library-owned
   * physical alarm so it cannot later fire against the dropped tables.
   */
  static async migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null,
    options?: MigrateOptions
  ): Promise<DurabilityMigrationResult> {
    const result = migrate(
      context.storage,
      'operations',
      durabilityOperationMigrations,
      target,
      { ...options, pendingWork: countPendingOperations }
    );
    if (result.reset) {
      await context.storage.deleteAlarm();
    }
    return result;
  }

  /** Processes due operations and re-arms the physical alarm. */
  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#engine.alarm(info);
  }

  /**
   * Attaches a best-effort lifecycle hook alongside `onLifecycleEvent` and
   * returns a function that detaches it.
   */
  lifecycle(
    hook: (event: DurabilityOperationEvent<Handlers>) => void | Promise<void>
  ): () => void {
    return this.#lifecycle.add(hook as LifecycleHook);
  }

  /**
   * Destructively removes operation records created strictly before the
   * timestamp, regardless of status, and returns how many were removed.
   */
  async purgeBefore(before: number): Promise<number> {
    const operations = await this.#engine.purge(
      callsTable,
      before,
      this.#active,
      'Durable operation was purged'
    );
    // Tombstones live in a separate table the engine purge never sees; deleting
    // them here keeps purgeBefore the one path that fully frees an ID for reuse.
    const tombstones = await this.#engine.transaction((sql) => {
      const { count } = countRowSchema.parse(
        sql
          .exec(
            `SELECT COUNT(*) AS count FROM durability_call_tombstones
             WHERE created_at < ?`,
            before
          )
          .toArray()[0]
      );
      sql.exec(
        'DELETE FROM durability_call_tombstones WHERE created_at < ?',
        before
      );
      return count;
    });

    const count = operations + tombstones;
    this.#emit({
      type: 'purged',
      entityKind: 'operation',
      timestamp: Date.now(),
      before,
      count,
    });
    return count;
  }

  /**
   * Rewrites terminal operation records into identity tombstones, dropping the
   * payload, result, and error while keeping deduplication intact: a reused ID
   * never reruns and `getResult` reports it as `pruned`. Reusing the ID under a
   * different operation still throws {@link DuplicateDurableCallError}.
   *
   * Prunes at most `limit` records (default 100) per call, oldest first, so
   * large backlogs are cleared by looping until the returned count is below the
   * limit. Pending records are never pruned.
   */
  async prune(options: DurabilityPruneOptions): Promise<number> {
    const { completedBefore, failedBefore, limit } =
      prunePolicySchema.parse(options);
    if (completedBefore === undefined && failedBefore === undefined) {
      return 0;
    }

    const prunedAt = Date.now();
    const ids = await this.#engine.transaction((sql) => {
      // Move and delete with a fixed number of bound parameters, never one per
      // row: SQLite in a Durable Object caps a statement at 100 parameters, so
      // an id list would fail at the default limit. The copy stamps this batch
      // with prunedAt; the delete then removes exactly the rows it just wrote.
      const moved = z
        .object({ id: z.string() })
        .array()
        .parse(
          sql
            .exec(
              `INSERT INTO durability_call_tombstones
                 (id, operation, outcome, created_at, completed_at, pruned_at)
               SELECT id, operation, status, created_at, completed_at, ?
               FROM durability_calls
               WHERE (status = 'completed' AND ? IS NOT NULL AND created_at < ?)
                  OR (status = 'failed' AND ? IS NOT NULL AND created_at < ?)
               ORDER BY created_at ASC, id ASC
               LIMIT ?
               RETURNING id`,
              prunedAt,
              completedBefore ?? null,
              completedBefore ?? null,
              failedBefore ?? null,
              failedBefore ?? null,
              limit
            )
            .toArray()
        )
        .map(({ id }) => id);
      if (moved.length === 0) {
        return [];
      }

      // A tombstone never coexists with a live call row for the same id, so the
      // only call rows matching this batch's tombstones are the ones just moved.
      sql.exec(
        `DELETE FROM durability_calls
         WHERE id IN (
           SELECT id FROM durability_call_tombstones WHERE pruned_at = ?
         )`,
        prunedAt
      );
      return moved;
    });

    for (const id of ids) {
      this.#engine.notify(callsTable, id);
    }
    return ids.length;
  }

  #trackedSource(): UntypedSource {
    const sql = this.#engine.sql;
    return {
      get: async (id) => {
        const call = readCall(sql, id);
        return call && callRecord(call);
      },
      list: async ({ limit, cursor, status, name }) => {
        const page = listCreated(sql, callsTable, 'operation', {
          limit,
          after: cursor,
          status,
          name,
        });
        const records = callRowSchema.array().parse(page.rows).map(callSummary);
        return page.next === undefined
          ? { records }
          : { records, cursor: page.next };
      },
      watch: (id, listener) =>
        this.#engine.watch(callsTable, id, () => listener()),
    };
  }

  async #runDue(now: number): Promise<void> {
    const due = z
      .object({ id: z.string() })
      .array()
      .parse(
        this.#engine.sql
          .exec(
            `SELECT id FROM durability_calls
             WHERE status = 'pending' AND next_attempt_at <= ?
             ORDER BY next_attempt_at ASC
             LIMIT 100`,
            now
          )
          .toArray()
      );
    await this.#engine.runConcurrent(due, async ({ id }) => {
      try {
        await this.#execute(id);
      } catch {
        return;
      }
    });
  }

  async #getResult(
    operation: string,
    idempotencyKey: string
  ): Promise<DurableOperationResult<unknown>> {
    const owned = resolveOwnedCall(this.#engine.sql, idempotencyKey, operation);
    if (owned.kind === 'live') {
      return callState(owned.call);
    }
    if (owned.kind === 'pruned') {
      return { status: 'pruned', outcome: owned.outcome };
    }
    return { status: 'not_found' };
  }

  async #cancel(
    operation: string,
    idempotencyKey: string,
    options?: DurableCancellationOptions
  ): Promise<DurableCancellationOutcome> {
    const reason = boundedReason(options?.reason);

    // Read and transition in one transaction so a completion or failure that
    // commits concurrently is the enforced winner: the pending guard on the
    // UPDATE, and on every attempt write, makes the two mutually exclusive.
    const transition = await this.#engine.transaction(
      (sql): CancelTransition => {
        const owned = resolveOwnedCall(sql, idempotencyKey, operation);
        if (owned.kind !== 'live') {
          return { outcome: { status: 'not_found' } };
        }
        const call = owned.call;
        if (call.status === 'cancelled') {
          return { outcome: { status: 'already_cancelled' } };
        }
        if (call.status !== 'pending') {
          return {
            outcome: { status: 'not_pending', operationStatus: call.status },
          };
        }

        const cancelledAt = Date.now();
        sql.exec(
          `UPDATE durability_calls
           SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
           WHERE id = ? AND status = 'pending'`,
          cancelledAt,
          reason,
          idempotencyKey
        );
        return {
          outcome: { status: 'cancelled', cancelledAt, reason },
          generation: call.generation_id,
          attempt: call.attempt,
        };
      }
    );

    if (transition.generation === undefined) {
      return transition.outcome;
    }

    const { outcome, generation, attempt } = transition;
    this.#engine.notify(callsTable, idempotencyKey);
    const running = this.#active.get(idempotencyKey);
    if (running?.generation === generation) {
      running.controller?.abort(
        new DurableCancellationError(operation, reason)
      );
    }
    this.#emit({
      entityKind: 'operation',
      operation,
      id: idempotencyKey,
      generation,
      type: 'cancelled',
      timestamp: outcome.cancelledAt,
      attempt,
      reason,
    });
    return outcome;
  }

  async #run(input: {
    id: string;
    operation: string;
    payload: unknown;
  }): Promise<void> {
    const payload = serialize(input.payload);
    const version = this.#compat(input.operation).version;
    const now = Date.now();
    const generation = crypto.randomUUID();
    const { inserted, winner } = await this.#engine.transaction((sql) => {
      // A pruned ID keeps only an identity tombstone: dedup the same operation
      // and reject a different one, without recreating a live row.
      const tombstone = readTombstone(sql, input.id);
      if (tombstone) {
        assertOperation(input.id, tombstone.operation, input.operation);
        return { inserted: false, winner: undefined };
      }
      const created =
        sql
          .exec(
            `INSERT INTO durability_calls
               (id, operation, payload, status, attempt, next_attempt_at,
                created_at, generation_id, payload_version)
             VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING
             RETURNING id`,
            input.id,
            input.operation,
            payload,
            now,
            now,
            generation,
            version
          )
          .toArray().length > 0;
      const current = readCall(sql, input.id);
      if (!current) {
        throw new Error(`Durable call "${input.id}" was not persisted`);
      }
      assertOperation(input.id, current.operation, input.operation);
      // Reuse is idempotent only for the same data; anything else is a caller
      // bug that would otherwise be dropped silently.
      if (!created && canonical(current.payload) !== canonical(payload)) {
        throw new DuplicateDurablePayloadError(input.id, input.operation);
      }
      return { inserted: created, winner: current };
    });
    if (!inserted || !winner) {
      return;
    }

    this.#emit({
      ...operationEntity(winner),
      type: 'registered',
      timestamp: now,
      attempt: 0,
    });
    this.#startEagerly(input.id, input.operation);
  }

  /**
   * Replays a terminally failed call under the same ID in a fresh retry cycle.
   * The status check and generation compare-and-swap run inside the alarm
   * reconciliation transaction, so concurrent callers open exactly one cycle.
   */
  async #retryFailed(
    operation: string,
    id: string,
    options: DurableReplayOptions = {}
  ): Promise<DurableReplayResult> {
    const now = Date.now();
    const at = options.at ?? now;
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new RangeError('at must be a non-negative safe integer');
    }

    const outcome = await this.#engine.transaction(
      (sql): DurableReplayResult => {
        const owned = resolveOwnedCall(sql, id, operation);
        if (owned.kind !== 'live') {
          return { status: 'not_found' };
        }
        const call = owned.call;
        if (call.status !== 'failed') {
          return { status: 'not_failed', current: call.status };
        }

        const classification = classifyTerminal(call.last_error_name);
        if (classification !== 'attempts_exhausted' && !options.force) {
          return { status: 'requires_force', classification };
        }

        const cycle = call.retry_cycle + 1;
        // Keep the previous terminal error until the new cycle settles; only the
        // counters, status, generation, and schedule move.
        sql.exec(
          `UPDATE durability_calls
         SET status = 'pending',
             generation_id = ?,
             retry_cycle = ?,
             total_attempts = total_attempts + attempt,
             attempt = 0,
             next_attempt_at = ?
         WHERE id = ? AND status = 'failed' AND generation_id = ?`,
          crypto.randomUUID(),
          cycle,
          at,
          id,
          call.generation_id
        );
        return { status: 'replayed', cycle, nextAttemptAt: at };
      }
    );

    if (outcome.status === 'replayed') {
      this.#engine.notify(callsTable, id);
      if (outcome.nextAttemptAt <= Date.now()) {
        this.#startEagerly(id, operation);
      }
    }
    return outcome;
  }

  /** Starts a due call eagerly when a permit is free; the alarm covers the rest. */
  #startEagerly(id: string, operation: string): void {
    const eagerPermit = this.#engine.tryAcquirePermit();
    if (!eagerPermit) {
      return;
    }
    const onError = (error: unknown) =>
      reportFailure(
        'durability.background_execution.failed',
        { operation, id },
        error
      );
    const background = this.#execute(id, eagerPermit)
      .then(() => this.#engine.scheduleNextAlarm())
      .catch(onError);
    this.#engine.waitUntil(background, onError);
  }

  /**
   * Looks up a call and starts it unless the same generation is already
   * running. Lookups for one ID are serialized so two concurrent callers
   * cannot both miss the active map while awaiting storage.
   */
  async #execute(id: string, eagerPermit?: () => void): Promise<void> {
    const previousStart = this.#executionStarts.get(id) ?? Promise.resolve();
    let releaseStart!: () => void;
    const currentStart = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    this.#executionStarts.set(id, currentStart);
    let permitTransferred = false;

    try {
      await previousStart;
      const call = readCall(this.#engine.sql, id);
      if (!call || call.status !== 'pending') {
        return;
      }
      const running = this.#active.get(id);
      if (running?.generation === call.generation_id) {
        releaseStart();
        await running.settled;
        return;
      }

      const ready = await this.#prepareForExecution(call);
      if (!ready) {
        return;
      }

      const execution = this.#start(ready, eagerPermit);
      permitTransferred = true;
      releaseStart();
      return execution;
    } finally {
      releaseStart();
      if (this.#executionStarts.get(id) === currentStart) {
        this.#executionStarts.delete(id);
      }
      if (!permitTransferred) {
        eagerPermit?.();
      }
    }
  }

  /**
   * Resolves a pending call against the running deployment before any attempt is
   * claimed. Returns the row to execute, applying any payload migration first,
   * or `undefined` after blocking work that this deployment cannot run safely.
   *
   * Blocking never consumes retry budget or marks the call failed: the row stays
   * pending with a slow backoff so a later compatible deployment recovers it.
   */
  async #prepareForExecution(call: CallRow): Promise<CallRow | undefined> {
    const { version: supported, migrators } = this.#compat(call.operation);

    if (!this.#handlers[call.operation]) {
      await this.#blockForCompatibility(
        call,
        `no handler is registered for operation "${call.operation}"`
      );
      return undefined;
    }
    if (call.payload_version > supported) {
      await this.#blockForCompatibility(
        call,
        `stored payload version ${call.payload_version} is newer than the supported version ${supported}`
      );
      return undefined;
    }
    if (call.payload_version === supported) {
      return call;
    }

    let value: unknown;
    try {
      value = deserialize(call.payload);
    } catch {
      // A corrupt payload cannot be fixed by a later deploy, unlike a missing
      // handler or an unsupported version. Return the row unchanged so the
      // pre-attempt decode fails it terminally with DurablePayloadDecodeError.
      return call;
    }
    for (let from = call.payload_version; from < supported; from += 1) {
      const migrator = migrators.get(from);
      if (!migrator) {
        await this.#blockForCompatibility(
          call,
          `no payload migration from version ${from} to ${from + 1}`
        );
        return undefined;
      }
      try {
        value = migrator(value);
      } catch (error) {
        await this.#blockForCompatibility(
          call,
          `payload migration from version ${from} failed: ${serializeError(error).message}`
        );
        return undefined;
      }
    }

    let migrated: string;
    try {
      migrated = serialize(value);
    } catch (error) {
      await this.#blockForCompatibility(
        call,
        `migrated payload is not JSON-serializable: ${serializeError(error).message}`
      );
      return undefined;
    }

    // Commit the upgraded payload and version atomically before the handler is
    // entered, guarded by the generation so a reset cannot run the migrator twice.
    const committed = await this.#engine.transaction(
      (sql) =>
        sql
          .exec(
            `UPDATE durability_calls
             SET payload = ?, payload_version = ?
             WHERE id = ? AND generation_id = ? AND status = 'pending'
             RETURNING id`,
            migrated,
            supported,
            call.id,
            call.generation_id
          )
          .toArray().length > 0
    );
    if (!committed) {
      return undefined;
    }
    return { ...call, payload: migrated, payload_version: supported };
  }

  async #blockForCompatibility(call: CallRow, reason: string): Promise<void> {
    const error = serializeError(
      new DurablePayloadCompatibilityError(call.operation, reason)
    );
    const now = Date.now();
    // Derive the wait from row age so it roughly doubles as each wait elapses, capped.
    const backoff = Math.min(
      maxCompatibilityBackoffMs,
      Math.max(minCompatibilityBackoffMs, now - call.created_at)
    );
    const nextAttemptAt = now + backoff;
    await this.#engine.transaction((sql) => {
      sql.exec(
        `UPDATE durability_calls
         SET next_attempt_at = ?, last_error = ?, last_error_name = ?
         WHERE id = ? AND generation_id = ? AND status = 'pending'`,
        nextAttemptAt,
        error.message,
        error.name,
        call.id,
        call.generation_id
      );
    });
  }

  #start(call: CallRow, eagerPermit: (() => void) | undefined): Promise<void> {
    const policy = this.#policy(call.operation);
    const retryTimeouts = policy.method?.retryTimeouts ?? false;
    const handler = this.#handlers[call.operation] as
      | ((durableCall: DurableCall<unknown>) => unknown)
      | undefined;
    let payload: unknown;
    return this.#engine.startExecution(
      {
        table: callsTable,
        key: call.id,
        row: call,
        label: `operation "${call.operation}"`,
        entity: operationEntity(call),
        active: this.#active,
        policy,
        emit: this.#emit,
        exhaustedError: () =>
          new DurableAttemptsExhaustedError(
            'operation',
            call.operation,
            policy.maxAttempts
          ),
        timeoutError: () =>
          new DurableAttemptTimeoutError(
            call.operation,
            policy.attemptTimeoutMs
          ),
        prepare: () => {
          try {
            payload = deserialize(call.payload);
          } catch (error) {
            throw new DurablePayloadDecodeError(call.operation, error);
          }
        },
        invoke: (attempt, signal) => {
          if (!handler) {
            throw new NonRetryableError(
              `No handler registered for operation "${call.operation}"`
            );
          }
          return handler({
            id: call.id,
            operation: call.operation,
            payload,
            attempt,
            signal,
          });
        },
        complete: (result, attempt) => {
          let serialized: string;
          try {
            serialized = serialize(result);
          } catch (error) {
            throw new DurableResultSerializationError(call.operation, error);
          }
          const timestamp = Date.now();
          const updated = updateAttempt(
            this.#engine.sql,
            callsTable,
            { key: call.id, generation: call.generation_id, attempt },
            `status = 'completed', result = ?, last_error = NULL,
             last_error_name = NULL, completed_at = ?`,
            serialized,
            timestamp
          );
          return updated ? timestamp : undefined;
        },
        isTerminal: (error) =>
          isErrorInstance(error, DurableResultSerializationError) ||
          (isErrorInstance(error, DurableAttemptTimeoutError) &&
            !retryTimeouts),
      },
      eagerPermit
    );
  }
}

type OperationMethods<Handlers extends HandlerMap> = {
  [Operation in keyof Handlers]: DurableOperation<Handlers[Operation]>;
};

/**
 * Alarm-backed, effectively-once durable operations for one Durable Object.
 *
 * Every handler becomes a typed method on the instance. Methods resolve once
 * the call is durably registered; read outcomes through `getResult`.
 *
 * @example
 * ```ts
 * class ImageJobs extends DurableObject<Env> {
 *   private readonly durability = new Durability({
 *     context: this.ctx,
 *     handlers: {
 *       resizeImage: async ({ id, payload }: DurableCall<{ imageId: string }>) =>
 *         this.env.IMAGES.resize(payload.imageId, { idempotencyKey: id }),
 *     },
 *   });
 *
 *   resize(imageId: string) {
 *     return this.durability.resizeImage({ id: `resize:${imageId}`, payload: { imageId } });
 *   }
 *
 *   alarm(info?: AlarmInvocationInfo) {
 *     return this.durability.alarm(info);
 *   }
 * }
 * ```
 */
export type Durability<Handlers extends HandlerMap> = DurabilityCore<Handlers> &
  OperationMethods<Handlers>;

/** Any `Durability` instance, without the index signature of `Durability<HandlerMap>`. */
export type AnyDurability = DurabilityCore<HandlerMap>;

export interface DurabilityConstructor {
  new <Handlers extends HandlerMap>(
    config: DurabilityConfig<Handlers>
  ): Durability<Handlers>;
  migrate: typeof DurabilityCore.migrate;
}

traceMethods(DurabilityCore.prototype, 'Durability');

// TypeScript cannot declare class members derived from a generic handler map,
// so the constructor is typed separately; the constructor installs and reserves
// every operation method at runtime.
export const Durability = DurabilityCore as unknown as DurabilityConstructor;
