import {
  DuplicateDurableCallError,
  DurableAttemptsExhaustedError,
  DurableAttemptTimeoutError,
  DurableResultSerializationError,
  isErrorInstance,
  NonRetryableError,
  reportFailure,
} from './errors.js';
import {
  type Emit,
  type LifecycleHook,
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
import { deserialize, serialize } from './serialization.js';
import type { CallRow } from './storage.js';

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
  /** The stable idempotency key supplied when the operation was registered. */
  id: string;
  /** The handler name used to register the operation. */
  operation: string;
  /** The JSON-serializable payload supplied when the operation was registered. */
  payload: Payload;
  /** The one-based attempt number. */
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

type DurableOperationInput<Handler> = {
  /** Stable idempotency key used to deduplicate the operation. */
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

/** Options for waiting on a durable operation through a live RPC session. */
export type DurableJobWaitOptions = {
  /** Maximum time to wait before returning the latest persisted state. */
  timeoutMs: number;
};

/** An RPC-capable handle for reading or waiting on one durable operation. */
export type DurableJobHandle<Result> = {
  /** Reads the latest persisted state. */
  getResult: () => Promise<DurableOperationResult<Result>>;
  /** Waits for terminal state or returns the latest state after the timeout. */
  wait: (
    options: DurableJobWaitOptions
  ) => Promise<DurableOperationResult<Result>>;
};

/** Registers calls, reads their state, and creates RPC-capable job handles. */
export type DurableOperation<Handler> = ((
  input: DurableOperationInput<Handler>
) => Promise<void>) & {
  /** Reads the persisted state for an idempotency key. */
  getResult: (
    idempotencyKey: string
  ) => Promise<DurableOperationResult<HandlerResult<Handler>>>;
  /** Creates a handle that can be returned over Workers RPC. */
  job: (idempotencyKey: string) => DurableJobHandle<HandlerResult<Handler>>;
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

const operationEntity = (call: CallRow): OperationLifecycleEntity => ({
  entityKind: 'operation',
  operation: call.operation,
  id: call.id,
  generation: call.generation_id,
});

type OperationWaitSignal = {
  generation: string;
  createdAt: number;
  promise: Promise<void>;
  resolve: () => void;
  waiters: number;
};

class DurabilityCore<Handlers extends HandlerMap> {
  readonly #engine: Engine;
  readonly #handlers: Handlers;
  readonly #policy: PolicyResolver<MethodPolicy>;
  readonly #emit: Emit;
  readonly #active = new Map<string, ActiveExecution>();
  readonly #operationWaitSignals = new Map<string, OperationWaitSignal>();
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
    this.#emit = this.#engine.emitter(config.onLifecycleEvent);

    const reserved = new Set(
      Object.getOwnPropertyNames(DurabilityCore.prototype)
    );
    for (const operation of Object.keys(handlers)) {
      if (reserved.has(operation)) {
        throw new Error(`"${operation}" is reserved by Durability`);
      }
      const method = (input: { id: string; payload: unknown }) =>
        this.#run({ ...input, operation });
      method.getResult = (idempotencyKey: string) =>
        this.#getResult(operation, idempotencyKey);
      method.job = (idempotencyKey: string) => ({
        getResult: () => this.#getResult(operation, idempotencyKey),
        wait: (options: DurableJobWaitOptions) =>
          this.#waitForResult(operation, idempotencyKey, options),
      });
      Object.defineProperty(this, operation, {
        value: method,
        enumerable: true,
      });
    }

    this.#engine.migrateSchema('operations', durabilityOperationMigrations);
    this.#engine.register({
      kind: 'calls',
      runDue: (now) => this.#runDue(now),
    });
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
   * Destructively removes operation records created strictly before the
   * timestamp, regardless of status, and returns how many were removed.
   */
  async purgeBefore(before: number): Promise<number> {
    const purgedSignals = [...this.#operationWaitSignals].filter(
      ([, signal]) => signal.createdAt < before
    );
    const count = await this.#engine.purge(
      'calls',
      before,
      this.#active,
      'Durable operation was purged'
    );
    for (const [id, signal] of purgedSignals) {
      this.#settleOperationWait(id, signal.generation);
    }
    this.#emit({
      type: 'purged',
      entityKind: 'operation',
      timestamp: Date.now(),
      before,
      count,
    });
    return count;
  }

  async #runDue(now: number): Promise<void> {
    const due = await this.#engine.storage.calls.listDue(now, 100);
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
    const call = await this.#engine.storage.calls.get(idempotencyKey);
    if (!call) {
      return { status: 'not_found' };
    }
    assertOperation(idempotencyKey, call.operation, operation);
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
      throw new Error(
        `Completed durable call "${idempotencyKey}" has no result`
      );
    }
    return { status: 'completed', result: deserialize(call.result) };
  }

  #settleOperationWait(id: string, generation: string): void {
    const signal = this.#operationWaitSignals.get(id);
    if (!signal || signal.generation !== generation) {
      return;
    }

    this.#operationWaitSignals.delete(id);
    signal.resolve();
  }

  async #waitForResult(
    operation: string,
    idempotencyKey: string,
    waitOptions: DurableJobWaitOptions
  ): Promise<DurableOperationResult<unknown>> {
    const timeoutMs = waitOptions?.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('timeoutMs must be a non-negative safe integer');
    }

    const call = await this.#engine.storage.calls.get(idempotencyKey);
    if (!call) {
      return { status: 'not_found' };
    }
    assertOperation(idempotencyKey, call.operation, operation);
    if (call.status !== 'pending' || timeoutMs === 0) {
      return this.#getResult(operation, idempotencyKey);
    }

    let signal = this.#operationWaitSignals.get(idempotencyKey);
    if (!signal || signal.generation !== call.generation_id) {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((settled) => {
        resolve = settled;
      });
      signal = {
        generation: call.generation_id,
        createdAt: call.created_at,
        promise,
        resolve,
        waiters: 0,
      };
      this.#operationWaitSignals.get(idempotencyKey)?.resolve();
      this.#operationWaitSignals.set(idempotencyKey, signal);
    }

    signal.waiters += 1;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Register before re-reading: asynchronous storage may settle or purge
      // the operation between the first read and installing the signal.
      const current = await this.#engine.storage.calls.get(idempotencyKey);
      if (
        current?.generation_id !== call.generation_id ||
        current.status !== 'pending'
      ) {
        this.#settleOperationWait(idempotencyKey, call.generation_id);
      }
      await Promise.race([
        signal.promise,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
      ]);
      return this.#getResult(operation, idempotencyKey);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      signal.waiters -= 1;
      if (
        signal.waiters === 0 &&
        this.#operationWaitSignals.get(idempotencyKey) === signal
      ) {
        this.#operationWaitSignals.delete(idempotencyKey);
      }
    }
  }

  async #run(input: {
    id: string;
    operation: string;
    payload: unknown;
  }): Promise<void> {
    const payload = serialize(input.payload);
    const now = Date.now();
    const generation = crypto.randomUUID();
    let inserted = false;
    let winner: CallRow | undefined;
    await this.#engine.transaction(async (transaction) => {
      inserted = await transaction.calls.insert({
        id: input.id,
        operation: input.operation,
        payload,
        status: 'pending',
        result: null,
        attempt: 0,
        next_attempt_at: now,
        last_error: null,
        last_error_name: null,
        completed_at: null,
        created_at: now,
        generation_id: generation,
      });
      winner = await transaction.calls.get(input.id);
      if (!winner) {
        throw new Error(`Durable call "${input.id}" was not persisted`);
      }
      assertOperation(input.id, winner.operation, input.operation);
      await this.#engine.reconcile(transaction);
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
      const call = await this.#engine.storage.calls.get(id);
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
    const handler = this.#handlers[call.operation] as
      | ((durableCall: DurableCall<unknown>) => unknown)
      | undefined;
    return this.#engine.startExecution(
      {
        kind: 'calls',
        key: call.id,
        row: call,
        label: `operation "${call.operation}"`,
        entity: operationEntity(call),
        active: this.#active,
        policy,
        emit: (event) => {
          this.#emit(event);
          if (
            event.type === 'terminal' ||
            (event.type === 'attempt_settled' &&
              (event.outcome === 'completed' || event.outcome === 'failed'))
          ) {
            this.#settleOperationWait(call.id, call.generation_id);
          }
        },
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
        complete: async (result, attempt) => {
          let serialized: string;
          try {
            serialized = serialize(result);
          } catch (error) {
            throw new DurableResultSerializationError(call.operation, error);
          }
          const timestamp = Date.now();
          const updated = await this.#engine.storage.calls.settle(
            call.id,
            call.generation_id,
            attempt,
            {
              status: 'completed',
              result: serialized,
              last_error: null,
              last_error_name: null,
              completed_at: timestamp,
            }
          );
          return updated ? timestamp : undefined;
        },
        isTerminal: (error) =>
          isErrorInstance(error, DurableResultSerializationError),
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

export interface DurabilityConstructor {
  new <Handlers extends HandlerMap>(
    config: DurabilityConfig<Handlers>
  ): Durability<Handlers>;
  migrate: typeof DurabilityCore.migrate;
}

// TypeScript cannot declare class members derived from a generic handler map,
// so the constructor is typed separately; the constructor installs and reserves
// every operation method at runtime.
export const Durability = DurabilityCore as unknown as DurabilityConstructor;
