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

/** Information passed to a named alarm handler for one execution attempt. */
export type DurableAlarmInfo = {
  /** Configured name of the logical alarm. */
  name: string;
  /** Timestamp originally passed to the named alarm method. */
  scheduledTime: number;
  /** One-based execution attempt for this scheduled occurrence. */
  attempt: number;
  /** Whether this scheduled occurrence has run before. */
  isRetry: boolean;
  /** Number of previous attempts for this scheduled occurrence. */
  retryCount: number;
  /** Stable key shared by every attempt of this scheduled occurrence. */
  idempotencyKey: string;
  /** Aborts when the attempt exceeds its configured timeout. */
  signal: AbortSignal;
  /** Invocation information for the shared physical Durable Object alarm. */
  platform: AlarmInvocationInfo | undefined;
};

/** A handler for one named logical alarm. */
export type DurableAlarmHandler = (
  info: DurableAlarmInfo
) => unknown | Promise<unknown>;

const alarmHandlerSchema = z.custom<DurableAlarmHandler>(
  (value) => typeof value === 'function'
);

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
  /** Retry timeouts only when side effects are idempotent or reconciled. */
  retryTimeouts?: boolean;
};

const retryOptionsSchema = z.object({
  delay: z
    .custom<NonNullable<DurabilityRetryOptions['delay']>>(
      (value) => typeof value === 'function'
    )
    .optional(),
  maxAttempts: z.number().optional(),
});

const durabilityMethodOptionsSchema = z.object({
  attemptTimeoutMs: z.number().optional(),
  retries: retryOptionsSchema.optional(),
  retryTimeouts: z.boolean().optional(),
});

/** Execution policy overrides for one named alarm. */
export type DurabilityAlarmMethodOptions = {
  /** Maximum duration of one attempt in milliseconds. */
  attemptTimeoutMs?: number;
  /** Retry policy overrides for this alarm. */
  retries?: DurabilityRetryOptions;
  /** Retry timed-out attempts only when their side effects are idempotent or reconciled. */
  retryTimeouts?: boolean;
};

const durabilityAlarmMethodOptionsSchema = durabilityMethodOptionsSchema;

/**
 * Configuration for a durability instance.
 *
 * Operation and named-alarm overrides replace global timeout and retry values
 * without changing the policy for other handlers.
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
type SerializedError = { name: string; message: string };

type OperationLifecycleEntity = {
  entityKind: 'operation';
  operation: string;
  id: string;
  generation: string;
};

type AlarmLifecycleEntity = {
  entityKind: 'named_alarm';
  alarm: string;
  id: string;
  generation: string;
};

type LifecycleEntity = OperationLifecycleEntity | AlarmLifecycleEntity;

/** Best-effort metrics signal for queue lifecycle changes. */
export type DurabilityLifecycleEvent =
  | (OperationLifecycleEntity & {
      type: 'registered';
      timestamp: number;
      attempt: 0;
    })
  | (AlarmLifecycleEntity & {
      type: 'scheduled';
      timestamp: number;
      attempt: 0;
      scheduledTime: number;
    })
  | (LifecycleEntity & {
      type: 'attempt_started';
      timestamp: number;
      attempt: number;
    })
  | (LifecycleEntity & {
      type: 'attempt_settled';
      timestamp: number;
      attempt: number;
      durationMs: number;
      outcome: 'completed';
    })
  | (LifecycleEntity & {
      type: 'attempt_settled';
      timestamp: number;
      attempt: number;
      durationMs: number;
      outcome: 'retry_scheduled';
      error: SerializedError;
      nextAttemptAt: number;
    })
  | (LifecycleEntity & {
      type: 'attempt_settled';
      timestamp: number;
      attempt: number;
      durationMs: number;
      outcome: 'failed';
      error: SerializedError;
    })
  | (LifecycleEntity & {
      type: 'terminal';
      timestamp: number;
      attempt: number;
      reason: 'attempts_exhausted';
      error: SerializedError;
    })
  | {
      type: 'purged';
      entityKind: 'durability';
      timestamp: number;
      before: number;
      operations: number;
      namedAlarms: number;
      total: number;
    };

export type DurabilityOptions<
  Handlers extends HandlerMap = HandlerMap,
  AlarmNames extends string = never,
> = {
  /** Named logical alarms sharing the Durable Object's physical alarm. */
  alarms?: Record<AlarmNames, DurableAlarmHandler>;
  /** Execution policy overrides keyed by named alarm. */
  alarmMethods?: [AlarmNames] extends [never]
    ? never
    : Partial<Record<NoInfer<AlarmNames>, DurabilityAlarmMethodOptions>>;
  /** Maximum handlers shared by eager operations and alarm work. Defaults to 10. */
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
  /** Receives best-effort, non-durable lifecycle metrics events. */
  onLifecycleEvent?: (event: DurabilityLifecycleEvent) => void | Promise<void>;
};

type HandlerPayload<Handler> = Handler extends (
  call: DurableCall<infer Payload>
) => unknown
  ? Payload
  : never;

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
const callAttemptSchema = callRowSchema.pick({ attempt: true });
const callIdSchema = callRowSchema.pick({ id: true });
const callNextAttemptSchema = callRowSchema.pick({ next_attempt_at: true });
type CallRow = z.infer<typeof callRowSchema>;

const alarmRowSchema = z.object({
  name: z.string(),
  generation_id: z.string(),
  status: z.enum(['pending', 'failed']),
  scheduled_at: z.number().int().nonnegative(),
  next_attempt_at: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  last_error_name: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
});
const alarmAttemptSchema = alarmRowSchema.pick({ attempt: true });
const countSchema = z.object({ count: z.number().int().nonnegative() });
type AlarmRow = z.infer<typeof alarmRowSchema>;

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
type DurableNamedAlarm = (scheduledTime: number) => Promise<void>;

