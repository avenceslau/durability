import type { DurableMigrations } from '@durability/storage';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { DOQB, type Migration } from 'workers-qb';
import { exponential, jitter } from './utils.js';

/** Persisted metadata and cancellation signal passed to an operation attempt. */
export type DurableCall<Payload> = {
  id: string;
  operation: string;
  payload: Payload;
  attempt: number;
  operationVersion: string;
  payloadVersion: string;
  signal: AbortSignal;
};

/** Executes one attempt of a durable operation. */
export type DurableHandler<Payload, Result> = (
  call: DurableCall<Payload>
) => Result | Promise<Result>;

/** Retry limit and delay policy for operation attempts. */
export type DurabilityRetryOptions = {
  delay?: (attempt: number) => number;
  maxAttempts?: number;
};

type HandlerMap = Record<string, (...args: never[]) => unknown>;

/** Persisted metadata and platform context passed to a named alarm attempt. */
export type DurableAlarmInfo = {
  name: string;
  scheduledTime: number;
  attempt: number;
  isRetry: boolean;
  retryCount: number;
  idempotencyKey: string;
  handlerVersion: string;
  signal: AbortSignal;
  platform: AlarmInvocationInfo | undefined;
};

/** Executes one attempt of a named alarm occurrence. */
export type DurableAlarmHandler = (
  info: DurableAlarmInfo
) => unknown | Promise<unknown>;

/** Validation, execution, and compatibility policy for one operation handler. */
export type DurabilityMethodOptions<Payload, Result> = {
  payloadSchema: StandardSchemaV1<Payload, Payload>;
  resultSchema: StandardSchemaV1<Result, Result>;
  attemptTimeoutMs?: number;
  retries?: DurabilityRetryOptions;
  retryTimeouts?: boolean;
  operationVersion?: string;
  payloadVersion?: string;
  acceptedOperationVersions?: readonly string[];
  acceptedPayloadVersions?: readonly string[];
};

/** Execution and compatibility policy for one named alarm handler. */
export type DurabilityAlarmMethodOptions = {
  attemptTimeoutMs?: number;
  retries?: DurabilityRetryOptions;
  retryTimeouts?: boolean;
  handlerVersion?: string;
  acceptedHandlerVersions?: readonly string[];
};

type SerializedError = { name: string; message: string };

type OperationLifecycleEntity = {
  entityKind: 'operation';
  operation: string;
  id: string;
  generation: string;
  operationVersion: string;
  payloadVersion: string;
};

type AlarmLifecycleEntity = {
  entityKind: 'named_alarm';
  alarm: string;
  id: string;
  generation: string;
  handlerVersion: string;
};

type LifecycleEntity = OperationLifecycleEntity | AlarmLifecycleEntity;

/** Best-effort metrics signal emitted as queue entities change lifecycle state. */
export type DurabilityLifecycleEvent =
  | (OperationLifecycleEntity & {
      type: 'registered';
      timestamp: number;
    })
  | (AlarmLifecycleEntity & {
      type: 'scheduled';
      timestamp: number;
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
      reason: 'version_mismatch' | 'attempts_exhausted';
      error: SerializedError;
    })
  | (LifecycleEntity & {
      type: 'cancelled' | 'retried' | 'deleted';
      timestamp: number;
      attempt: number;
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

type HandlerPayload<Handler> = Handler extends (
  call: DurableCall<infer Payload>
) => unknown
  ? Payload
  : never;

type HandlerResult<Handler> = Handler extends (...args: never[]) => infer Result
  ? Awaited<Result>
  : never;

type DurabilityBaseOptions<AlarmNames extends string> = {
  alarms?: Record<AlarmNames, DurableAlarmHandler>;
  alarmMethods?: [AlarmNames] extends [never]
    ? never
    : Partial<Record<NoInfer<AlarmNames>, DurabilityAlarmMethodOptions>>;
  alarmConcurrency?: number;
  alarmHandoffMs?: number;
  attemptTimeoutMs?: number;
  retries?: DurabilityRetryOptions;
  onLifecycleEvent?: (event: DurabilityLifecycleEvent) => void | Promise<void>;
};

type DurabilityMethods<Handlers extends HandlerMap> = {
  [Operation in Extract<keyof Handlers, string>]: DurabilityMethodOptions<
    HandlerPayload<Handlers[Operation]>,
    HandlerResult<Handlers[Operation]>
  >;
};

/** Queue-wide handlers, validation, execution policy, and lifecycle hooks. */
export type DurabilityOptions<
  Handlers extends HandlerMap = HandlerMap,
  AlarmNames extends string = never,
> = DurabilityBaseOptions<AlarmNames> &
  ([Extract<keyof Handlers, string>] extends [never]
    ? { methods?: never }
    : { methods: DurabilityMethods<Handlers> });

type DurableOperationInput<Handler> = {
  id: string;
  payload: HandlerPayload<Handler>;
  operationVersion?: string;
  payloadVersion?: string;
};

type ResultVersions = {
  operationVersion: string;
  payloadVersion: string;
};

/** Persisted state returned by an operation's `getResult` method. */
export type DurableOperationResult<Result> =
  | { status: 'not_found' }
  | (ResultVersions & {
      status: 'pending';
      attempt: number;
      nextAttemptAt: number;
      lastError: string | null;
    })
  | (ResultVersions & {
      status: 'failed' | 'cancelled';
      attempt: number;
      error: SerializedError;
    })
  | (ResultVersions & {
      status: 'completed';
      result: Result;
    });

/** Result of an administrative cancel, retry, or delete request. */
export type DurableMutationResult =
  | { status: 'not_found' }
  | { status: 'unchanged' }
  | { status: 'updated' }
  | { status: 'deleted' };

/** Counts of records physically removed by `purgeBefore`. */
export type DurablePurgeResult = {
  operations: number;
  namedAlarms: number;
  total: number;
};

type DurableOperation<Handler> = ((
  input: DurableOperationInput<Handler>
) => Promise<void>) & {
  getResult: (
    idempotencyKey: string
  ) => Promise<DurableOperationResult<HandlerResult<Handler>>>;
  cancel: (idempotencyKey: string) => Promise<DurableMutationResult>;
  retry: (idempotencyKey: string) => Promise<DurableMutationResult>;
  delete: (idempotencyKey: string) => Promise<DurableMutationResult>;
};

type DurableNamedAlarm = ((scheduledTime: number) => Promise<void>) & {
  cancel: () => Promise<DurableMutationResult>;
  retry: () => Promise<DurableMutationResult>;
  delete: () => Promise<DurableMutationResult>;
};

type DurabilityAlarm<AlarmNames extends string> = ((
  alarmInfo?: AlarmInvocationInfo
) => Promise<void>) &
  Record<AlarmNames, DurableNamedAlarm>;

/** Typed operation methods, named alarms, alarm runner, and purge API. */
export type Durability<
  Handlers extends HandlerMap,
  AlarmNames extends string = never,
> = {
  alarm: DurabilityAlarm<AlarmNames>;
  purgeBefore: (timestamp: number) => Promise<DurablePurgeResult>;
} & {
  [Operation in keyof Handlers]: DurableOperation<Handlers[Operation]>;
};

const persistedIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const callRowSchema = z.object({
  id: z.string(),
  operation: z.string(),
  payload: z.string(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  result: z.string().nullable(),
  attempt: persistedIntegerSchema,
  next_attempt_at: persistedIntegerSchema,
  last_error: z.string().nullable(),
  last_error_name: z.string().nullable(),
  completed_at: persistedIntegerSchema.nullable(),
  created_at: persistedIntegerSchema,
  generation_id: z.string(),
  operation_version: z.string(),
  payload_version: z.string(),
});
type CallRow = z.infer<typeof callRowSchema>;

const alarmRowSchema = z.object({
  name: z.string(),
  generation_id: z.string(),
  status: z.enum(['pending', 'failed', 'cancelled']),
  scheduled_at: persistedIntegerSchema,
  next_attempt_at: persistedIntegerSchema,
  attempt: persistedIntegerSchema,
  last_error: z.string().nullable(),
  last_error_name: z.string().nullable(),
  created_at: persistedIntegerSchema,
  handler_version: z.string(),
});
type AlarmRow = z.infer<typeof alarmRowSchema>;

const callAttemptSchema = callRowSchema.pick({ attempt: true });
const callGenerationSchema = callRowSchema.pick({ generation_id: true });
const alarmAttemptSchema = alarmRowSchema.pick({ attempt: true });
const alarmGenerationSchema = alarmRowSchema.pick({ generation_id: true });
const nextAttemptSchema = z.object({ next_attempt_at: persistedIntegerSchema });
const idSchema = z.object({ id: z.string() });
const nameSchema = z.object({ name: z.string() });
const countSchema = z.object({ count: persistedIntegerSchema });

const retryOptionsSchema = z.object({
  delay: z
    .custom<NonNullable<DurabilityRetryOptions['delay']>>(
      (value) => typeof value === 'function'
    )
    .optional(),
  maxAttempts: z.number().optional(),
});
const standardSchemaSchema = z.custom<StandardSchemaV1>((value) => {
  if ((typeof value !== 'object' && typeof value !== 'function') || !value) {
    return false;
  }
  try {
    const standard = Reflect.get(value, '~standard');
    return (
      typeof standard === 'object' &&
      standard !== null &&
      Reflect.get(standard, 'version') === 1 &&
      typeof Reflect.get(standard, 'validate') === 'function'
    );
  } catch {
    return false;
  }
}, 'Expected a Standard Schema V1 validator');
const durabilityMethodOptionsSchema = z.object({
  payloadSchema: standardSchemaSchema,
  resultSchema: standardSchemaSchema,
  attemptTimeoutMs: z.number().optional(),
  retries: retryOptionsSchema.optional(),
  retryTimeouts: z.boolean().optional(),
  operationVersion: z.string().optional(),
  payloadVersion: z.string().optional(),
  acceptedOperationVersions: z.array(z.string()).readonly().optional(),
  acceptedPayloadVersions: z.array(z.string()).readonly().optional(),
});
const durabilityAlarmMethodOptionsSchema = z.object({
  attemptTimeoutMs: z.number().optional(),
  retries: retryOptionsSchema.optional(),
  retryTimeouts: z.boolean().optional(),
  handlerVersion: z.string().optional(),
  acceptedHandlerVersions: z.array(z.string()).readonly().optional(),
});
const operationHandlerSchema = z.custom<DurableHandler<unknown, unknown>>(
  (value) => typeof value === 'function'
);
const alarmHandlerSchema = z.custom<DurableAlarmHandler>(
  (value) => typeof value === 'function'
);

type ActiveExecution = {
  generation: string;
  createdAt: number;
  settled: Promise<void>;
  controller?: AbortController;
};

const tableName = 'durability_calls';
const alarmTableName = 'durability_alarms';
const migrationTableName = 'durability_migrations';
const storedValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.json() }),
  z.object({ kind: z.literal('undefined') }),
]);

