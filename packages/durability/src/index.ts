import type { DurableMigrations } from '@durability/storage';
import { z } from 'zod';
import { DOQB, type Migration } from 'workers-qb';
import { exponential, jitter } from './utils.js';

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

/**
 * A function that executes one attempt of a durable operation.
 *
 * @example
 * ```ts
 * const resizeImage: DurableHandler<ResizeInput, string> = async ({
 *   id,
 *   payload,
 * }) => images.resize(payload.imageId, { idempotencyKey: id });
 * ```
 */
export type DurableHandler<Payload, Result> = (
  call: DurableCall<Payload>
) => Result | Promise<Result>;

/**
 * Retry policy shared by all methods or overridden for one method.
 *
 * The delay callback owns the complete scheduling policy, so it can compose the
 * helpers exported from `durability/utils` or use an application-specific
 * strategy.
 *
 * @example
 * ```ts
 * import { exponential, jitter } from 'durability/utils';
 *
 * const retries: DurabilityRetryOptions = {
 *   maxAttempts: 5,
 *   delay: (attempt) => jitter(exponential(attempt)),
 * };
 * ```
 */
export type DurabilityRetryOptions = {
  /** Returns the delay in milliseconds after a failed attempt. */
  delay?: (attempt: number) => number;
  /** The total number of attempts, including the initial attempt. Defaults to 5. */
  maxAttempts?: number;
};

type HandlerMap = Record<string, (...args: never[]) => unknown>;

/**
 * Execution policy overrides for one durable operation method.
 *
 * @example
 * ```ts
 * const resizePolicy: DurabilityMethodOptions = {
 *   attemptTimeoutMs: 60_000,
 *   retries: { maxAttempts: 2 },
 * };
 * ```
 */
export type DurabilityMethodOptions = {
  /** Maximum duration of one attempt in milliseconds. */
  attemptTimeoutMs?: number;
  /** Retry policy overrides for this method. */
  retries?: DurabilityRetryOptions;
};

/**
 * Configuration for a durability instance.
 *
 * Method-level values override global timeout and retry values without changing
 * the policy for other handlers.
 *
 * @example
 * ```ts
 * const options: DurabilityOptions<typeof handlers> = {
 *   alarmConcurrency: 5,
 *   attemptTimeoutMs: 30_000,
 *   retries: { maxAttempts: 5 },
 *   methods: {
 *     resizeImage: {
 *       attemptTimeoutMs: 60_000,
 *       retries: { maxAttempts: 2 },
 *     },
 *   },
 * };
 * ```
 */
export type DurabilityOptions<Handlers extends HandlerMap = HandlerMap> = {
  /** Maximum immediate operations executed concurrently by an alarm. Defaults to 10. */
  alarmConcurrency?: number;
  /** Time before a running alarm hands unfinished work to a new alarm. Defaults to 14 minutes. */
  alarmHandoffMs?: number;
  /** Maximum duration of one handler attempt. Defaults to 5 minutes. */
  attemptTimeoutMs?: number;
  /** Execution policy overrides keyed by handler name. */
  methods?: Partial<
    Record<Extract<keyof Handlers, string>, DurabilityMethodOptions>
  >;
  /** Retry policy shared by handlers without a method-level override. */
  retries?: DurabilityRetryOptions;
};

type HandlerPayload<Handler> = Handler extends (
  call: DurableCall<infer Payload>
) => unknown
  ? Payload
  : never;

type CallRow = {
  id: string;
  operation: string;
  payload: string;
  status: 'pending' | 'completed' | 'failed';
  result: string | null;
  attempt: number;
  next_attempt_at: number;
  last_error: string | null;
  last_error_name: string | null;
};

type DurableOperationInput<Handler> = {
  /** Stable idempotency key used to deduplicate the operation. */
  id: string;
  /** JSON-serializable input passed to the operation handler. */
  payload: HandlerPayload<Handler>;
};

type HandlerResult<Handler> = Handler extends (...args: never[]) => infer Result
  ? Awaited<Result>
  : never;

