import { z } from 'zod';
import { traceFunction, traceMethods } from './dev.js';
import {
  DuplicateDurableCallError,
  DuplicateDurablePayloadError,
  DurableAttemptsExhaustedError,
  DurableAttemptTimeoutError,
  DurableResultSerializationError,
  isErrorInstance,
  NonRetryableError,
  reportFailure,
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
} from './migrations.js';
import {
  createPolicyResolver,
  methodOptionsSchema,
  type DurabilityMethodOptions,
  type ExecutionPolicyOptions,
  type MethodPolicy,
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
  type UntypedRecord,
  type UntypedSource,
} from './tracked-source.js';

const callRowSchema = z.object({
  id: z.string(),
  operation: z.string(),
  payload: z.string(),
  status: z.enum(['pending', 'completed', 'failed']),
  result: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  next_attempt_at: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  last_error_name: z.string().nullable(),
  completed_at: z.number().int().nonnegative().nullable(),
  created_at: z.number().int().nonnegative(),
  generation_id: z.string(),
});

type CallRow = z.infer<typeof callRowSchema>;

const callsTable: DurableTable = { name: 'durability_calls', key: 'id' };

const readCall = (sql: SqlStorage, id: string): CallRow | undefined =>
  callRowSchema
    .optional()
    .parse(
      sql.exec('SELECT * FROM durability_calls WHERE id = ?', id).toArray()[0]
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
    }
  | {
      /** The operation completed successfully. */
      status: 'completed';
      /** The handler's persisted return value. */
      result: Result;
    };

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

const callState = (
  call: CallRow
): Exclude<DurableOperationResult<unknown>, { status: 'not_found' }> => {
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
    };
  }
  if (call.result === null) {
    throw new Error(`Completed durable call "${call.id}" has no result`);
  }
  return { status: 'completed', result: deserialize(call.result) };
};

const callRecord = (call: CallRow): UntypedRecord => ({
  id: call.id,
  name: call.operation,
  generation: call.generation_id,
  createdAt: call.created_at,
  state: callState(call),
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

  /** Applies or reverts the `durability_calls` schema; see {@link migrate}. */
  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ): DurabilityMigrationResult {
    return migrate(
      context.storage,
      'operations',
      durabilityOperationMigrations,
      target
    );
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
    const count = await this.#engine.purge(
      callsTable,
      before,
      this.#active,
      'Durable operation was purged'
    );
    this.#emit({
      type: 'purged',
      entityKind: 'operation',
      timestamp: Date.now(),
      before,
      count,
    });
    return count;
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
        const records = callRowSchema.array().parse(page.rows).map(callRecord);
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
    const call = readCall(this.#engine.sql, idempotencyKey);
    if (!call) {
      return { status: 'not_found' };
    }
    assertOperation(idempotencyKey, call.operation, operation);
    return callState(call);
  }

  async #run(input: {
    id: string;
    operation: string;
    payload: unknown;
  }): Promise<void> {
    const payload = serialize(input.payload);
    const now = Date.now();
    const generation = crypto.randomUUID();
    const { inserted, winner } = await this.#engine.transaction((sql) => {
      const created =
        sql
          .exec(
            `INSERT INTO durability_calls
               (id, operation, payload, status, attempt, next_attempt_at,
                created_at, generation_id)
             VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING
             RETURNING id`,
            input.id,
            input.operation,
            payload,
            now,
            now,
            generation
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
    if (!inserted) {
      return;
    }

    this.#emit({
      ...operationEntity(winner),
      type: 'registered',
      timestamp: now,
      attempt: 0,
    });
    // Start eagerly only when a permit is free; otherwise the reconciled alarm picks the row up.
    const eagerPermit = this.#engine.tryAcquirePermit();
    if (!eagerPermit) {
      return;
    }
    const onError = (error: unknown) =>
      reportFailure(
        'durability.background_execution.failed',
        { operation: input.operation, id: input.id },
        error
      );
    const background = this.#execute(input.id, eagerPermit)
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

      const execution = this.#start(call, eagerPermit);
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

  #start(call: CallRow, eagerPermit: (() => void) | undefined): Promise<void> {
    const policy = this.#policy(call.operation);
    const retryTimeouts = policy.method?.retryTimeouts ?? false;
    const handler = this.#handlers[call.operation] as
      | ((durableCall: DurableCall<unknown>) => unknown)
      | undefined;
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
        invoke: (attempt, signal) => {
          if (!handler) {
            throw new NonRetryableError(
              `No handler registered for operation "${call.operation}"`
            );
          }
          return handler({
            id: call.id,
            operation: call.operation,
            payload: deserialize(call.payload),
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