/** Ordered reversible migrations for durability-owned SQLite tables. */
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
    name: 'durability_0004_harden_queue',
    up: `
      DROP INDEX IF EXISTS durability_calls_pending_idx;
      ALTER TABLE durability_calls RENAME TO durability_calls_v3;
      CREATE TABLE durability_calls (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
        result TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        last_error_name TEXT,
        completed_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
        generation_id TEXT NOT NULL DEFAULT 'legacy',
        operation_version TEXT NOT NULL DEFAULT '1',
        payload_version TEXT NOT NULL DEFAULT '1'
      );
      INSERT INTO durability_calls (
        id, operation, payload, status, result, attempt, next_attempt_at,
        last_error, last_error_name, completed_at, created_at, generation_id,
        operation_version, payload_version
      )
      SELECT id, operation, payload, status, result, attempt, next_attempt_at,
        last_error, last_error_name, completed_at,
        CAST(unixepoch('subsec') * 1000 AS INTEGER),
        'legacy:' || id, '1', '1'
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
        status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'cancelled')),
        scheduled_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_name TEXT,
        created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
        handler_version TEXT NOT NULL DEFAULT '1'
      );
      INSERT INTO durability_alarms (
        name, generation_id, status, scheduled_at, next_attempt_at, attempt,
        last_error, last_error_name, created_at, handler_version
      )
      SELECT name, generation_id, status, scheduled_at, next_attempt_at, attempt,
        last_error, last_error_name,
        CAST(unixepoch('subsec') * 1000 AS INTEGER), '1'
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
      SELECT id, operation, payload,
        CASE status WHEN 'cancelled' THEN 'failed' ELSE status END,
        result, attempt, next_attempt_at, last_error, last_error_name, completed_at
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
      SELECT name, generation_id,
        CASE status WHEN 'cancelled' THEN 'failed' ELSE status END,
        scheduled_at, next_attempt_at, attempt, last_error, last_error_name
      FROM durability_alarms_v4;
      DROP TABLE durability_alarms_v4;
      CREATE INDEX durability_alarms_pending_idx
      ON durability_alarms (status, next_attempt_at);
    `,
  },
] satisfies DurableMigrations;

/** Migration names applied or rolled back by `migrateDurability`. */
export type DurabilityMigrationResult = {
  applied: string[];
  rolledBack: string[];
};

/** Migrates durability-owned schema to the latest or supplied target. */
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
  const migrations: Migration[] = durabilityMigrations.map(({ name, up }) => ({
    name,
    sql: up,
  }));
  const builder = qb.migrations({
    migrations,
    tableName: migrationTableName,
  });
  const appliedNames = new Set(
    builder.getApplied().map((migration) => migration.name)
  );
  const rolledBack: string[] = [];

  for (
    let index = durabilityMigrations.length - 1;
    index > targetIndex;
    index -= 1
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
      migrations: migrations.slice(0, targetIndex + 1),
      tableName: migrationTableName,
    })
    .apply()
    .map((migration) => migration.name);

  if (target === null) {
    context.storage.sql.exec(`DROP TABLE IF EXISTS ${migrationTableName}`);
  }

  return { applied, rolledBack };
};

/** Marks a handler failure as terminal. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** Persisted when an operation attempt exceeds its timeout. */
export class DurableAttemptTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Durable operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'DurableAttemptTimeoutError';
  }
}