/**
 * The persisted state and result of a durable operation.
 *
 * Operation methods only wait for durable registration, not handler completion.
 * Call `getResult` later and narrow on `status` before reading a result or error.
 *
 * @example
 * ```ts
 * const state = await durability.resizeImage.getResult('resize:image-1');
 *
 * if (state.status === 'completed') {
 *   console.log(state.result);
 * } else if (state.status === 'failed') {
 *   console.error(state.error.name, state.error.message);
 * }
 * ```
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

/** Registers calls for one handler and reads their persisted results. */
type DurableOperation<Handler> = ((
  input: DurableOperationInput<Handler>
) => Promise<void>) & {
  /** Reads the persisted state for an idempotency key. */
  getResult: (
    idempotencyKey: string
  ) => Promise<DurableOperationResult<HandlerResult<Handler>>>;
};

/**
 * Typed operation methods and alarm handler created from a handler map.
 *
 * Each handler key becomes a registration method. The Durable Object must also
 * forward its alarm callback so pending retries survive object eviction.
 *
 * @example
 * ```ts
 * declare const durability: Durability<typeof handlers>;
 *
 * await durability.resizeImage({
 *   id: 'resize:image-1',
 *   payload: { imageId: 'image-1' },
 * });
 *
 * const alarm = (info: AlarmInvocationInfo) => durability.alarm(info);
 * ```
 */
export type Durability<Handlers extends HandlerMap> = {
  /** Processes due operations. Forward the Durable Object's alarm handler here. */
  alarm: (alarmInfo?: AlarmInvocationInfo) => Promise<void>;
} & {
  [Operation in keyof Handlers]: DurableOperation<Handlers[Operation]>;
};

const tableName = 'durability_calls';
const migrationTableName = 'durability_migrations';
const storedValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.json() }),
  z.object({ kind: z.literal('undefined') }),
]);
/**
 * Ordered SQLite migrations for the tables owned by durability.
 *
 * Every SQLite-backed Durable Object instance has an independent database, so
 * the durability schema must exist in each instance before calls can be stored.
 * {@link createDurability} applies these migrations automatically on instance
 * initialization. They are tracked in the namespaced `durability_migrations`
 * table so they can coexist with application-owned migrations in the same
 * database.
 *
 * The list is exported so migration names can be inspected before an explicit
 * rollback with {@link migrateDurability}. Most consumers should not execute
 * the SQL directly.
 *
 * @example
 * ```ts
 * const currentTarget = durabilityMigrations.at(-1)?.name ?? null;
 * migrateDurability(this.ctx, currentTarget);
 * ```
 */
export const durabilityMigrations = [
  {
    name: 'durability_0001_create_calls',
    up: `
      CREATE TABLE IF NOT EXISTS durability_calls (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
        result TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        last_error_name TEXT,
        completed_at INTEGER
      );
    `,
    down: 'DROP TABLE IF EXISTS durability_calls;',
  },
  {
    name: 'durability_0002_pending_index',
    up: `
      CREATE INDEX IF NOT EXISTS durability_calls_pending_idx
      ON durability_calls (status, next_attempt_at);
    `,
    down: 'DROP INDEX IF EXISTS durability_calls_pending_idx;',
  },
] satisfies DurableMigrations;

/**
 * Migration names changed by a call to {@link migrateDurability}.
 *
 * @example
 * ```ts
 * const { applied, rolledBack } = migrateDurability(this.ctx);
 * console.log({ applied, rolledBack });
 * ```
 */
export type DurabilityMigrationResult = {
  /** Migrations applied in ascending order. */
  applied: string[];
  /** Migrations reverted in descending order. */
  rolledBack: string[];
};

/**
 * Moves the durability schema in one Durable Object instance to a target.
 *
 * {@link createDurability} calls this with the latest target automatically. Call
 * it directly only for explicit schema management, especially rollbacks. Passing
 * `null` removes every durability table and permanently deletes stored calls.
 *
 * @example Apply all pending durability migrations.
 * ```ts
 * migrateDurability(this.ctx);
 * ```
 *
 * @example Roll back to a specific version, then remove the schema entirely.
 * ```ts
 * migrateDurability(this.ctx, 'durability_0001_create_calls');
 * migrateDurability(this.ctx, null);
 * ```
 *
 * @param context Durable Object context containing SQLite-backed storage.
 * @param target Migration name to migrate to, or null to roll back all migrations.
 */