type DurabilityAlarm<AlarmNames extends string> = ((
  alarmInfo?: AlarmInvocationInfo
) => Promise<void>) &
  Record<AlarmNames, DurableNamedAlarm>;

/** Aggregate counts returned by a destructive purge. */
export type DurablePurgeResult = {
  operations: number;
  namedAlarms: number;
  total: number;
};

export type Durability<
  Handlers extends HandlerMap,
  AlarmNames extends string = never,
> = {
  /** Processes due work and exposes methods for scheduling named alarms. */
  alarm: DurabilityAlarm<AlarmNames>;
  /** Destructively removes all queue records created before a timestamp. */
  purgeBefore: (timestamp: number) => Promise<DurablePurgeResult>;
} & {
  [Operation in keyof Handlers]: DurableOperation<Handlers[Operation]>;
};

const tableName = 'durability_calls';
const alarmTableName = 'durability_alarms';
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
  {
    name: 'durability_0003_create_alarms',
    up: `
      CREATE TABLE IF NOT EXISTS durability_alarms (
        name TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'failed')),
        scheduled_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_name TEXT
      );
      CREATE INDEX IF NOT EXISTS durability_alarms_pending_idx
      ON durability_alarms (status, next_attempt_at);
    `,
    down: `
      DROP INDEX IF EXISTS durability_alarms_pending_idx;
      DROP TABLE IF EXISTS durability_alarms;
    `,
  },
  {
    name: 'durability_0004_generation_and_created_at',
    up: `
      DROP INDEX IF EXISTS durability_calls_pending_idx;
      ALTER TABLE durability_calls RENAME TO durability_calls_v3;
      CREATE TABLE durability_calls (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
        result TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        last_error_name TEXT,
        completed_at INTEGER,
        generation_id TEXT NOT NULL DEFAULT 'legacy',
        created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
      );
      INSERT INTO durability_calls
      SELECT id, operation, payload, status, result, attempt, next_attempt_at,
        last_error, last_error_name, completed_at, 'legacy:' || id,
        CAST(unixepoch('subsec') * 1000 AS INTEGER)
      FROM durability_calls_v3;
      DROP TABLE durability_calls_v3;
      CREATE INDEX durability_calls_pending_idx
      ON durability_calls (status, next_attempt_at);
      CREATE INDEX durability_calls_created_idx
      ON durability_calls (created_at);

      DROP INDEX IF EXISTS durability_alarms_pending_idx;
      ALTER TABLE durability_alarms RENAME TO durability_alarms_v3;
      CREATE TABLE durability_alarms (
        name TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'failed')),
        scheduled_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_name TEXT,
        created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
      );
      INSERT INTO durability_alarms
      SELECT name, generation_id, status, scheduled_at, next_attempt_at,
        attempt, last_error, last_error_name,
        CAST(unixepoch('subsec') * 1000 AS INTEGER)
      FROM durability_alarms_v3;
      DROP TABLE durability_alarms_v3;
      CREATE INDEX durability_alarms_pending_idx
      ON durability_alarms (status, next_attempt_at);
      CREATE INDEX durability_alarms_created_idx
      ON durability_alarms (created_at);
    `,
    down: `
      DROP INDEX IF EXISTS durability_calls_pending_idx;
      DROP INDEX IF EXISTS durability_calls_created_idx;
      ALTER TABLE durability_calls RENAME TO durability_calls_v4;
      CREATE TABLE durability_calls (
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
      INSERT INTO durability_calls
      SELECT id, operation, payload, status, result, attempt, next_attempt_at,
        last_error, last_error_name, completed_at
      FROM durability_calls_v4;
      DROP TABLE durability_calls_v4;
      CREATE INDEX durability_calls_pending_idx
      ON durability_calls (status, next_attempt_at);

      DROP INDEX IF EXISTS durability_alarms_pending_idx;
      DROP INDEX IF EXISTS durability_alarms_created_idx;
      ALTER TABLE durability_alarms RENAME TO durability_alarms_v4;
      CREATE TABLE durability_alarms (
        name TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'failed')),
        scheduled_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_name TEXT
      );
      INSERT INTO durability_alarms
      SELECT name, generation_id, status, scheduled_at, next_attempt_at,
        attempt, last_error, last_error_name
      FROM durability_alarms_v4;
      DROP TABLE durability_alarms_v4;
      CREATE INDEX durability_alarms_pending_idx
      ON durability_alarms (status, next_attempt_at);
    `,
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

  if (target === null) {
    context.storage.sql.exec(`DROP TABLE IF EXISTS ${migrationTableName}`);
  }

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
 * not need to throw it themselves. Operation timeouts are terminal by default.
 * Set the method's `retryTimeouts` option to `true` to retry them.
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

/** Error recorded when a named alarm attempt exceeds its configured timeout. */
export class DurableAlarmTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Durable alarm "${name}" timed out after ${timeoutMs}ms`);
    this.name = 'DurableAlarmTimeoutError';
  }
}

/** Error persisted when retry-delay evaluation fails or is unsafe. */
export class DurableRetryPolicyError extends Error {
  constructor(entity: string, reason?: unknown) {
    super(
      `Retry policy for ${entity} must produce a non-negative safe-integer timestamp`
    );
    this.name = 'DurableRetryPolicyError';
    if (reason !== undefined) {
      Object.defineProperty(this, 'cause', { value: reason });
    }
  }
}

/** Error persisted when a successful result cannot be JSON-serialized. */
export class DurableResultSerializationError extends Error {
  constructor(operation: string, reason?: unknown) {
    super(
      `Result for durable operation "${operation}" is not JSON-serializable`
    );
    this.name = 'DurableResultSerializationError';
    if (reason !== undefined) {
      Object.defineProperty(this, 'cause', { value: reason });
    }
  }
}

/** Error persisted when pending work has already reached its attempt limit. */
export class DurableAttemptsExhaustedError extends Error {
  constructor(entity: 'operation' | 'named alarm', name: string, max: number) {
    super(`Durable ${entity} "${name}" exhausted its ${max} attempts`);
    this.name = 'DurableAttemptsExhaustedError';
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
 * @param options Named alarms, concurrency, timeout, and retry policies.
 */
type ActiveExecution = {
  generation: string;
  createdAt: number;
  settled: Promise<void>;
  controller?: AbortController;
};

export const createDurability = <
  Handlers extends HandlerMap,
  const AlarmNames extends string = never,
>(
  context: Pick<DurableObjectState, 'storage'> &
    Partial<Pick<DurableObjectState, 'waitUntil'>>,
  handlers: Handlers,
  options: DurabilityOptions<Handlers, AlarmNames> = {}
): Durability<Handlers, AlarmNames> => {
  migrateDurability(context);
  const qb = new DOQB(context.storage.sql);

  const active = new Map<string, ActiveExecution>();
  const activeAlarms = new Map<string, ActiveExecution>();
  const alarmHandlers = new Map(
    Object.entries(options.alarms ?? {}).map(([name, handler]) => [
      name,
      alarmHandlerSchema.parse(handler),
    ])
  );
  const alarmConcurrency = options.alarmConcurrency ?? 10;
  const alarmHandoffMs = options.alarmHandoffMs ?? 14 * 60_000;
  const defaultAttemptTimeoutMs = options.attemptTimeoutMs ?? 5 * 60_000;
  const retryOptions = retryOptionsSchema.parse(options.retries ?? {});
  const defaultRetryDelay =
    retryOptions.delay ?? ((attempt: number) => jitter(exponential(attempt)));
  const defaultMaxAttempts = retryOptions.maxAttempts ?? 5;
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

  const methodOptions = new Map(
    Object.entries(options.methods ?? {}).map(([operation, method]) => [
      operation,
      durabilityMethodOptionsSchema.parse(method),
    ])
  );
  for (const [operation, method] of methodOptions) {
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

  const alarmMethodOptions = new Map(
    Object.entries(options.alarmMethods ?? {}).map(([name, method]) => [
      name,
      durabilityAlarmMethodOptionsSchema.parse(method),
    ])
  );
  for (const [name, method] of alarmMethodOptions) {
    if (
      method?.attemptTimeoutMs !== undefined &&
      (!Number.isInteger(method.attemptTimeoutMs) ||
        method.attemptTimeoutMs < 1)
    ) {
      throw new RangeError(
        `alarmMethods.${name}.attemptTimeoutMs must be a positive integer`
      );
    }
    if (
      method?.retries?.maxAttempts !== undefined &&
      (!Number.isInteger(method.retries.maxAttempts) ||
        method.retries.maxAttempts < 1)
    ) {
      throw new RangeError(
        `alarmMethods.${name}.retries.maxAttempts must be a positive integer`
      );
    }
  }

  const executionPolicy = (operation: string) => {
    const method = methodOptions.get(operation);
    return {
      attemptTimeoutMs: method?.attemptTimeoutMs ?? defaultAttemptTimeoutMs,
      delay: method?.retries?.delay ?? defaultRetryDelay,
      maxAttempts: method?.retries?.maxAttempts ?? defaultMaxAttempts,
      retryTimeouts: method?.retryTimeouts ?? false,
    };
  };

  const alarmExecutionPolicy = (name: string) => {
    const method = alarmMethodOptions.get(name);
    return {
      attemptTimeoutMs: method?.attemptTimeoutMs ?? defaultAttemptTimeoutMs,
      delay: method?.retries?.delay ?? defaultRetryDelay,
      maxAttempts: method?.retries?.maxAttempts ?? defaultMaxAttempts,
      retryTimeouts: method?.retryTimeouts ?? false,
    };
  };

  const serializeError = (error: unknown): SerializedError => {
    let name = 'Error';
    let message = 'Unknown thrown value';
    try {
      if (error === null) {
        return { name, message: 'null' };
      }
      if (typeof error !== 'object' && typeof error !== 'function') {
        return { name, message: String(error) };
      }
      try {
        const candidate = Reflect.get(error, 'name');
        if (typeof candidate === 'string' && candidate.length > 0) {
          name = candidate;
        }
      } catch {
        name = 'Error';
      }
      try {
        const candidate = Reflect.get(error, 'message');
        if (typeof candidate === 'string' && candidate.length > 0) {
          message = candidate;
        }
      } catch {
        message = 'Unknown thrown value';
      }
      return { name, message };
    } catch {
      return { name: 'Error', message: 'Unknown thrown value' };
    }
  };

  const isErrorInstance = (
    error: unknown,
    constructor: new (...args: never[]) => Error
  ): boolean => {
    try {
      return error instanceof constructor;
    } catch {
      return false;
    }
  };

  const isNonRetryable = (error: unknown): boolean => {
    if (isErrorInstance(error, NonRetryableError)) {
      return true;
    }
    if (
      (typeof error !== 'object' && typeof error !== 'function') ||
      error === null
    ) {
      return false;
    }
    try {
      if (Reflect.get(error, 'name') === 'NonRetryableError') {
        return true;
      }
      const constructor = Reflect.get(error, 'constructor');
      return (
        constructor !== null &&
        (typeof constructor === 'object' ||
          typeof constructor === 'function') &&
        Reflect.get(constructor, 'name') === 'NonRetryableError'
      );
    } catch {
      return false;
    }
  };

  const reportFailure = (
    event: string,
    details: Record<string, unknown>,
    error: unknown
  ): void => {
    try {
      const normalized = serializeError(error);
      let stack: string | undefined;
      try {
        const candidate =
          error !== null &&
          (typeof error === 'object' || typeof error === 'function')
            ? Reflect.get(error, 'stack')
            : undefined;
        stack = typeof candidate === 'string' ? candidate : undefined;
      } catch {
        stack = undefined;
      }
      console.error({
        event,
        ...details,
        error: { ...normalized, ...(stack ? { stack } : {}) },
      });
    } catch {
      return;
    }
  };

  const emit = (event: DurabilityLifecycleEvent): void => {
    if (!options.onLifecycleEvent) {
      return;
    }
    const report = (error: unknown): void =>
      reportFailure(
        'durability.lifecycle_hook.failed',
        {
          entityKind: event.entityKind,
          lifecycleType: event.type,
          entityId: 'id' in event ? event.id : 'durability',
        },
        error
      );
    try {
      const result = options.onLifecycleEvent(event);
      if (result === undefined) {
        return;
      }
      const caught = Promise.resolve(result).catch(report);
      if (context.waitUntil) {
        try {
          context.waitUntil(caught);
          return;
        } catch (error) {
          report(error);
        }
      }
      void caught;
    } catch (error) {
      report(error);
    }
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
    callRowSchema.optional().parse(
      qb
        .fetchOne<CallRow>({
          tableName,
          where: { conditions: 'id = ?', params: [id] },
        })
        .execute().results
    );

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
    callIdSchema
      .array()
      .parse(
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
      )
      .map((call) => call.id);

  const getNextPendingAt = (): number | undefined =>
    callNextAttemptSchema.optional().parse(
      qb
        .fetchOne<Pick<CallRow, 'next_attempt_at'>>({
          tableName,
          fields: 'next_attempt_at',
          where: { conditions: "status = 'pending'" },
          orderBy: 'next_attempt_at ASC',
        })
        .execute().results
    )?.next_attempt_at;

  const listDueAlarms = (now: number, limit: number): AlarmRow[] =>
    alarmRowSchema.array().parse(
      qb
        .fetchAll<AlarmRow>({
          tableName: alarmTableName,
          where: {
            conditions: "status = 'pending' AND next_attempt_at <= ?",
            params: [now],
          },
          orderBy: 'next_attempt_at ASC',
          limit,
        })
        .execute().results ?? []
    );

  const getNextNamedAlarmAt = (): number | undefined =>
    alarmRowSchema
      .pick({ next_attempt_at: true })
      .optional()
      .parse(
        qb
          .fetchOne<Pick<AlarmRow, 'next_attempt_at'>>({
            tableName: alarmTableName,
            fields: 'next_attempt_at',
            where: { conditions: "status = 'pending'" },
            orderBy: 'next_attempt_at ASC',
          })
          .execute().results
      )?.next_attempt_at;

  const getNextAlarmAt = (): number | undefined => {
    const candidates = [getNextPendingAt(), getNextNamedAlarmAt()].filter(
      (value): value is number => value !== undefined
    );
    return candidates.length === 0 ? undefined : Math.min(...candidates);
  };

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

  const reconcileAlarm = async (transaction: DurableObjectTransaction) => {
    const nextAlarmAt = getNextAlarmAt();
    const currentAlarm = await transaction.getAlarm();
    if (nextAlarmAt === undefined) {
      if (currentAlarm !== null) {
        await transaction.deleteAlarm();
      }
      return;
    }

    const target = Math.max(nextAlarmAt, Date.now());
    if (currentAlarm !== target) {
      await transaction.setAlarm(target);
    }
  };

  const armForHandoff = async (timestamp: number) => {
    await context.storage.transaction(async (transaction) => {
      const currentAlarm = await transaction.getAlarm();
      if (currentAlarm === null || currentAlarm > timestamp) {
        await transaction.setAlarm(timestamp);
      }
    });
  };

  let alarmRefresh: Promise<void> | undefined;
  const scheduleNextAlarm = (): Promise<void> => {
    if (alarmRefresh) {
      return alarmRefresh;
    }

    alarmRefresh = context.storage.transaction(reconcileAlarm).finally(() => {
      alarmRefresh = undefined;
    });
    return alarmRefresh;
  };

  let availablePermits = alarmConcurrency;
  const permitWaiters: Array<(release: () => void) => void> = [];
  const createRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const waiter = permitWaiters.shift();
      if (waiter) {
        waiter(createRelease());
      } else {
        availablePermits += 1;
      }
    };
  };
  const tryAcquirePermit = (): (() => void) | undefined => {
    if (availablePermits === 0) {
      return undefined;
    }
    availablePermits -= 1;
    return createRelease();
  };
  const acquirePermit = (): Promise<() => void> => {
    const release = tryAcquirePermit();
    if (release) {
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      permitWaiters.push(resolve);
    });
  };

  const operationEntity = (call: CallRow): OperationLifecycleEntity => ({
    entityKind: 'operation',
    operation: call.operation,
    id: call.id,
    generation: call.generation_id,
  });

  const alarmEntity = (row: AlarmRow): AlarmLifecycleEntity => ({
    entityKind: 'named_alarm',
    alarm: row.name,
    id: row.name,
    generation: row.generation_id,
  });

  const scheduleNamedAlarm = async (name: string, scheduledTime: number) => {
    if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) {
      throw new RangeError('scheduledTime must be a non-negative safe integer');
    }

    const generation = crypto.randomUUID();
    const createdAt = Date.now();
    await context.storage.transaction(async (transaction) => {
      context.storage.sql.exec(
        `INSERT INTO durability_alarms
          (name, generation_id, status, scheduled_at, next_attempt_at, attempt,
           created_at)
          VALUES (?, ?, 'pending', ?, ?, 0, ?)
          ON CONFLICT(name) DO UPDATE SET
            generation_id = excluded.generation_id,
            status = 'pending',
            scheduled_at = excluded.scheduled_at,
            next_attempt_at = excluded.next_attempt_at,
            attempt = 0,
            last_error = NULL,
            last_error_name = NULL,
            created_at = excluded.created_at`,
        name,
        generation,
        scheduledTime,
        scheduledTime,
        createdAt
      );
      await reconcileAlarm(transaction);
    });
    emit({
      type: 'scheduled',
      entityKind: 'named_alarm',
      alarm: name,
      id: name,
      generation,
      timestamp: createdAt,
      attempt: 0,
      scheduledTime,
    });
  };

  const executeNamedAlarm = (
    row: AlarmRow,
    platform: AlarmInvocationInfo | undefined
  ): Promise<void> => {
    const running = activeAlarms.get(row.name);
    if (running) {
      return running.settled;
    }

    const policy = alarmExecutionPolicy(row.name);
    let settleActive: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settleActive = resolve;
    });
    const activeExecution: ActiveExecution = {
      generation: row.generation_id,
      createdAt: row.created_at,
      settled,
    };
    activeAlarms.set(row.name, activeExecution);
    let handlerStarted = false;
    let handlerSettled = false;
    let policySettled = false;
    let releasePermit: (() => void) | undefined;
    const releaseIfSettled = (): void => {
      if (policySettled && (!handlerStarted || handlerSettled)) {
        releasePermit?.();
        settleActive?.();
      }
    };

    const execution = (async (): Promise<void> => {
      releasePermit = await acquirePermit();
      const claimed = alarmAttemptSchema.optional().parse(
        context.storage.sql
          .exec<Pick<AlarmRow, 'attempt'>>(
            `UPDATE durability_alarms
             SET attempt = attempt + 1
             WHERE name = ? AND generation_id = ? AND status = 'pending'
               AND attempt < ?
             RETURNING attempt`,
            row.name,
            row.generation_id,
            policy.maxAttempts
          )
          .toArray()[0]
      );
      if (!claimed) {
        const current = alarmRowSchema.optional().parse(
          qb
            .fetchOne<AlarmRow>({
              tableName: alarmTableName,
              where: { conditions: 'name = ?', params: [row.name] },
            })
            .execute().results
        );
        if (
          current?.generation_id === row.generation_id &&
          current.attempt >= policy.maxAttempts
        ) {
          const exhausted = serializeError(
            new DurableAttemptsExhaustedError(
              'named alarm',
              row.name,
              policy.maxAttempts
            )
          );
          let updated = false;
          await context.storage.transaction(async (transaction) => {
            updated =
              context.storage.sql
                .exec(
                  `UPDATE durability_alarms
                   SET status = 'failed', last_error = ?, last_error_name = ?
                   WHERE name = ? AND generation_id = ? AND status = 'pending'
                     AND attempt >= ?
                   RETURNING name`,
                  exhausted.message,
                  exhausted.name,
                  row.name,
                  row.generation_id,
                  policy.maxAttempts
                )
                .toArray().length > 0;
            await reconcileAlarm(transaction);
          });
          if (updated) {
            emit({
              ...alarmEntity(current),
              type: 'terminal',
              timestamp: Date.now(),
              attempt: current.attempt,
              reason: 'attempts_exhausted',
              error: exhausted,
            });
          }
        }
        return;
      }

      const attempt = claimed.attempt;
      const startedAt = Date.now();
      const entity = alarmEntity(row);
      emit({
        ...entity,
        type: 'attempt_started',
        timestamp: startedAt,
        attempt,
      });
      const controller = new AbortController();
      activeExecution.controller = controller;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const handler = alarmHandlers.get(row.name);
        if (!handler) {
          throw new NonRetryableError(
            `No named alarm handler registered for "${row.name}"`
          );
        }

        handlerStarted = true;
        const handlerResult = Promise.resolve().then(() =>
          handler({
            name: row.name,
            scheduledTime: row.scheduled_at,
            attempt,
            isRetry: attempt > 1,
            retryCount: attempt - 1,
            idempotencyKey: `durability-alarm:v1:${row.generation_id}`,
            signal: controller.signal,
            platform,
          })
        );
        void handlerResult
          .finally(() => {
            handlerSettled = true;
            releaseIfSettled();
          })
          .catch(() => undefined);
        const timeoutResult = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new DurableAlarmTimeoutError(
              row.name,
              policy.attemptTimeoutMs
            );
            controller.abort(error);
            reject(error);
          }, policy.attemptTimeoutMs);
        });
        await Promise.race([handlerResult, timeoutResult]);
        const timestamp = Date.now();
        const deleted =
          context.storage.sql
            .exec(
              `DELETE FROM durability_alarms
               WHERE name = ? AND generation_id = ? AND status = 'pending'
                 AND attempt = ?
               RETURNING name`,
              row.name,
              row.generation_id,
              attempt
            )
            .toArray().length > 0;
        if (deleted) {
          emit({
            ...entity,
            type: 'attempt_settled',
            timestamp,
            attempt,
            durationMs: Math.max(0, timestamp - startedAt),
            outcome: 'completed',
          });
        }
      } catch (caught) {
        let error = caught;
        let terminal =
          isNonRetryable(error) ||
          attempt >= policy.maxAttempts ||
          (isErrorInstance(error, DurableAlarmTimeoutError) &&
            !policy.retryTimeouts);
        let timestamp = Date.now();
        let delay = 0;
        if (!terminal) {
          try {
            const rawDelay = policy.delay(attempt);
            if (!Number.isFinite(rawDelay) || rawDelay < 0) {
              throw new DurableRetryPolicyError(`named alarm "${row.name}"`);
            }
            delay = Math.round(rawDelay);
            timestamp = Date.now();
            if (
              !Number.isSafeInteger(delay) ||
              !Number.isSafeInteger(timestamp + delay)
            ) {
              throw new DurableRetryPolicyError(`named alarm "${row.name}"`);
            }
          } catch (policyError) {
            error = isErrorInstance(policyError, DurableRetryPolicyError)
              ? policyError
              : new DurableRetryPolicyError(
                  `named alarm "${row.name}"`,
                  policyError
                );
            delay = 0;
            terminal = true;
          }
        }
        const nextAttemptAt = timestamp + delay;
        const serializedError = serializeError(error);
        let updated = false;
        await context.storage.transaction(async (transaction) => {
          updated =
            context.storage.sql
              .exec(
                `UPDATE durability_alarms
                 SET status = ?, next_attempt_at = ?, last_error = ?,
                     last_error_name = ?
                 WHERE name = ? AND generation_id = ? AND status = 'pending'
                   AND attempt = ?
                 RETURNING name`,
                terminal ? 'failed' : 'pending',
                nextAttemptAt,
                serializedError.message,
                serializedError.name,
                row.name,
                row.generation_id,
                attempt
              )
              .toArray().length > 0;
          await reconcileAlarm(transaction);
        });
        if (updated) {
          emit(
            terminal
              ? {
                  ...entity,
                  type: 'attempt_settled',
                  timestamp,
                  attempt,
                  durationMs: Math.max(0, timestamp - startedAt),
                  outcome: 'failed',
                  error: serializedError,
                }
              : {
                  ...entity,
                  type: 'attempt_settled',
                  timestamp,
                  attempt,
                  durationMs: Math.max(0, timestamp - startedAt),
                  outcome: 'retry_scheduled',
                  error: serializedError,
                  nextAttemptAt,
                }
          );
        }
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    })().finally(() => {
      policySettled = true;
      releaseIfSettled();
    });

    void settled.finally(() => {
      if (activeAlarms.get(row.name) === activeExecution) {
        activeAlarms.delete(row.name);
      }
    });
    return execution;
  };

  const execute = (
    id: string,
    permitMode: 'wait' | 'immediate' = 'wait'
  ): Promise<void> | undefined => {
    const call = getCall(id);
    if (!call || call.status !== 'pending') {
      return permitMode === 'wait' ? Promise.resolve() : undefined;
    }
    const running = active.get(id);
    if (running?.generation === call.generation_id) {
      return permitMode === 'wait' ? running.settled : undefined;
    }

    let releasePermit: (() => void) | undefined;
    if (permitMode === 'immediate') {
      releasePermit = tryAcquirePermit();
      if (!releasePermit) {
        return undefined;
      }
    }

    const policy = executionPolicy(call.operation);
    let settleActive: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settleActive = resolve;
    });
    const activeExecution: ActiveExecution = {
      generation: call.generation_id,
      createdAt: call.created_at,
      settled,
    };
    active.set(id, activeExecution);
    let handlerStarted = false;
    let handlerSettled = false;
    let policySettled = false;
    const releaseIfSettled = (): void => {
      if (policySettled && (!handlerStarted || handlerSettled)) {
        releasePermit?.();
        settleActive?.();
      }
    };

    const execution = (async (): Promise<void> => {
      releasePermit ??= await acquirePermit();
      const claimed = callAttemptSchema.optional().parse(
        context.storage.sql
          .exec<Pick<CallRow, 'attempt'>>(
            `UPDATE durability_calls
             SET attempt = attempt + 1
             WHERE id = ? AND generation_id = ? AND status = 'pending'
               AND attempt < ?
             RETURNING attempt`,
            id,
            call.generation_id,
            policy.maxAttempts
          )
          .toArray()[0]
      );
      if (!claimed) {
        const current = getCall(id);
        if (
          current?.generation_id === call.generation_id &&
          current.status === 'pending' &&
          current.attempt >= policy.maxAttempts
        ) {
          const exhausted = serializeError(
            new DurableAttemptsExhaustedError(
              'operation',
              call.operation,
              policy.maxAttempts
            )
          );
          let updated = false;
          await context.storage.transaction(async (transaction) => {
            updated =
              context.storage.sql
                .exec(
                  `UPDATE durability_calls
                   SET status = 'failed', last_error = ?, last_error_name = ?
                   WHERE id = ? AND generation_id = ? AND status = 'pending'
                     AND attempt >= ?
                   RETURNING id`,
                  exhausted.message,
                  exhausted.name,
                  id,
                  call.generation_id,
                  policy.maxAttempts
                )
                .toArray().length > 0;
            await reconcileAlarm(transaction);
          });
          if (updated) {
            emit({
              ...operationEntity(current),
              type: 'terminal',
              timestamp: Date.now(),
              attempt: current.attempt,
              reason: 'attempts_exhausted',
              error: exhausted,
            });
          }
        }
        return;
      }

      const attempt = claimed.attempt;
      const startedAt = Date.now();
      const entity = operationEntity(call);
      emit({
        ...entity,
        type: 'attempt_started',
        timestamp: startedAt,
        attempt,
      });
      const controller = new AbortController();
      activeExecution.controller = controller;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const handler = handlers[call.operation] as
          | ((durableCall: DurableCall<unknown>) => unknown)
          | undefined;
        if (!handler) {
          throw new NonRetryableError(
            `No handler registered for operation "${call.operation}"`
          );
        }

        handlerStarted = true;
        const handlerResult = Promise.resolve().then(() =>
          handler({
            id,
            operation: call.operation,
            payload: deserialize(call.payload),
            attempt,
            signal: controller.signal,
          })
        );
        void handlerResult
          .finally(() => {
            handlerSettled = true;
            releaseIfSettled();
          })
          .catch(() => undefined);
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
        let serialized: string;
        try {
          serialized = serialize(result);
        } catch (error) {
          throw new DurableResultSerializationError(call.operation, error);
        }
        const timestamp = Date.now();
        const updated =
          context.storage.sql
            .exec(
              `UPDATE durability_calls
               SET status = 'completed', result = ?, last_error = NULL,
                   last_error_name = NULL, completed_at = ?
               WHERE id = ? AND generation_id = ? AND status = 'pending'
                 AND attempt = ?
               RETURNING id`,
              serialized,
              timestamp,
              id,
              call.generation_id,
              attempt
            )
            .toArray().length > 0;
        if (updated) {
          emit({
            ...entity,
            type: 'attempt_settled',
            timestamp,
            attempt,
            durationMs: Math.max(0, timestamp - startedAt),
            outcome: 'completed',
          });
        }
      } catch (caught) {
        let error = caught;
        let terminal =
          isNonRetryable(error) ||
          isErrorInstance(error, DurableResultSerializationError) ||
          attempt >= policy.maxAttempts ||
          (isErrorInstance(error, DurableAttemptTimeoutError) &&
            !policy.retryTimeouts);
        let timestamp = Date.now();
        let delay = 0;
        if (!terminal) {
          try {
            const rawDelay = policy.delay(attempt);
            if (!Number.isFinite(rawDelay) || rawDelay < 0) {
              throw new DurableRetryPolicyError(
                `operation "${call.operation}"`
              );
            }
            delay = Math.round(rawDelay);
            timestamp = Date.now();
            if (
              !Number.isSafeInteger(delay) ||
              !Number.isSafeInteger(timestamp + delay)
            ) {
              throw new DurableRetryPolicyError(
                `operation "${call.operation}"`
              );
            }
          } catch (policyError) {
            error = isErrorInstance(policyError, DurableRetryPolicyError)
              ? policyError
              : new DurableRetryPolicyError(
                  `operation "${call.operation}"`,
                  policyError
                );
            delay = 0;
            terminal = true;
          }
        }
        const nextAttemptAt = timestamp + delay;
        const serializedError = serializeError(error);
        let updated = false;
        await context.storage.transaction(async (transaction) => {
          updated =
            context.storage.sql
              .exec(
                `UPDATE durability_calls
                 SET status = ?, next_attempt_at = ?, last_error = ?,
                     last_error_name = ?
                 WHERE id = ? AND generation_id = ? AND status = 'pending'
                   AND attempt = ?
                 RETURNING id`,
                terminal ? 'failed' : 'pending',
                nextAttemptAt,
                serializedError.message,
                serializedError.name,
                id,
                call.generation_id,
                attempt
              )
              .toArray().length > 0;
          await reconcileAlarm(transaction);
        });
        if (updated) {
          emit(
            terminal
              ? {
                  ...entity,
                  type: 'attempt_settled',
                  timestamp,
                  attempt,
                  durationMs: Math.max(0, timestamp - startedAt),
                  outcome: 'failed',
                  error: serializedError,
                }
              : {
                  ...entity,
                  type: 'attempt_settled',
                  timestamp,
                  attempt,
                  durationMs: Math.max(0, timestamp - startedAt),
                  outcome: 'retry_scheduled',
                  error: serializedError,
                  nextAttemptAt,
                }
          );
        }
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    })().finally(() => {
      policySettled = true;
      releaseIfSettled();
    });

    void settled.finally(() => {
      if (active.get(id) === activeExecution) {
        active.delete(id);
      }
    });
    return execution;
  };

  const run = async (input: {
    id: string;
    operation: string;
    payload: unknown;
  }): Promise<void> => {
    const payload = serialize(input.payload);
    const now = Date.now();
    const generation = crypto.randomUUID();
    let inserted = false;
    let winner: CallRow | undefined;
    await context.storage.transaction(async (transaction) => {
      inserted =
        context.storage.sql
          .exec(
            `INSERT INTO durability_calls
              (id, operation, payload, status, attempt, next_attempt_at,
               generation_id, created_at)
             VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING
             RETURNING id`,
            input.id,
            input.operation,
            payload,
            now,
            generation,
            now
          )
          .toArray().length > 0;
      winner = getCall(input.id);
      if (!winner) {
        throw new Error(`Durable call "${input.id}" was not persisted`);
      }
      assertOperation(input.id, winner.operation, input.operation);
      await reconcileAlarm(transaction);
    });

    if (inserted && winner) {
      emit({
        ...operationEntity(winner),
        type: 'registered',
        timestamp: now,
        attempt: 0,
      });
    }
    if (inserted && winner?.status === 'pending') {
      const eagerExecution = execute(input.id, 'immediate');
      if (!eagerExecution) {
        return;
      }
      const background = eagerExecution
        .then(scheduleNextAlarm)
        .catch((error: unknown) => {
          reportFailure(
            'durability.background_execution.failed',
            { operation: input.operation, id: input.id },
            error
          );
        });
      if (context.waitUntil) {
        try {
          context.waitUntil(background);
        } catch (error) {
          reportFailure(
            'durability.background_execution.failed',
            { operation: input.operation, id: input.id },
            error
          );
        }
      }
      void background;
    }
  };

  const purgeBefore = async (before: number): Promise<DurablePurgeResult> => {
    if (!Number.isSafeInteger(before) || before < 0) {
      throw new RangeError('timestamp must be a non-negative safe integer');
    }

    let operations = 0;
    let namedAlarms = 0;
    await context.storage.transaction(async (transaction) => {
      operations = countSchema.parse(
        context.storage.sql
          .exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM durability_calls WHERE created_at < ?',
            before
          )
          .toArray()[0]
      ).count;
      namedAlarms = countSchema.parse(
        context.storage.sql
          .exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM durability_alarms WHERE created_at < ?',
            before
          )
          .toArray()[0]
      ).count;
      for (const running of active.values()) {
        if (running.createdAt < before) {
          running.controller?.abort(new Error('Durable operation was purged'));
        }
      }
      for (const running of activeAlarms.values()) {
        if (running.createdAt < before) {
          running.controller?.abort(new Error('Durable alarm was purged'));
        }
      }
      context.storage.sql.exec(
        'DELETE FROM durability_calls WHERE created_at < ?',
        before
      );
      context.storage.sql.exec(
        'DELETE FROM durability_alarms WHERE created_at < ?',
        before
      );
      await reconcileAlarm(transaction);
    });
    const result = {
      operations,
      namedAlarms,
      total: operations + namedAlarms,
    };
    emit({
      type: 'purged',
      entityKind: 'durability',
      timestamp: Date.now(),
      before,
      ...result,
    });
    return result;
  };

  const alarm = async (alarmInfo?: AlarmInvocationInfo): Promise<void> => {
    const startedAt = Date.now();
    const due = listDueIds(startedAt, 100);
    const dueAlarms = listDueAlarms(startedAt, 100);
    if (due.length === 0 && dueAlarms.length === 0) {
      await scheduleNextAlarm();
      return;
    }

    const operationExecution = runConcurrent(
      due,
      alarmConcurrency,
      async (id) => {
        try {
          await execute(id);
        } catch {
          return;
        }
      }
    );
    const namedAlarmFailures: unknown[] = [];
    const namedAlarmExecution = runConcurrent(
      dueAlarms,
      alarmConcurrency,
      async (row) => {
        try {
          await executeNamedAlarm(row, alarmInfo);
        } catch (error) {
          namedAlarmFailures.push(error);
        }
      }
    ).then(() => {
      if (namedAlarmFailures.length > 0) {
        throw namedAlarmFailures[0];
      }
      return undefined;
    });
    const execution = Promise.all([
      operationExecution,
      namedAlarmExecution,
    ]).then(() => undefined);
    void execution.catch(() => undefined);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const handoff = Symbol('alarm handoff');
    const remaining = alarmHandoffMs - (Date.now() - startedAt);
    let result: void | typeof handoff;
    try {
      result = await Promise.race([
        execution,
        new Promise<typeof handoff>((resolve) => {
          timeout = setTimeout(() => resolve(handoff), Math.max(remaining, 0));
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }

    if (result === handoff) {
      await armForHandoff(Date.now());
      return;
    }
    await scheduleNextAlarm();
  };

  for (const name of alarmHandlers.keys()) {
    if (name in alarm) {
      throw new Error(`"${name}" is reserved by durability alarms`);
    }
    Object.assign(alarm, {
      [name]: (scheduledTime: number) =>
        scheduleNamedAlarm(name, scheduledTime),
    });
  }

  const durability: Record<string, unknown> = { alarm, purgeBefore };
  for (const operation of Object.keys(handlers) as (keyof Handlers &
    string)[]) {
    if (operation === 'alarm' || operation === 'purgeBefore') {
      throw new Error(`"${operation}" is reserved by durability`);
    }

    const durableOperation = (input: { id: string; payload: unknown }) =>
      run({ ...input, operation });
    durableOperation.getResult = async (idempotencyKey: string) =>
      getResult(operation, idempotencyKey);
    durability[operation] = durableOperation;
  }

  const isCompleteDurability = (
    value: Record<string, unknown>
  ): value is Record<string, unknown> & Durability<Handlers, AlarmNames> => {
    const alarmValue = value['alarm'];
    if (
      typeof alarmValue !== 'function' ||
      typeof value['purgeBefore'] !== 'function'
    ) {
      return false;
    }
    for (const name of alarmHandlers.keys()) {
      if (typeof Reflect.get(alarmValue, name) !== 'function') {
        return false;
      }
    }
    for (const operation of Object.keys(handlers)) {
      const method = value[operation];
      if (
        typeof method !== 'function' ||
        typeof Reflect.get(method, 'getResult') !== 'function'
      ) {
        return false;
      }
    }
    return true;
  };

  if (!isCompleteDurability(durability)) {
    throw new Error('Durability methods were not initialized');
  }
  return durability;
};
