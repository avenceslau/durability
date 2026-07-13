import type { DurableMigrations } from '@durability/storage';
import { z } from 'zod';
import { DOQB, type Migration } from 'workers-qb';

export type DurableCall<Payload> = {
  id: string;
  operation: string;
  payload: Payload;
  attempt: number;
  signal: AbortSignal;
};

export type DurableHandler<Payload, Result> = (
  call: DurableCall<Payload>
) => Result | Promise<Result>;

export type RetryJitter = 'none' | 'equal' | 'full';

export type DurabilityRetryOptions = {
  delay?: (attempt: number) => number;
  jitter?: RetryJitter;
  maxAttempts?: number;
};

type HandlerMap = Record<string, (...args: never[]) => unknown>;

export type DurabilityMethodOptions = {
  attemptTimeoutMs?: number;
  retries?: DurabilityRetryOptions;
};

export type DurabilityOptions<Handlers extends HandlerMap = HandlerMap> = {
  alarmConcurrency?: number;
  alarmHandoffMs?: number;
  attemptTimeoutMs?: number;
  backgroundConcurrency?: number;
  methods?: Partial<
    Record<Extract<keyof Handlers, string>, DurabilityMethodOptions>
  >;
  retries?: DurabilityRetryOptions;
  retryDelay?: (attempt: number) => number;
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
  execution_mode: 'immediate' | 'background';
};

type DurableOperationInput<Handler> = {
  id: string;
  payload: HandlerPayload<Handler>;
};

type HandlerResult<Handler> = Handler extends (...args: never[]) => infer Result
  ? Awaited<Result>
  : never;

export type DurableOperationResult<Result> =
  | { status: 'not_found' }
  | {
      status: 'pending';
      attempt: number;
      nextAttemptAt: number;
      lastError: string | null;
    }
  | {
      status: 'failed';
      attempt: number;
      error: { name: string; message: string };
    }
  | { status: 'completed'; result: Result };

type DurableOperation<Handler> = ((
  input: DurableOperationInput<Handler>
) => Promise<void>) & {
  getResult: (
    idempotencyKey: string
  ) => Promise<DurableOperationResult<HandlerResult<Handler>>>;
};

export type Durability<Handlers extends HandlerMap> = {
  alarm: (alarmInfo?: AlarmInvocationInfo) => Promise<void>;
  background: {
    [Operation in keyof Handlers]: DurableOperation<Handlers[Operation]>;
  };
} & {
  [Operation in keyof Handlers]: DurableOperation<Handlers[Operation]>;
};

const tableName = 'durability_calls';
const migrationTableName = 'durability_migrations';
const storedValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.json() }),
  z.object({ kind: z.literal('undefined') }),
]);
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
    name: 'durability_0003_execution_mode',
    up: `
      ALTER TABLE durability_calls
      ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'immediate'
      CHECK (execution_mode IN ('immediate', 'background'));
    `,
    down: 'ALTER TABLE durability_calls DROP COLUMN execution_mode;',
  },
  {
    name: 'durability_0004_pending_mode_index',
    up: `
      CREATE INDEX IF NOT EXISTS durability_calls_pending_mode_idx
      ON durability_calls (execution_mode, next_attempt_at)
      WHERE status = 'pending';
    `,
    down: 'DROP INDEX IF EXISTS durability_calls_pending_mode_idx;',
  },
] satisfies DurableMigrations;

export type DurabilityMigrationResult = {
  applied: string[];
  rolledBack: string[];
};

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

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export class DurableAttemptTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Durable operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'DurableAttemptTimeoutError';
  }
}

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