export const migrateDurability = (
  context: Pick<DurableObjectState, 'storage'>,
  target: string | null = durabilityMigrations[durabilityMigrations.length - 1]
    ?.name ?? null
): DurabilityMigrationResult => {
  const targetIndex =
    target === null
      ? -1
      : durabilityMigrations.findIndex(
          (migration) => migration.name === target
        );
  if (target !== null && targetIndex === -1) {
    throw new Error(`Unknown durability migration target "${target}"`);
  }

  const qb = new DOQB(context.storage.sql);
  const workersQbMigrations: Migration[] = durabilityMigrations.map(
    ({ name, up }) => ({ name, sql: up })
  );
  const migrationBuilder = qb.migrations({
    migrations: workersQbMigrations,
    tableName: 'durability_migrations',
  });
  const appliedNames = new Set(
    migrationBuilder.getApplied().map((migration) => migration.name)
  );
  const rolledBack: string[] = [];

  for (
    let index = durabilityMigrations.length - 1;
    index > targetIndex;
    index--
  ) {
    const migration = durabilityMigrations[index];
    if (!migration || !appliedNames.has(migration.name)) {
      continue;
    }
    qb.raw({
      query: `${migration.down}\nDELETE FROM ${migrationTableName} WHERE name = '${migration.name}';`,
    }).execute();
    rolledBack.push(migration.name);
  }

  const applied = qb
    .migrations({
      migrations: workersQbMigrations.slice(0, targetIndex + 1),
      tableName: 'durability_migrations',
    })
    .apply()
    .map((migration) => migration.name);

  return { applied, rolledBack };
};

/**
 * Marks a handler failure as terminal so it is persisted without another retry.
 *
 * Use this for permanent failures such as invalid input. Transient errors should
 * be thrown normally so the configured retry policy can handle them.
 *
 * @example
 * ```ts
 * if (!recipient.isValid) {
 *   throw new NonRetryableError('Recipient is invalid');
 * }
 * ```
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/**
 * Error recorded when a handler attempt exceeds its configured timeout.
 *
 * Durability creates this error and aborts the attempt's signal; consumers do
 * not need to throw it themselves. Timeout failures follow the normal retry
 * policy and are exposed by `getResult` if they become terminal.
 *
 * @example
 * ```ts
 * const state = await durability.resizeImage.getResult('resize:image-1');
 * if (
 *   state.status === 'failed' &&
 *   state.error.name === 'DurableAttemptTimeoutError'
 * ) {
 *   console.error('Resize timed out');
 * }
 * ```
 */
export class DurableAttemptTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Durable operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'DurableAttemptTimeoutError';
  }
}

/**
 * Error thrown when an idempotency key is reused for another operation.
 *
 * A call ID permanently identifies its original operation so `getResult` cannot
 * return a value with the wrong inferred type.
 *
 * @example
 * ```ts
 * await durability.resizeImage({ id: 'job:1', payload: resizeInput });
 * await durability.sendEmail({ id: 'job:1', payload: emailInput });
 * // Throws DuplicateDurableCallError because job:1 belongs to resizeImage.
 * ```
 */
export class DuplicateDurableCallError extends Error {
  constructor(
    id: string,
    existingOperation: string,
    requestedOperation: string
  ) {
    super(
      `Durable call "${id}" already belongs to operation "${existingOperation}", not "${requestedOperation}"`
    );
    this.name = 'DuplicateDurableCallError';
  }
}

