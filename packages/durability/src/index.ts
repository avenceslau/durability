import type { DurableMigrations } from '@durability/storage';
import { z } from 'zod';
import { DOQB, type Migration } from 'workers-qb';

export type DurableCall<Payload> = {
  id: string;
  operation: string;
  payload: Payload;
  attempt: number;
};

export type DurableHandler<Payload, Result> = (
  call: DurableCall<Payload>
) => Result | Promise<Result>;

export type DurabilityOptions = {
  alarmConcurrency?: number;
  alarmHandoffMs?: number;
  backgroundConcurrency?: number;
  retryDelay?: (attempt: number) => number;
};

type HandlerMap = Record<string, (...args: never[]) => unknown>;

type HandlerPayload<Handler> = Handler extends (
  call: DurableCall<infer Payload>
) => unknown
  ? Payload
  : never;

type CallRow = {
  id: string;
  operation: string;
  payload: string;
  status: 'pending' | 'completed';
  result: string | null;
  attempt: number;
  next_attempt_at: number;
  last_error: string | null;
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
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
        result TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
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
  options: DurabilityOptions = {}
) => {
  migrateDurability(context);
  const qb = new DOQB(context.storage.sql);

  const active = new Map<string, Promise<unknown>>();
  const alarmConcurrency = options.alarmConcurrency ?? 10;
  const alarmHandoffMs = options.alarmHandoffMs ?? 14 * 60_000;
  const backgroundConcurrency = options.backgroundConcurrency ?? 10;
  if (!Number.isInteger(alarmConcurrency) || alarmConcurrency < 1) {
    throw new RangeError('alarmConcurrency must be a positive integer');
  }
  if (!Number.isInteger(backgroundConcurrency) || backgroundConcurrency < 1) {
    throw new RangeError('backgroundConcurrency must be a positive integer');
  }
  const retryDelay =
    options.retryDelay ??
    ((attempt: number) => Math.min(1_000 * 2 ** (attempt - 1), 300_000));

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
    if (call.result === null) {
      throw new Error(
        `Completed durable call "${idempotencyKey}" has no result`
      );
    }
    return { status: 'completed', result: deserialize(call.result) };
  };

  const listPending = (): CallRow[] =>
    qb
      .fetchAll<CallRow>({
        tableName,
        where: { conditions: "status = 'pending'" },
        orderBy: 'next_attempt_at ASC',
      })
      .execute().results ?? [];

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

  const scheduleNextAlarm = async () => {
    const next = listPending()[0];
    if (!next) {
      await context.storage.deleteAlarm();
      return;
    }
    await armIfMissing(next.next_attempt_at);
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

      const handler = handlers[call.operation] as
        | ((durableCall: DurableCall<unknown>) => unknown)
        | undefined;
      const attempt = call.attempt + 1;

      if (!handler) {
        const message = `No handler registered for operation "${call.operation}"`;
        const nextAttemptAt = Date.now() + retryDelay(attempt);
        await context.storage.transaction(async (transaction) => {
          qb.update({
            tableName,
            data: {
              attempt,
              next_attempt_at: nextAttemptAt,
              last_error: message,
            },
            where: { conditions: 'id = ?', params: [id] },
          }).execute();
          if ((await transaction.getAlarm()) === null) {
            await transaction.setAlarm(nextAttemptAt);
          }
        });
        throw new Error(message);
      }

      qb.update({
        tableName,
        data: { attempt },
        where: { conditions: 'id = ?', params: [id] },
      }).execute();

      try {
        const result = await handler({
          id,
          operation: call.operation,
          payload: deserialize(call.payload),
          attempt,
        });

        qb.update({
          tableName,
          data: {
            status: 'completed',
            result: serialize(result),
            last_error: null,
            completed_at: Date.now(),
          },
          where: { conditions: 'id = ?', params: [id] },
        }).execute();
        return result;
      } catch (error) {
        const nextAttemptAt = Date.now() + retryDelay(attempt);
        await context.storage.transaction(async (transaction) => {
          qb.update({
            tableName,
            data: {
              attempt,
              next_attempt_at: nextAttemptAt,
              last_error:
                error instanceof Error ? error.message : String(error),
            },
            where: { conditions: 'id = ?', params: [id] },
          }).execute();
          if ((await transaction.getAlarm()) === null) {
            await transaction.setAlarm(nextAttemptAt);
          }
        });
        throw error;
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
        const due = listPending()
          .filter(
            (call) =>
              call.execution_mode === 'background' &&
              call.next_attempt_at <= Date.now()
          )
          .slice(0, 100);

        await runConcurrent(due, backgroundConcurrency, async (call) => {
          try {
            await execute(call.id);
          } catch {
            return;
          }
        });
        await scheduleNextAlarm();
        backgroundBatch = undefined;
        resolve();

        const moreDue = listPending().some(
          (call) =>
            call.execution_mode === 'background' &&
            call.next_attempt_at <= Date.now()
        );
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
      if (existing.status === 'completed') {
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
    const due = listPending().filter(
      (call) => call.next_attempt_at <= startedAt
    );
    if (due.length === 0) {
      await scheduleNextAlarm();
      return;
    }

    const immediate = due.filter((call) => call.execution_mode === 'immediate');
    const executions: Promise<void>[] = [
      runConcurrent(immediate, alarmConcurrency, async (call) => {
        try {
          await execute(call.id);
        } catch {
          return;
        }
      }),
    ];
    if (due.some((call) => call.execution_mode === 'background')) {
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