export const createDurability = <Handlers extends HandlerMap>(
  context: Pick<DurableObjectState, 'storage'>,
  handlers: Handlers,
  options: DurabilityOptions<Handlers> = {}
) => {
  migrateDurability(context);
  const qb = new DOQB(context.storage.sql);

  const active = new Map<string, Promise<unknown>>();
  const alarmConcurrency = options.alarmConcurrency ?? 10;
  const alarmHandoffMs = options.alarmHandoffMs ?? 14 * 60_000;
  const backgroundConcurrency = options.backgroundConcurrency ?? 10;
  const defaultAttemptTimeoutMs = options.attemptTimeoutMs ?? 5 * 60_000;
  const defaultRetryDelay =
    options.retries?.delay ??
    options.retryDelay ??
    ((attempt: number) => Math.min(1_000 * 2 ** (attempt - 1), 300_000));
  const defaultRetryJitter = options.retries?.jitter ?? 'equal';
  const defaultMaxAttempts = options.retries?.maxAttempts ?? 5;
  if (!Number.isInteger(alarmConcurrency) || alarmConcurrency < 1) {
    throw new RangeError('alarmConcurrency must be a positive integer');
  }
  if (!Number.isInteger(backgroundConcurrency) || backgroundConcurrency < 1) {
    throw new RangeError('backgroundConcurrency must be a positive integer');
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
  if (!['none', 'equal', 'full'].includes(defaultRetryJitter)) {
    throw new RangeError('retries.jitter must be none, equal, or full');
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
    if (
      method?.retries?.jitter !== undefined &&
      !['none', 'equal', 'full'].includes(method.retries.jitter)
    ) {
      throw new RangeError(
        `methods.${operation}.retries.jitter must be none, equal, or full`
      );
    }
  }

  const executionPolicy = (operation: string) => {
    const method = methodOptions[operation];
    return {
      attemptTimeoutMs: method?.attemptTimeoutMs ?? defaultAttemptTimeoutMs,
      delay: method?.retries?.delay ?? defaultRetryDelay,
      jitter: method?.retries?.jitter ?? defaultRetryJitter,
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
    executionMode: CallRow['execution_mode'],
    idempotencyKey: string
  ): DurableOperationResult<unknown> => {
    const call = getCall(idempotencyKey);
    if (!call) {
      return { status: 'not_found' };
    }
    assertOperation(idempotencyKey, call.operation, operation);
    if (call.execution_mode !== executionMode) {
      throw new Error(
        `Durable call "${idempotencyKey}" belongs to ${call.execution_mode} execution, not ${executionMode}`
      );
    }
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

  const listDueIds = (
    executionMode: CallRow['execution_mode'],
    now: number,
    limit: number
  ): string[] =>
    (
      qb
        .fetchAll<Pick<CallRow, 'id'>>({
          tableName,
          fields: 'id',
          where: {
            conditions:
              "status = 'pending' AND execution_mode = ? AND next_attempt_at <= ?",
            params: [executionMode, now],
          },
          orderBy: 'next_attempt_at ASC',
          limit,
        })
        .execute().results ?? []
    ).map((call) => call.id);

  const hasDue = (
    executionMode: CallRow['execution_mode'],
    now: number
  ): boolean =>
    qb
      .fetchOne<Pick<CallRow, 'id'>>({
        tableName,
        fields: 'id',
        where: {
          conditions:
            "status = 'pending' AND execution_mode = ? AND next_attempt_at <= ?",
          params: [executionMode, now],
        },
      })
      .execute().results !== undefined;

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
        const jitteredDelay =
          terminal || policy.jitter === 'none'
            ? baseDelay
            : policy.jitter === 'full'
              ? Math.random() * baseDelay
              : baseDelay / 2 + Math.random() * (baseDelay / 2);
        const nextAttemptAt = Date.now() + Math.round(jitteredDelay);
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

  let backgroundBatch: Promise<void> | undefined;
  const scheduleBackground = (): Promise<void> => {
    if (backgroundBatch) {
      return backgroundBatch;
    }

    backgroundBatch = new Promise<void>((resolve) => {
      setTimeout(async () => {
        const due = listDueIds('background', Date.now(), 100);

        await runConcurrent(due, backgroundConcurrency, async (id) => {
          try {
            await execute(id);
          } catch {
            return;
          }
        });
        await scheduleNextAlarm();
        backgroundBatch = undefined;
        resolve();

        const moreDue = hasDue('background', Date.now());
        if (moreDue) {
          void scheduleBackground();
        }
      }, 0);
    });
    return backgroundBatch;
  };

  const run = async (input: {
    id: string;
    operation: string;
    payload: unknown;
    executionMode: CallRow['execution_mode'];
  }): Promise<void> => {
    const existing = getCall(input.id);
    if (existing) {
      assertOperation(input.id, existing.operation, input.operation);
      if (existing.execution_mode !== input.executionMode) {
        throw new Error(
          `Durable call "${input.id}" belongs to ${existing.execution_mode} execution, not ${input.executionMode}`
        );
      }
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
            execution_mode: input.executionMode,
          },
        }).execute();
        if ((await transaction.getAlarm()) === null) {
          await transaction.setAlarm(now);
        }
      });
    }

    const execution =
      input.executionMode === 'background'
        ? scheduleBackground()
        : execute(input.id);
    void execution.then(() => scheduleNextAlarm()).catch(() => undefined);
  };

  const alarm = async (_alarmInfo?: AlarmInvocationInfo): Promise<void> => {
    const startedAt = Date.now();
    const immediate = listDueIds('immediate', startedAt, 100);
    const hasBackground = hasDue('background', startedAt);
    if (immediate.length === 0 && !hasBackground) {
      await scheduleNextAlarm();
      return;
    }

    const executions: Promise<void>[] = [
      runConcurrent(immediate, alarmConcurrency, async (id) => {
        try {
          await execute(id);
        } catch {
          return;
        }
      }),
    ];
    if (hasBackground) {
      executions.push(scheduleBackground());
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const handoff = Symbol('alarm handoff');
    const remaining = alarmHandoffMs - (Date.now() - startedAt);
    const result = await Promise.race([
      Promise.allSettled(executions),
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

  const background: Record<string, unknown> = {};
  const durability: Record<string, unknown> = { alarm, background };
  for (const operation of Object.keys(handlers) as (keyof Handlers &
    string)[]) {
    if (operation === 'alarm' || operation === 'background') {
      throw new Error(`"${operation}" is reserved by durability`);
    }

    const durableOperation = (input: { id: string; payload: unknown }) =>
      run({ ...input, operation, executionMode: 'immediate' });
    durableOperation.getResult = async (idempotencyKey: string) =>
      getResult(operation, 'immediate', idempotencyKey);
    durability[operation] = durableOperation;

    const backgroundOperation = (input: { id: string; payload: unknown }) =>
      run({ ...input, operation, executionMode: 'background' });
    backgroundOperation.getResult = async (idempotencyKey: string) =>
      getResult(operation, 'background', idempotencyKey);
    background[operation] = backgroundOperation;
  }

  return durability as Durability<Handlers>;
};