/**
 * Creates typed, alarm-backed durable methods from an operation handler map.
 *
 * Registered calls persist before execution and are deduplicated by their IDs.
 * Generated methods resolve after registration; read handler results with each
 * method's `getResult` function.
 *
 * The Durable Object class must use SQLite storage, and its `alarm` method must
 * delegate to the returned alarm handler. External side effects should use the
 * call ID as an idempotency key because a crash can occur after a side effect but
 * before the completion record commits.
 *
 * @example
 * ```ts
 * class ImageJobs extends DurableObject<Env> {
 *   private readonly durability = createDurability(this.ctx, {
 *     resizeImage: async ({ id, payload, signal }) =>
 *       this.env.IMAGES.resize(payload.imageId, {
 *         idempotencyKey: id,
 *         signal,
 *       }),
 *   });
 *
 *   resize(imageId: string) {
 *     return this.durability.resizeImage({
 *       id: `resize:${imageId}`,
 *       payload: { imageId },
 *     });
 *   }
 *
 *   alarm(info: AlarmInvocationInfo) {
 *     return this.durability.alarm(info);
 *   }
 * }
 * ```
 *
 * @param context Durable Object context containing SQLite-backed storage.
 * @param handlers Operation handlers keyed by their public method names.
 * @param options Concurrency, timeout, and retry policy configuration.
 */