/** Persisted when a named alarm attempt exceeds its timeout. */
export class DurableAlarmTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Durable alarm "${name}" timed out after ${timeoutMs}ms`);
    this.name = 'DurableAlarmTimeoutError';
  }
}

/** Persisted when retry-delay evaluation throws or returns an invalid delay. */
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

/** Thrown or persisted when an operation payload fails its configured schema. */
export class DurablePayloadValidationError extends Error {
  readonly issues: readonly string[];

  constructor(operation: string, issues: readonly string[]) {
    const summary = issues.length > 0 ? issues.join('; ') : 'Invalid value';
    super(
      `Payload for durable operation "${operation}" is invalid: ${summary}`
    );
    this.name = 'DurablePayloadValidationError';
    this.issues = issues;
  }
}

/** Thrown or persisted when an operation result fails its configured schema. */
export class DurableResultValidationError extends Error {
  readonly issues: readonly string[];

  constructor(operation: string, issues: readonly string[]) {
    const summary = issues.length > 0 ? issues.join('; ') : 'Invalid value';
    super(`Result for durable operation "${operation}" is invalid: ${summary}`);
    this.name = 'DurableResultValidationError';
    this.issues = issues;
  }
}

/** Persisted when a successful operation result cannot be serialized. */
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

/** Persisted when a handler does not accept a record's stored version. */
export class DurableVersionMismatchError extends Error {
  constructor(
    entity: 'operation' | 'named alarm',
    name: string,
    versionKind: string,
    persistedVersion: string
  ) {
    super(
      `Durable ${entity} "${name}" does not accept persisted ${versionKind} version "${persistedVersion}"`
    );
    this.name = 'DurableVersionMismatchError';
  }
}

/** Persisted when a pending record has already reached its attempt limit. */
export class DurableAttemptsExhaustedError extends Error {
  constructor(entity: 'operation' | 'named alarm', name: string, max: number) {
    super(`Durable ${entity} "${name}" exhausted its ${max} attempts`);
    this.name = 'DurableAttemptsExhaustedError';
  }
}

/** Persisted when pending work is administratively cancelled. */
export class DurableCancellationError extends Error {
  constructor(entity: 'operation' | 'named alarm', name: string) {
    super(`Durable ${entity} "${name}" was cancelled`);
    this.name = 'DurableCancellationError';
  }
}

/** Thrown when an ID already belongs to a different operation. */
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

/** Creates a SQLite-backed operation queue for one Durable Object instance. */
export const createDurability = <
  Handlers extends HandlerMap,
  const AlarmNames extends string = never,
>(
  context: Pick<DurableObjectState, 'storage'> &
    Partial<Pick<DurableObjectState, 'waitUntil'>>,
  handlers: Handlers,
  ...optionsInput: [Extract<keyof Handlers, string>] extends [never]
    ? [options?: DurabilityOptions<NoInfer<Handlers>, AlarmNames>]
    : [options: DurabilityOptions<NoInfer<Handlers>, AlarmNames>]
): Durability<Handlers, AlarmNames> => {
  const options: DurabilityBaseOptions<AlarmNames> & {
    methods?: Record<string, DurabilityMethodOptions<unknown, unknown>>;
  } = optionsInput[0] ?? {};
  migrateDurability(context);
  const qb = new DOQB(context.storage.sql);
  const active = new Map<string, ActiveExecution>();
  const activeAlarms = new Map<string, ActiveExecution>();
  const operationHandlers = new Map<string, DurableHandler<unknown, unknown>>();
  for (const [operation, handler] of Object.entries(handlers)) {
    operationHandlers.set(operation, operationHandlerSchema.parse(handler));
  }
  const alarmHandlers = new Map<string, DurableAlarmHandler>();
  for (const [name, handler] of Object.entries(options.alarms ?? {})) {
    alarmHandlers.set(name, alarmHandlerSchema.parse(handler));
  }

  const alarmConcurrency = options.alarmConcurrency ?? 10;
  const alarmHandoffMs = options.alarmHandoffMs ?? 14 * 60_000;
  const defaultAttemptTimeoutMs = options.attemptTimeoutMs ?? 5 * 60_000;
  const globalRetries = retryOptionsSchema.parse(options.retries ?? {});
  const defaultRetryDelay =
    globalRetries.delay ?? ((attempt: number) => jitter(exponential(attempt)));
  const defaultMaxAttempts = globalRetries.maxAttempts ?? 5;
  if (!Number.isInteger(alarmConcurrency) || alarmConcurrency < 1) {
    throw new RangeError('alarmConcurrency must be a positive integer');
  }
  if (!Number.isSafeInteger(alarmHandoffMs) || alarmHandoffMs < 0) {
    throw new RangeError('alarmHandoffMs must be a non-negative safe integer');
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

  const validateVersion = (value: string, path: string): void => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new RangeError(`${path} must be a non-empty string`);
    }
  };

  const validateVersions = (
    current: string,
    accepted: readonly string[],
    path: string
  ): Set<string> => {
    const versions = [current, ...accepted];
    for (const version of versions) {
      validateVersion(version, path);
    }
    if (new Set(versions).size !== versions.length) {
      throw new RangeError(`${path} must contain unique versions`);
    }
    return new Set(versions);
  };

  const methodOptions = new Map(
    Object.entries(options.methods ?? {}).map(([operation, method]) => [
      operation,
      durabilityMethodOptionsSchema.parse(method),
    ])
  );
  const operationPolicies = new Map<
    string,
    {
      payloadSchema: StandardSchemaV1;
      resultSchema: StandardSchemaV1;
      attemptTimeoutMs: number;
      delay: (attempt: number) => number;
      maxAttempts: number;
      retryTimeouts: boolean;
      operationVersion: string;
      payloadVersion: string;
      acceptedOperationVersions: Set<string>;
      acceptedPayloadVersions: Set<string>;
    }
  >();
  for (const operation of operationHandlers.keys()) {
    const method = methodOptions.get(operation);
    const attemptTimeoutMs =
      method?.attemptTimeoutMs ?? defaultAttemptTimeoutMs;
    const maxAttempts = method?.retries?.maxAttempts ?? defaultMaxAttempts;
    if (!Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 1) {
      throw new RangeError(
        `methods.${operation}.attemptTimeoutMs must be a positive integer`
      );
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError(
        `methods.${operation}.retries.maxAttempts must be a positive integer`
      );
    }
    if (!method) {
      throw new Error(`Missing methods.${operation} configuration`);
    }
    const operationVersion = method.operationVersion ?? '1';
    const payloadVersion = method.payloadVersion ?? '1';
    operationPolicies.set(operation, {
      payloadSchema: method.payloadSchema,
      resultSchema: method.resultSchema,
      attemptTimeoutMs,
      delay: method?.retries?.delay ?? defaultRetryDelay,
      maxAttempts,
      retryTimeouts: method?.retryTimeouts ?? false,
      operationVersion,
      payloadVersion,
      acceptedOperationVersions: validateVersions(
        operationVersion,
        method?.acceptedOperationVersions ?? [],
        `methods.${operation}.acceptedOperationVersions`
      ),
      acceptedPayloadVersions: validateVersions(
        payloadVersion,
        method?.acceptedPayloadVersions ?? [],
        `methods.${operation}.acceptedPayloadVersions`
      ),
    });
  }

  const alarmMethodOptions = new Map(
    Object.entries(options.alarmMethods ?? {}).map(([name, method]) => [
      name,
      durabilityAlarmMethodOptionsSchema.parse(method),
    ])
  );
  const alarmPolicies = new Map<
    string,
    {
      attemptTimeoutMs: number;
      delay: (attempt: number) => number;
      maxAttempts: number;
      retryTimeouts: boolean;
      handlerVersion: string;
      acceptedHandlerVersions: Set<string>;
    }
  >();
  for (const name of alarmHandlers.keys()) {
    const method = alarmMethodOptions.get(name);
    const attemptTimeoutMs =
      method?.attemptTimeoutMs ?? defaultAttemptTimeoutMs;
    const maxAttempts = method?.retries?.maxAttempts ?? defaultMaxAttempts;
    if (!Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 1) {
      throw new RangeError(
        `alarmMethods.${name}.attemptTimeoutMs must be a positive integer`
      );
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError(
        `alarmMethods.${name}.retries.maxAttempts must be a positive integer`
      );
    }
    const handlerVersion = method?.handlerVersion ?? '1';
    alarmPolicies.set(name, {
      attemptTimeoutMs,
      delay: method?.retries?.delay ?? defaultRetryDelay,
      maxAttempts,
      retryTimeouts: method?.retryTimeouts ?? false,
      handlerVersion,
      acceptedHandlerVersions: validateVersions(
        handlerVersion,
        method?.acceptedHandlerVersions ?? [],
        `alarmMethods.${name}.acceptedHandlerVersions`
      ),
    });
  }

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
    try {
      if (isErrorInstance(error, NonRetryableError)) {
        return true;
      }
    } catch {
      return false;
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
    } catch {
      return false;
    }
    try {
      const constructor = Reflect.get(error, 'constructor');
      return (
        (typeof constructor === 'object' ||
          typeof constructor === 'function') &&
        constructor !== null &&
        Reflect.get(constructor, 'name') === 'NonRetryableError'
      );
    } catch {
      return false;
    }
  };

  const reportFailure = (
    details: Record<string, unknown>,
    error: unknown
  ): void => {
    try {
      const normalized = serializeError(error);
      let stack: string | undefined;
      if (
        (typeof error === 'object' || typeof error === 'function') &&
        error !== null
      ) {
        try {
          const candidate = Reflect.get(error, 'stack');
          if (typeof candidate === 'string' && candidate.length > 0) {
            stack = candidate;
          }
        } catch {
          stack = undefined;
        }
      }
      console.error({
        ...details,
        error: {
          name: normalized.name,
          message: normalized.message,
          ...(stack ? { stack } : {}),
        },
      });
    } catch {
      return;
    }
  };

  const emit = (event: DurabilityLifecycleEvent): void => {
    if (!options.onLifecycleEvent) {
      return;
    }
    const report = (error: unknown): void => {
      reportFailure(
        {
          event: 'durability.lifecycle_hook.failed',
          entityId: 'id' in event ? event.id : 'durability',
          entityKind: event.entityKind,
          lifecycleType: event.type,
        },
        error
      );
    };
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

  const trackBackground = (
    promise: Promise<void>,
    details: { operation: string; id: string; name: string },
    attachToContext: boolean
  ): Promise<void> => {
    const reported = promise.catch((error: unknown) => {
      reportFailure(
        { event: 'durability.background_execution.failed', ...details },
        error
      );
      throw error;
    });
    if (attachToContext && context.waitUntil) {
      try {
        context.waitUntil(reported);
      } catch (error) {
        reportFailure(
          { event: 'durability.background_execution.failed', ...details },
          error
        );
      }
    }
    void reported.catch(() => undefined);
    return reported;
  };

  const serialize = (value: unknown): string =>
    JSON.stringify(
      value === undefined
        ? { kind: 'undefined' }
        : { kind: 'value', value: z.json().parse(value) }
    );

  const serializeResult = (operation: string, value: unknown): string => {
    try {
      return serialize(value);
    } catch (error) {
      throw new DurableResultSerializationError(operation, error);
    }
  };

  const deserialize = (value: string): unknown => {
    const parsed: unknown = JSON.parse(value);
    const stored = storedValueSchema.parse(parsed);
    return stored.kind === 'undefined' ? undefined : stored.value;
  };

  const validateValue = async <Value>(
    schema: StandardSchemaV1<unknown, Value>,
    value: unknown,
    errorFor: (issues: readonly string[]) => Error
  ): Promise<Value> => {
    try {
      const result = await schema['~standard'].validate(value);
      if (result.issues) {
        throw errorFor(
          result.issues.map((issue) => {
            try {
              const message = Reflect.get(issue, 'message');
              return typeof message === 'string' && message.length > 0
                ? message
                : 'Invalid value';
            } catch {
              return 'Invalid value';
            }
          })
        );
      }
      return result.value;
    } catch (error) {
      if (
        isErrorInstance(error, DurablePayloadValidationError) ||
        isErrorInstance(error, DurableResultValidationError)
      ) {
        throw error;
      }
      const normalized = serializeError(error);
      throw errorFor([`${normalized.name}: ${normalized.message}`]);
    }
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

  const getNamedAlarm = (name: string): AlarmRow | undefined =>
    alarmRowSchema.optional().parse(
      qb
        .fetchOne<AlarmRow>({
          tableName: alarmTableName,
          where: { conditions: 'name = ?', params: [name] },
        })
        .execute().results
    );

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
    operationVersion: call.operation_version,
    payloadVersion: call.payload_version,
  });

  const alarmEntity = (row: AlarmRow): AlarmLifecycleEntity => ({
    entityKind: 'named_alarm',
    alarm: row.name,
    id: row.name,
    generation: row.generation_id,
    handlerVersion: row.handler_version,
  });

  const getResult = async (
    operation: string,
    idempotencyKey: string
  ): Promise<DurableOperationResult<unknown>> => {
    const call = getCall(idempotencyKey);
    if (!call) {
      return { status: 'not_found' };
    }
    assertOperation(idempotencyKey, call.operation, operation);
    const versions = {
      operationVersion: call.operation_version,
      payloadVersion: call.payload_version,
    };
    if (call.status === 'pending') {
      return {
        ...versions,
        status: 'pending',
        attempt: call.attempt,
        nextAttemptAt: call.next_attempt_at,
        lastError: call.last_error,
      };
    }
    if (call.status === 'failed' || call.status === 'cancelled') {
      return {
        ...versions,
        status: call.status,
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
    const policy = operationPolicies.get(operation);
    if (!policy) {
      throw new Error(`Unknown durable operation "${operation}"`);
    }
    let result: unknown;
    try {
      result = deserialize(call.result);
    } catch (error) {
      const normalized = serializeError(error);
      throw new DurableResultValidationError(operation, [
        `${normalized.name}: ${normalized.message}`,
      ]);
    }
    return {
      ...versions,
      status: 'completed',
      result: await validateValue(
        policy.resultSchema,
        result,
        (issues) => new DurableResultValidationError(operation, issues)
      ),
    };
  };

  const getNextPendingAt = (): number | undefined =>
    nextAttemptSchema.optional().parse(
      qb
        .fetchOne<Pick<CallRow, 'next_attempt_at'>>({
          tableName,
          fields: 'next_attempt_at',
          where: { conditions: "status = 'pending'" },
          orderBy: 'next_attempt_at ASC',
        })
        .execute().results
    )?.next_attempt_at;

  const getNextNamedAlarmAt = (): number | undefined =>
    nextAttemptSchema.optional().parse(
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

  const reconcileAlarm = async (
    transaction: DurableObjectTransaction
  ): Promise<void> => {
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

  const armForHandoff = async (timestamp: number): Promise<void> => {
    await context.storage.transaction(async (transaction) => {
      const currentAlarm = await transaction.getAlarm();
      if (currentAlarm === null || currentAlarm > timestamp) {
        await transaction.setAlarm(timestamp);
      }
    });
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
  const acquirePermit = (): Promise<() => void> => {
    if (availablePermits > 0) {
      availablePermits -= 1;
      return Promise.resolve(createRelease());
    }
    return new Promise((resolve) => {
      permitWaiters.push(resolve);
    });
  };

  const retryDelay = (
    callback: (attempt: number) => number,
    attempt: number,
    entity: string
  ): { delay: number; timestamp: number } => {
    try {
      const delay = Math.round(callback(attempt));
      const timestamp = Date.now();
      if (
        !Number.isSafeInteger(delay) ||
        delay < 0 ||
        !Number.isSafeInteger(timestamp + delay)
      ) {
        throw new DurableRetryPolicyError(entity);
      }
      return { delay, timestamp };
    } catch (error) {
      if (isErrorInstance(error, DurableRetryPolicyError)) {
        throw error;
      }
      throw new DurableRetryPolicyError(entity, error);
    }
  };

  const execute = (id: string): Promise<void> => {
    const running = active.get(id);
    if (running) {
      return running.settled;
    }

    const initial = getCall(id);
    if (!initial || initial.status !== 'pending') {
      return Promise.resolve();
    }
    const policy = operationPolicies.get(initial.operation) ?? {
      payloadSchema: z.never(),
      resultSchema: z.never(),
      attemptTimeoutMs: defaultAttemptTimeoutMs,
      delay: defaultRetryDelay,
      maxAttempts: defaultMaxAttempts,
      retryTimeouts: false,
      operationVersion: '1',
      payloadVersion: '1',
      acceptedOperationVersions: new Set(['1']),
      acceptedPayloadVersions: new Set(['1']),
    };

    let settleActive: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settleActive = resolve;
    });
    const activeExecution: ActiveExecution = {
      generation: initial.generation_id,
      createdAt: initial.created_at,
      settled,
    };
    active.set(id, activeExecution);
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
      let versionError: DurableVersionMismatchError | undefined;
      if (!policy.acceptedOperationVersions.has(initial.operation_version)) {
        versionError = new DurableVersionMismatchError(
          'operation',
          initial.operation,
          'operation',
          initial.operation_version
        );
      } else if (!policy.acceptedPayloadVersions.has(initial.payload_version)) {
        versionError = new DurableVersionMismatchError(
          'operation',
          initial.operation,
          'payload',
          initial.payload_version
        );
      }
      if (versionError) {
        const error = serializeError(versionError);
        let updated = false;
        await context.storage.transaction(async (transaction) => {
          updated =
            idSchema.optional().parse(
              context.storage.sql
                .exec<{ id: string }>(
                  `UPDATE durability_calls
                   SET status = 'failed', last_error = ?, last_error_name = ?
                   WHERE id = ? AND generation_id = ? AND status = 'pending'
                   RETURNING id`,
                  error.message,
                  error.name,
                  id,
                  initial.generation_id
                )
                .toArray()[0]
            ) !== undefined;
          await reconcileAlarm(transaction);
        });
        if (updated) {
          emit({
            ...operationEntity(initial),
            type: 'terminal',
            timestamp: Date.now(),
            attempt: initial.attempt,
            reason: 'version_mismatch',
            error,
          });
        }
        return;
      }

      releasePermit = await acquirePermit();
      const claimed = callAttemptSchema.optional().parse(
        context.storage.sql
          .exec<Pick<CallRow, 'attempt'>>(
            `UPDATE durability_calls
             SET attempt = attempt + 1
             WHERE id = ? AND generation_id = ? AND status = 'pending'
               AND attempt < ?
             RETURNING attempt`,
            id,
            initial.generation_id,
            policy.maxAttempts
          )
          .toArray()[0]
      );
      if (!claimed) {
        const current = getCall(id);
        if (
          current?.generation_id === initial.generation_id &&
          current.status === 'pending' &&
          current.attempt >= policy.maxAttempts
        ) {
          const exhausted = serializeError(
            new DurableAttemptsExhaustedError(
              'operation',
              current.operation,
              policy.maxAttempts
            )
          );
          let updated = false;
          await context.storage.transaction(async (transaction) => {
            updated =
              idSchema.optional().parse(
                context.storage.sql
                  .exec<{ id: string }>(
                    `UPDATE durability_calls
                     SET status = 'failed', last_error = ?, last_error_name = ?
                     WHERE id = ? AND generation_id = ? AND status = 'pending'
                       AND attempt >= ?
                     RETURNING id`,
                    exhausted.message,
                    exhausted.name,
                    id,
                    initial.generation_id,
                    policy.maxAttempts
                  )
                  .toArray()[0]
              ) !== undefined;
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
      const entity = operationEntity(initial);
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
        const handler = operationHandlers.get(initial.operation);
        if (!handler) {
          throw new NonRetryableError(
            `No handler registered for operation "${initial.operation}"`
          );
        }

        let deserializedPayload: unknown;
        try {
          deserializedPayload = deserialize(initial.payload);
        } catch (error) {
          const normalized = serializeError(error);
          throw new DurablePayloadValidationError(initial.operation, [
            `${normalized.name}: ${normalized.message}`,
          ]);
        }
        const payload = await validateValue(
          policy.payloadSchema,
          deserializedPayload,
          (issues) =>
            new DurablePayloadValidationError(initial.operation, issues)
        );
        handlerStarted = true;
        const handlerResult = Promise.resolve().then(() =>
          handler({
            id,
            operation: initial.operation,
            payload,
            attempt,
            operationVersion: initial.operation_version,
            payloadVersion: initial.payload_version,
            signal: controller.signal,
          })
        );
        // A timed-out handler may reject after its terminal outcome is persisted.
        void handlerResult
          .finally(() => {
            handlerSettled = true;
            releaseIfSettled();
          })
          .catch(() => undefined);
        const timeoutResult = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new DurableAttemptTimeoutError(
              initial.operation,
              policy.attemptTimeoutMs
            );
            controller.abort(error);
            reject(error);
          }, policy.attemptTimeoutMs);
        });
        const result = await Promise.race([handlerResult, timeoutResult]);
        const validatedResult = await validateValue(
          policy.resultSchema,
          result,
          (issues) =>
            new DurableResultValidationError(initial.operation, issues)
        );
        const serialized = serializeResult(initial.operation, validatedResult);
        const completedAt = Date.now();
        const updated = callGenerationSchema.optional().parse(
          context.storage.sql
            .exec<Pick<CallRow, 'generation_id'>>(
              `UPDATE durability_calls
               SET status = 'completed', result = ?, last_error = NULL,
                   last_error_name = NULL, completed_at = ?
               WHERE id = ? AND generation_id = ? AND status = 'pending'
                 AND attempt = ?
               RETURNING generation_id`,
              serialized,
              completedAt,
              id,
              initial.generation_id,
              attempt
            )
            .toArray()[0]
        );
        if (updated) {
          emit({
            ...entity,
            type: 'attempt_settled',
            timestamp: completedAt,
            attempt,
            durationMs: Math.max(0, completedAt - startedAt),
            outcome: 'completed',
          });
        }
      } catch (caught) {
        let error = caught;
        let terminal =
          isNonRetryable(error) ||
          isErrorInstance(error, DurablePayloadValidationError) ||
          isErrorInstance(error, DurableResultValidationError) ||
          isErrorInstance(error, DurableResultSerializationError) ||
          attempt >= policy.maxAttempts ||
          (isErrorInstance(error, DurableAttemptTimeoutError) &&
            !policy.retryTimeouts);
        let timestamp = Date.now();
        let delay = 0;
        if (!terminal) {
          try {
            ({ delay, timestamp } = retryDelay(
              policy.delay,
              attempt,
              `operation "${initial.operation}"`
            ));
          } catch (policyError) {
            error = policyError;
            terminal = true;
          }
        }
        const nextAttemptAt = timestamp + delay;
        const serializedError = serializeError(error);
        let updated = false;
        await context.storage.transaction(async (transaction) => {
          updated =
            callGenerationSchema.optional().parse(
              context.storage.sql
                .exec<Pick<CallRow, 'generation_id'>>(
                  `UPDATE durability_calls
                   SET status = ?, next_attempt_at = ?, last_error = ?,
                       last_error_name = ?
                   WHERE id = ? AND generation_id = ? AND status = 'pending'
                     AND attempt = ?
                   RETURNING generation_id`,
                  terminal ? 'failed' : 'pending',
                  nextAttemptAt,
                  serializedError.message,
                  serializedError.name,
                  id,
                  initial.generation_id,
                  attempt
                )
                .toArray()[0]
            ) !== undefined;
          await reconcileAlarm(transaction);
        });
        if (updated) {
          if (terminal) {
            emit({
              ...entity,
              type: 'attempt_settled',
              timestamp,
              attempt,
              durationMs: Math.max(0, timestamp - startedAt),
              outcome: 'failed',
              error: serializedError,
            });
          } else {
            emit({
              ...entity,
              type: 'attempt_settled',
              timestamp,
              attempt,
              durationMs: Math.max(0, timestamp - startedAt),
              outcome: 'retry_scheduled',
              error: serializedError,
              nextAttemptAt,
            });
          }
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

  const executeNamedAlarm = (
    initial: AlarmRow,
    platform: AlarmInvocationInfo | undefined
  ): Promise<void> => {
    const running = activeAlarms.get(initial.name);
    if (running) {
      return running.settled;
    }
    const policy = alarmPolicies.get(initial.name) ?? {
      attemptTimeoutMs: defaultAttemptTimeoutMs,
      delay: defaultRetryDelay,
      maxAttempts: defaultMaxAttempts,
      retryTimeouts: false,
      handlerVersion: '1',
      acceptedHandlerVersions: new Set(['1']),
    };

    let settleActive: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settleActive = resolve;
    });
    const activeExecution: ActiveExecution = {
      generation: initial.generation_id,
      createdAt: initial.created_at,
      settled,
    };
    activeAlarms.set(initial.name, activeExecution);
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
      if (!policy.acceptedHandlerVersions.has(initial.handler_version)) {
        const mismatch = serializeError(
          new DurableVersionMismatchError(
            'named alarm',
            initial.name,
            'handler',
            initial.handler_version
          )
        );
        let updated = false;
        await context.storage.transaction(async (transaction) => {
          updated =
            nameSchema.optional().parse(
              context.storage.sql
                .exec<{ name: string }>(
                  `UPDATE durability_alarms
                   SET status = 'failed', last_error = ?, last_error_name = ?
                   WHERE name = ? AND generation_id = ? AND status = 'pending'
                   RETURNING name`,
                  mismatch.message,
                  mismatch.name,
                  initial.name,
                  initial.generation_id
                )
                .toArray()[0]
            ) !== undefined;
          await reconcileAlarm(transaction);
        });
        if (updated) {
          emit({
            ...alarmEntity(initial),
            type: 'terminal',
            timestamp: Date.now(),
            attempt: initial.attempt,
            reason: 'version_mismatch',
            error: mismatch,
          });
        }
        return;
      }

      releasePermit = await acquirePermit();
      const claimed = alarmAttemptSchema.optional().parse(
        context.storage.sql
          .exec<Pick<AlarmRow, 'attempt'>>(
            `UPDATE durability_alarms
             SET attempt = attempt + 1
             WHERE name = ? AND generation_id = ? AND status = 'pending'
               AND attempt < ?
             RETURNING attempt`,
            initial.name,
            initial.generation_id,
            policy.maxAttempts
          )
          .toArray()[0]
      );
      if (!claimed) {
        const current = getNamedAlarm(initial.name);
        if (
          current?.generation_id === initial.generation_id &&
          current.status === 'pending' &&
          current.attempt >= policy.maxAttempts
        ) {
          const exhausted = serializeError(
            new DurableAttemptsExhaustedError(
              'named alarm',
              current.name,
              policy.maxAttempts
            )
          );
          let updated = false;
          await context.storage.transaction(async (transaction) => {
            updated =
              nameSchema.optional().parse(
                context.storage.sql
                  .exec<{ name: string }>(
                    `UPDATE durability_alarms
                     SET status = 'failed', last_error = ?, last_error_name = ?
                     WHERE name = ? AND generation_id = ? AND status = 'pending'
                       AND attempt >= ?
                     RETURNING name`,
                    exhausted.message,
                    exhausted.name,
                    initial.name,
                    initial.generation_id,
                    policy.maxAttempts
                  )
                  .toArray()[0]
              ) !== undefined;
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
      const entity = alarmEntity(initial);
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
        const handler = alarmHandlers.get(initial.name);
        if (!handler) {
          throw new NonRetryableError(
            `No named alarm handler registered for "${initial.name}"`
          );
        }

        handlerStarted = true;
        const handlerResult = Promise.resolve().then(() =>
          handler({
            name: initial.name,
            scheduledTime: initial.scheduled_at,
            attempt,
            isRetry: attempt > 1,
            retryCount: attempt - 1,
            idempotencyKey: `durability-alarm:v1:${initial.generation_id}`,
            handlerVersion: initial.handler_version,
            signal: controller.signal,
            platform,
          })
        );
        // A timed-out handler may reject after its terminal outcome is persisted.
        void handlerResult
          .finally(() => {
            handlerSettled = true;
            releaseIfSettled();
          })
          .catch(() => undefined);
        const timeoutResult = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new DurableAlarmTimeoutError(
              initial.name,
              policy.attemptTimeoutMs
            );
            controller.abort(error);
            reject(error);
          }, policy.attemptTimeoutMs);
        });
        await Promise.race([handlerResult, timeoutResult]);
        const timestamp = Date.now();
        const deleted = alarmGenerationSchema.optional().parse(
          context.storage.sql
            .exec<Pick<AlarmRow, 'generation_id'>>(
              `DELETE FROM durability_alarms
               WHERE name = ? AND generation_id = ? AND status = 'pending'
                 AND attempt = ?
               RETURNING generation_id`,
              initial.name,
              initial.generation_id,
              attempt
            )
            .toArray()[0]
        );
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
            ({ delay, timestamp } = retryDelay(
              policy.delay,
              attempt,
              `named alarm "${initial.name}"`
            ));
          } catch (policyError) {
            error = policyError;
            terminal = true;
          }
        }
        const nextAttemptAt = timestamp + delay;
        const serializedError = serializeError(error);
        let updated = false;
        await context.storage.transaction(async (transaction) => {
          updated =
            alarmGenerationSchema.optional().parse(
              context.storage.sql
                .exec<Pick<AlarmRow, 'generation_id'>>(
                  `UPDATE durability_alarms
                   SET status = ?, next_attempt_at = ?, last_error = ?,
                       last_error_name = ?
                   WHERE name = ? AND generation_id = ? AND status = 'pending'
                     AND attempt = ?
                   RETURNING generation_id`,
                  terminal ? 'failed' : 'pending',
                  nextAttemptAt,
                  serializedError.message,
                  serializedError.name,
                  initial.name,
                  initial.generation_id,
                  attempt
                )
                .toArray()[0]
            ) !== undefined;
          await reconcileAlarm(transaction);
        });
        if (updated) {
          if (terminal) {
            emit({
              ...entity,
              type: 'attempt_settled',
              timestamp,
              attempt,
              durationMs: Math.max(0, timestamp - startedAt),
              outcome: 'failed',
              error: serializedError,
            });
          } else {
            emit({
              ...entity,
              type: 'attempt_settled',
              timestamp,
              attempt,
              durationMs: Math.max(0, timestamp - startedAt),
              outcome: 'retry_scheduled',
              error: serializedError,
              nextAttemptAt,
            });
          }
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
      if (activeAlarms.get(initial.name) === activeExecution) {
        activeAlarms.delete(initial.name);
      }
    });
    return execution;
  };

  const run = async (input: {
    id: string;
    operation: string;
    payload: unknown;
    operationVersion?: string;
    payloadVersion?: string;
  }): Promise<void> => {
    const policy = operationPolicies.get(input.operation);
    if (!policy) {
      throw new Error(`Unknown durable operation "${input.operation}"`);
    }
    const operationVersion = input.operationVersion ?? policy.operationVersion;
    const payloadVersion = input.payloadVersion ?? policy.payloadVersion;
    validateVersion(operationVersion, 'operationVersion');
    validateVersion(payloadVersion, 'payloadVersion');
    const validatedPayload = await validateValue(
      policy.payloadSchema,
      input.payload,
      (issues) => new DurablePayloadValidationError(input.operation, issues)
    );
    const payload = serialize(validatedPayload);
    const now = Date.now();
    const generation = crypto.randomUUID();
    let inserted = false;
    let winner: CallRow | undefined;
    await context.storage.transaction(async (transaction) => {
      inserted =
        idSchema.optional().parse(
          context.storage.sql
            .exec<{ id: string }>(
              `INSERT INTO durability_calls (
                 id, operation, payload, status, attempt, next_attempt_at,
                 created_at, generation_id, operation_version, payload_version
               )
               VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO NOTHING
               RETURNING id`,
              input.id,
              input.operation,
              payload,
              now,
              now,
              generation,
              operationVersion,
              payloadVersion
            )
            .toArray()[0]
        ) !== undefined;
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
      });
    }
    if (winner?.status === 'pending') {
      trackBackground(
        execute(input.id).then(scheduleNextAlarm),
        {
          operation: input.operation,
          id: input.id,
          name: input.operation,
        },
        true
      );
    }
  };

  const scheduleNamedAlarm = async (
    name: string,
    scheduledTime: number
  ): Promise<void> => {
    if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) {
      throw new RangeError('scheduledTime must be a non-negative safe integer');
    }
    const policy = alarmPolicies.get(name);
    if (!policy) {
      throw new Error(`Unknown named alarm "${name}"`);
    }
    const timestamp = Date.now();
    const generation = crypto.randomUUID();
    await context.storage.transaction(async (transaction) => {
      context.storage.sql.exec(
        `INSERT INTO durability_alarms (
           name, generation_id, status, scheduled_at, next_attempt_at, attempt,
           created_at, handler_version
         )
         VALUES (?, ?, 'pending', ?, ?, 0, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           generation_id = excluded.generation_id,
           status = 'pending',
           scheduled_at = excluded.scheduled_at,
           next_attempt_at = excluded.next_attempt_at,
           attempt = 0,
           last_error = NULL,
           last_error_name = NULL,
           created_at = excluded.created_at,
           handler_version = excluded.handler_version`,
        name,
        generation,
        scheduledTime,
        scheduledTime,
        timestamp,
        policy.handlerVersion
      );
      await reconcileAlarm(transaction);
    });
    emit({
      entityKind: 'named_alarm',
      alarm: name,
      id: name,
      generation,
      handlerVersion: policy.handlerVersion,
      type: 'scheduled',
      timestamp,
      scheduledTime,
    });
  };

  const cancelOperation = async (
    operation: string,
    id: string
  ): Promise<DurableMutationResult> => {
    let call: CallRow | undefined;
    let updated = false;
    const timestamp = Date.now();
    await context.storage.transaction(async (transaction) => {
      call = getCall(id);
      if (!call) {
        return;
      }
      assertOperation(id, call.operation, operation);
      if (call.status !== 'pending') {
        return;
      }
      const cancellation = new DurableCancellationError('operation', operation);
      const error = serializeError(cancellation);
      updated =
        idSchema.optional().parse(
          context.storage.sql
            .exec<{ id: string }>(
              `UPDATE durability_calls
               SET status = 'cancelled', last_error = ?, last_error_name = ?
               WHERE id = ? AND generation_id = ? AND status = 'pending'
               RETURNING id`,
              error.message,
              error.name,
              id,
              call.generation_id
            )
            .toArray()[0]
        ) !== undefined;
      if (updated) {
        const running = active.get(id);
        if (running?.generation === call.generation_id) {
          running.controller?.abort(cancellation);
        }
      }
      await reconcileAlarm(transaction);
    });
    if (!call) {
      return { status: 'not_found' };
    }
    if (!updated) {
      return { status: 'unchanged' };
    }
    emit({
      ...operationEntity(call),
      type: 'cancelled',
      timestamp,
      attempt: call.attempt,
    });
    return { status: 'updated' };
  };

  const retryOperation = async (
    operation: string,
    id: string
  ): Promise<DurableMutationResult> => {
    const running = active.get(id);
    if (running) {
      const call = getCall(id);
      if (!call) {
        return { status: 'not_found' };
      }
      assertOperation(id, call.operation, operation);
      return { status: 'unchanged' };
    }
    const timestamp = Date.now();
    const generation = crypto.randomUUID();
    let previous: CallRow | undefined;
    let updated: CallRow | undefined;
    await context.storage.transaction(async (transaction) => {
      previous = getCall(id);
      if (!previous) {
        return;
      }
      assertOperation(id, previous.operation, operation);
      if (previous.status !== 'failed' && previous.status !== 'cancelled') {
        return;
      }
      context.storage.sql.exec(
        `UPDATE durability_calls
         SET status = 'pending', attempt = 0, next_attempt_at = ?,
             last_error = NULL, last_error_name = NULL, result = NULL,
             completed_at = NULL, generation_id = ?
         WHERE id = ? AND generation_id = ?
           AND status IN ('failed', 'cancelled')`,
        timestamp,
        generation,
        id,
        previous.generation_id
      );
      updated = getCall(id);
      await reconcileAlarm(transaction);
    });
    if (!previous) {
      return { status: 'not_found' };
    }
    if (!updated || updated.generation_id !== generation) {
      return { status: 'unchanged' };
    }
    emit({
      ...operationEntity(updated),
      type: 'retried',
      timestamp,
      attempt: 0,
    });
    trackBackground(
      execute(id).then(scheduleNextAlarm),
      {
        operation,
        id,
        name: operation,
      },
      true
    );
    return { status: 'updated' };
  };

  const deleteOperation = async (
    operation: string,
    id: string
  ): Promise<DurableMutationResult> => {
    let call: CallRow | undefined;
    let deleted = false;
    const timestamp = Date.now();
    await context.storage.transaction(async (transaction) => {
      call = getCall(id);
      if (!call) {
        return;
      }
      assertOperation(id, call.operation, operation);
      deleted =
        idSchema.optional().parse(
          context.storage.sql
            .exec<{ id: string }>(
              `DELETE FROM durability_calls
               WHERE id = ? AND generation_id = ?
               RETURNING id`,
              id,
              call.generation_id
            )
            .toArray()[0]
        ) !== undefined;
      if (deleted) {
        const running = active.get(id);
        if (running?.generation === call.generation_id) {
          running.controller?.abort(
            new DurableCancellationError('operation', operation)
          );
        }
      }
      await reconcileAlarm(transaction);
    });
    if (!call) {
      return { status: 'not_found' };
    }
    if (!deleted) {
      return { status: 'unchanged' };
    }
    emit({
      ...operationEntity(call),
      type: 'deleted',
      timestamp,
      attempt: call.attempt,
    });
    return { status: 'deleted' };
  };

  const cancelNamedAlarm = async (
    name: string
  ): Promise<DurableMutationResult> => {
    let row: AlarmRow | undefined;
    let updated = false;
    const timestamp = Date.now();
    await context.storage.transaction(async (transaction) => {
      row = getNamedAlarm(name);
      if (!row || row.status !== 'pending') {
        return;
      }
      const cancellation = new DurableCancellationError('named alarm', name);
      const error = serializeError(cancellation);
      updated =
        nameSchema.optional().parse(
          context.storage.sql
            .exec<{ name: string }>(
              `UPDATE durability_alarms
               SET status = 'cancelled', last_error = ?, last_error_name = ?
               WHERE name = ? AND generation_id = ? AND status = 'pending'
               RETURNING name`,
              error.message,
              error.name,
              name,
              row.generation_id
            )
            .toArray()[0]
        ) !== undefined;
      if (updated) {
        const running = activeAlarms.get(name);
        if (running?.generation === row.generation_id) {
          running.controller?.abort(cancellation);
        }
      }
      await reconcileAlarm(transaction);
    });
    if (!row) {
      return { status: 'not_found' };
    }
    if (!updated) {
      return { status: 'unchanged' };
    }
    emit({
      ...alarmEntity(row),
      type: 'cancelled',
      timestamp,
      attempt: row.attempt,
    });
    return { status: 'updated' };
  };

  const retryNamedAlarm = async (
    name: string
  ): Promise<DurableMutationResult> => {
    if (activeAlarms.has(name)) {
      return getNamedAlarm(name)
        ? { status: 'unchanged' }
        : { status: 'not_found' };
    }
    const timestamp = Date.now();
    const generation = crypto.randomUUID();
    let previous: AlarmRow | undefined;
    let updated: AlarmRow | undefined;
    await context.storage.transaction(async (transaction) => {
      previous = getNamedAlarm(name);
      if (
        !previous ||
        (previous.status !== 'failed' && previous.status !== 'cancelled')
      ) {
        return;
      }
      context.storage.sql.exec(
        `UPDATE durability_alarms
         SET status = 'pending', attempt = 0, next_attempt_at = ?,
             last_error = NULL, last_error_name = NULL, generation_id = ?
         WHERE name = ? AND generation_id = ?
           AND status IN ('failed', 'cancelled')`,
        timestamp,
        generation,
        name,
        previous.generation_id
      );
      updated = getNamedAlarm(name);
      await reconcileAlarm(transaction);
    });
    if (!previous) {
      return { status: 'not_found' };
    }
    if (!updated || updated.generation_id !== generation) {
      return { status: 'unchanged' };
    }
    emit({
      ...alarmEntity(updated),
      type: 'retried',
      timestamp,
      attempt: 0,
    });
    return { status: 'updated' };
  };

  const deleteNamedAlarm = async (
    name: string
  ): Promise<DurableMutationResult> => {
    let row: AlarmRow | undefined;
    let deleted = false;
    const timestamp = Date.now();
    await context.storage.transaction(async (transaction) => {
      row = getNamedAlarm(name);
      if (!row) {
        return;
      }
      deleted =
        nameSchema.optional().parse(
          context.storage.sql
            .exec<{ name: string }>(
              `DELETE FROM durability_alarms
               WHERE name = ? AND generation_id = ?
               RETURNING name`,
              name,
              row.generation_id
            )
            .toArray()[0]
        ) !== undefined;
      if (deleted) {
        const running = activeAlarms.get(name);
        if (running?.generation === row.generation_id) {
          running.controller?.abort(
            new DurableCancellationError('named alarm', name)
          );
        }
      }
      await reconcileAlarm(transaction);
    });
    if (!row) {
      return { status: 'not_found' };
    }
    if (!deleted) {
      return { status: 'unchanged' };
    }
    emit({
      ...alarmEntity(row),
      type: 'deleted',
      timestamp,
      attempt: row.attempt,
    });
    return { status: 'deleted' };
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
      for (const [id, running] of active) {
        if (running.createdAt < before) {
          running.controller?.abort(
            new DurableCancellationError('operation', id)
          );
        }
      }
      for (const [name, running] of activeAlarms) {
        if (running.createdAt < before) {
          running.controller?.abort(
            new DurableCancellationError('named alarm', name)
          );
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

  const listDueIds = (now: number): string[] =>
    z
      .array(idSchema)
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
            limit: 100,
          })
          .execute().results ?? []
      )
      .map((call) => call.id);

  const listDueAlarms = (now: number): AlarmRow[] =>
    alarmRowSchema.array().parse(
      qb
        .fetchAll<AlarmRow>({
          tableName: alarmTableName,
          where: {
            conditions: "status = 'pending' AND next_attempt_at <= ?",
            params: [now],
          },
          orderBy: 'next_attempt_at ASC',
          limit: 100,
        })
        .execute().results ?? []
    );

  const runConcurrent = async <Item>(
    items: Item[],
    worker: (item: Item) => Promise<void>
  ): Promise<void> => {
    let nextIndex = 0;
    const runNext = async (): Promise<void> => {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item === undefined) {
        return;
      }
      await worker(item);
      return runNext();
    };
    await Promise.all(
      Array.from({ length: Math.min(alarmConcurrency, items.length) }, runNext)
    );
  };

  const alarm = async (alarmInfo?: AlarmInvocationInfo): Promise<void> => {
    const startedAt = Date.now();
    const due = listDueIds(startedAt);
    const dueAlarms = listDueAlarms(startedAt);
    if (due.length === 0 && dueAlarms.length === 0) {
      await scheduleNextAlarm();
      return;
    }

    const operationExecution = runConcurrent(due, (id) => {
      const operation = getCall(id)?.operation ?? 'unknown';
      return trackBackground(
        execute(id),
        { operation, id, name: operation },
        false
      );
    });
    const namedAlarmExecution = runConcurrent(dueAlarms, (row) =>
      trackBackground(
        executeNamedAlarm(row, alarmInfo),
        { operation: 'named_alarm', id: row.name, name: row.name },
        false
      )
    );
    const execution = Promise.all([
      operationExecution,
      namedAlarmExecution,
    ]).then(() => undefined);

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
    const namedAlarm = (scheduledTime: number) =>
      scheduleNamedAlarm(name, scheduledTime);
    namedAlarm.cancel = () => cancelNamedAlarm(name);
    namedAlarm.retry = () => retryNamedAlarm(name);
    namedAlarm.delete = () => deleteNamedAlarm(name);
    Object.assign(alarm, { [name]: namedAlarm });
  }

  const durability: Record<string, unknown> = { alarm, purgeBefore };
  for (const operation of operationHandlers.keys()) {
    if (operation === 'alarm' || operation === 'purgeBefore') {
      throw new Error(`"${operation}" is reserved by durability`);
    }
    const durableOperation = (input: DurableOperationInput<unknown>) =>
      run({ ...input, operation });
    durableOperation.getResult = async (idempotencyKey: string) =>
      getResult(operation, idempotencyKey);
    durableOperation.cancel = (idempotencyKey: string) =>
      cancelOperation(operation, idempotencyKey);
    durableOperation.retry = (idempotencyKey: string) =>
      retryOperation(operation, idempotencyKey);
    durableOperation.delete = (idempotencyKey: string) =>
      deleteOperation(operation, idempotencyKey);
    durability[operation] = durableOperation;
  }

  const isCompleteDurability = (
    value: Record<string, unknown>
  ): value is Record<string, unknown> & Durability<Handlers, AlarmNames> => {
    if (
      typeof value['alarm'] !== 'function' ||
      typeof value['purgeBefore'] !== 'function'
    ) {
      return false;
    }
    for (const name of alarmHandlers.keys()) {
      const method = Reflect.get(value['alarm'], name);
      if (
        typeof method !== 'function' ||
        typeof Reflect.get(method, 'cancel') !== 'function' ||
        typeof Reflect.get(method, 'retry') !== 'function' ||
        typeof Reflect.get(method, 'delete') !== 'function'
      ) {
        return false;
      }
    }
    for (const operation of operationHandlers.keys()) {
      const method = value[operation];
      if (
        typeof method !== 'function' ||
        typeof Reflect.get(method, 'getResult') !== 'function' ||
        typeof Reflect.get(method, 'cancel') !== 'function' ||
        typeof Reflect.get(method, 'retry') !== 'function' ||
        typeof Reflect.get(method, 'delete') !== 'function'
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