export const createDurability = <Handlers extends HandlerMap>(
  context: Pick<DurableObjectState, 'storage'>,
  handlers: Handlers,
  options: DurabilityOptions<Handlers> = {}
): Durability<Handlers> => {
  migrateDurability(context);
  const qb = new DOQB(context.storage.sql);

  const active = new Map<string, Promise<unknown>>();
  const alarmConcurrency = options.alarmConcurrency ?? 10;
  const alarmHandoffMs = options.alarmHandoffMs ?? 14 * 60_000;
  const defaultAttemptTimeoutMs = options.attemptTimeoutMs ?? 5 * 60_000;
  const defaultRetryDelay =
    options.retries?.delay ??
    ((attempt: number) => jitter(exponential(attempt)));
  const defaultMaxAttempts = options.retries?.maxAttempts ?? 5;
  if (!Number.isInteger(alarmConcurrency) || alarmConcurrency < 1) {
    throw new RangeError('alarmConcurrency must be a positive integer');
  }
  if (
    !Number.isInteger(defaultAttemptTimeoutMs) ||
    defaultAttemptTimeoutMs < 1
  ) {
    throw new RangeError('attemptTimeoutMs must be a positive integer');
  }
  if (!Number.isInteger(defaultMaxAttempts) || defaultMaxAttempts < 1) {
    throw new RangeError('retries.maxAttempts must be a positive integer');
  }

  const methodOptions = (options.methods ?? {}) as Record<
    string,
    DurabilityMethodOptions | undefined
  >;
  for (const [operation, method] of Object.entries(methodOptions)) {
    if (
      method?.attemptTimeoutMs !== undefined &&
      (!Number.isInteger(method.attemptTimeoutMs) ||
        method.attemptTimeoutMs < 1)
    ) {
      throw new RangeError(
        `methods.${operation}.attemptTimeoutMs must be a positive integer`
      );
    }
    if (
      method?.retries?.maxAttempts !== undefined &&
      (!Number.isInteger(method.retries.maxAttempts) ||
        method.retries.maxAttempts < 1)
    ) {
      throw new RangeError(
        `methods.${operation}.retries.maxAttempts must be a positive integer`
      );
    }
  }

  const executionPolicy = (operation: string) => {
    const method = methodOptions[operation];
    return {
      attemptTimeoutMs: method?.attemptTimeoutMs ?? defaultAttemptTimeoutMs,
      delay: method?.retries?.delay ?? defaultRetryDelay,
      maxAttempts: method?.retries?.maxAttempts ?? defaultMaxAttempts,
    };
  };

  const isNonRetryable = (error: unknown): boolean => {
    if (error instanceof NonRetryableError) {
      return true;
    }
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const value = error as {
      constructor?: { name?: string };
      name?: string;
    };
    return (
      value.name === 'NonRetryableError' ||
      value.constructor?.name === 'NonRetryableError'
    );
  };

  const serialize = (value: unknown): string =>
    JSON.stringify(
      value === undefined
        ? { kind: 'undefined' }
        : { kind: 'value', value: z.json().parse(value) }
    );

  const deserialize = (value: string): unknown => {
    const parsed: unknown = JSON.parse(value);
    const stored = storedValueSchema.parse(parsed);
    return stored.kind === 'undefined' ? undefined : stored.value;
  };

  const getCall = (id: string): CallRow | undefined =>
    qb
      .fetchOne<CallRow>({
        tableName,
        where: { conditions: 'id = ?', params: [id] },
      })
      .execute().results;

  const getResult = (
    operation: string,
    idempotencyKey: string
  ): DurableOperationResult<unknown> => {
    const call = getCall(idempotencyKey);
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
  };

  const listDueIds = (now: number, limit: number): string[] =>
    (
      qb
        .fetchAll<Pick<CallRow, 'id'>>({
          tableName,
          fields: 'id',
          where: {
            conditions: "status = 'pending' AND next_attempt_at <= ?",
            params: [now],
          },
          orderBy: 'next_attempt_at ASC',
          limit,
        })
        .execute().results ?? []
    ).map((call) => call.id);

  const getNextPendingAt = (): number | undefined =>
    qb
      .fetchOne<Pick<CallRow, 'next_attempt_at'>>({
        tableName,
        fields: 'next_attempt_at',
        where: { conditions: "status = 'pending'" },
        orderBy: 'next_attempt_at ASC',
      })
      .execute().results?.next_attempt_at;

  const runConcurrent = async <Item>(
    items: Item[],
    concurrency: number,
    worker: (item: Item) => Promise<void>
  ): Promise<void> => {
    let nextIndex = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
          const item = items[nextIndex++];
          if (item !== undefined) {
            // eslint-disable-next-line no-await-in-loop
            await worker(item);
          }
        }
      })
    );
  };

  const assertOperation = (
    id: string,
    existingOperation: string,
    requestedOperation: string
  ) => {
    if (existingOperation !== requestedOperation) {
      throw new DuplicateDurableCallError(
        id,
        existingOperation,
        requestedOperation
      );
    }
  };

  const armIfMissing = async (timestamp: number) => {
    const currentAlarm = await context.storage.getAlarm();
    if (currentAlarm === null) {
      await context.storage.setAlarm(timestamp);
    }
  };

  let alarmRefresh: Promise<void> | undefined;
  const scheduleNextAlarm = (): Promise<void> => {
    if (alarmRefresh) {
      return alarmRefresh;
    }

    alarmRefresh = context.storage
      .transaction(async (transaction) => {
        const nextAttemptAt = getNextPendingAt();
        const currentAlarm = await transaction.getAlarm();
        if (nextAttemptAt === undefined) {
          if (currentAlarm !== null) {
            await transaction.deleteAlarm();
          }
        } else if (currentAlarm === null) {
          await transaction.setAlarm(nextAttemptAt);
        }
      })
      .finally(() => {
        alarmRefresh = undefined;
      });
    return alarmRefresh;
  };

  const execute = (id: string): Promise<unknown> => {
    const running = active.get(id);
    if (running) {
      return running;
    }

    const execution = (async () => {
      const call = getCall(id);
      if (!call) {
        return undefined;
      }
      if (call.status === 'completed') {
        if (call.result === null) {
          throw new Error(`Completed durable call "${id}" has no result`);
        }
        return deserialize(call.result);
      }
      if (call.status === 'failed') {
        return undefined;
      }

      const handler = handlers[call.operation] as
        | ((durableCall: DurableCall<unknown>) => unknown)
        | undefined;
      const attempt = call.attempt + 1;
      const policy = executionPolicy(call.operation);

      qb.update({
        tableName,
        data: { attempt },
        where: { conditions: 'id = ?', params: [id] },
      }).execute();

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!handler) {
          throw new NonRetryableError(
            `No handler registered for operation "${call.operation}"`
          );
        }

        const controller = new AbortController();
        const handlerResult = Promise.resolve().then(() =>
          handler({
            id,
            operation: call.operation,
            payload: deserialize(call.payload),
            attempt,
            signal: controller.signal,
          })
        );
        const timeoutResult = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new DurableAttemptTimeoutError(
              call.operation,
              policy.attemptTimeoutMs
            );
            controller.abort(error);
            reject(error);
          }, policy.attemptTimeoutMs);
        });
        const result = await Promise.race([handlerResult, timeoutResult]);

        qb.update({
          tableName,
          data: {
            status: 'completed',
            result: serialize(result),
            last_error: null,
            last_error_name: null,
            completed_at: Date.now(),
          },
          where: { conditions: 'id = ?', params: [id] },
        }).execute();
        return result;
      } catch (error) {
        const terminal = isNonRetryable(error) || attempt >= policy.maxAttempts;
        const baseDelay = terminal ? 0 : policy.delay(attempt);
        if (!Number.isFinite(baseDelay) || baseDelay < 0) {
          throw new RangeError(
            `Retry delay for operation "${call.operation}" must be a non-negative finite number`
          );
        }
        const nextAttemptAt = Date.now() + Math.round(baseDelay);
        await context.storage.transaction(async (transaction) => {
          qb.update({
            tableName,
            data: {
              status: terminal ? 'failed' : 'pending',
              attempt,
              next_attempt_at: nextAttemptAt,
              last_error:
                error instanceof Error ? error.message : String(error),
              last_error_name: error instanceof Error ? error.name : 'Error',
            },
            where: { conditions: 'id = ?', params: [id] },
          }).execute();
          if (!terminal && (await transaction.getAlarm()) === null) {
            await transaction.setAlarm(nextAttemptAt);
          }
        });
        throw error;
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    })();

    active.set(id, execution);
    void execution.finally(() => active.delete(id)).catch(() => undefined);
    return execution;
  };

  const run = async (input: {
    id: string;
    operation: string;
    payload: unknown;
  }): Promise<void> => {
    const existing = getCall(input.id);
    if (existing) {
      assertOperation(input.id, existing.operation, input.operation);
      if (existing.status === 'completed' || existing.status === 'failed') {
        return;
      }
      await context.storage.transaction(async (transaction) => {
        if ((await transaction.getAlarm()) === null) {
          await transaction.setAlarm(existing.next_attempt_at);
        }
      });
    } else {
      const now = Date.now();
      await context.storage.transaction(async (transaction) => {
        qb.insert({
          tableName,
          data: {
            id: input.id,
            operation: input.operation,
            payload: serialize(input.payload),
            status: 'pending',
            attempt: 0,
            next_attempt_at: now,
          },
        }).execute();
        if ((await transaction.getAlarm()) === null) {
          await transaction.setAlarm(now);
        }
      });
    }

    const execution = execute(input.id);
    void execution.then(() => scheduleNextAlarm()).catch(() => undefined);
  };

  const alarm = async (_alarmInfo?: AlarmInvocationInfo): Promise<void> => {
    const startedAt = Date.now();
    const due = listDueIds(startedAt, 100);
    if (due.length === 0) {
      await scheduleNextAlarm();
      return;
    }

    const execution = runConcurrent(due, alarmConcurrency, async (id) => {
      try {
        await execute(id);
      } catch {
        return;
      }
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const handoff = Symbol('alarm handoff');
    const remaining = alarmHandoffMs - (Date.now() - startedAt);
    const result = await Promise.race([
      execution,
      new Promise<typeof handoff>((resolve) => {
        timeout = setTimeout(() => resolve(handoff), Math.max(remaining, 0));
      }),
    ]);

    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (result === handoff) {
      await armIfMissing(Date.now());
      return;
    }
    await scheduleNextAlarm();
  };

  const durability: Record<string, unknown> = { alarm };
  for (const operation of Object.keys(handlers) as (keyof Handlers &
    string)[]) {
    if (operation === 'alarm') {
      throw new Error(`"${operation}" is reserved by durability`);
    }

    const durableOperation = (input: { id: string; payload: unknown }) =>
      run({ ...input, operation });
    durableOperation.getResult = async (idempotencyKey: string) =>
      getResult(operation, idempotencyKey);
    durability[operation] = durableOperation;
  }

  return durability as Durability<Handlers>;
};
