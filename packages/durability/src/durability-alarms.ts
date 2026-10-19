import { z } from 'zod';
import { traceFunction, traceMethods } from './dev.js';
import {
  DurableAlarmTimeoutError,
  DurableAttemptsExhaustedError,
  isErrorInstance,
  NonRetryableError,
} from './errors.js';
import {
  createLifecycleHooks,
  type AlarmLifecycleEntity,
  type DurabilityLifecycleEvent,
  type LifecycleHook,
  type LifecycleHooks,
} from './lifecycle.js';
import {
  durabilityNamedAlarmMigrations,
  migrate,
  type DurabilityMigrationResult,
} from './migrations.js';
import {
  alarmMethodOptionsSchema,
  createPolicyResolver,
  type AlarmMethodPolicy,
  type DurabilityAlarmMethodOptions,
  type ExecutionPolicyOptions,
  type PolicyResolver,
} from './policy.js';
import {
  engineFor,
  type ActiveExecution,
  type Engine,
  type SchedulerAttachment,
} from './scheduler.js';
import { deleteAttempt, listCreated, type DurableTable } from './storage.js';
import {
  registerTrackedSource,
  type UntypedRecord,
  type UntypedSource,
} from './tracked-source.js';

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

type AlarmRow = z.infer<typeof alarmRowSchema>;

const alarmsTable: DurableTable = { name: 'durability_alarms', key: 'name' };

/** Information passed to a named alarm handler for one execution attempt. */
export type DurableAlarmInfo = {
  /** Configured name of the logical alarm. */
  name: string;
  /** Timestamp originally passed to the named alarm method. */
  scheduledTime: number;
  /**
   * One-based attempt ordinal for this scheduled occurrence, durably recorded
   * before the handler runs. It is retry and logging context, not a record of
   * what the handler did: never gate once-only work on it (such as
   * `attempt === 1`). Key such work on durable state keyed by `idempotencyKey`
   * instead. See the README identity glossary.
   */
  attempt: number;
  /** Whether this scheduled occurrence has run before. */
  isRetry: boolean;
  /** Number of previous attempts for this scheduled occurrence. */
  retryCount: number;
  /**
   * Stable key shared by every attempt of this scheduled occurrence. This is
   * the occurrence's logical identity: pass it to downstream services for
   * deduplication rather than relying on `attempt`.
   */
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

/** Policy configuration for named alarms. */
export type DurabilityAlarmsOptions<Names extends string = string> =
  ExecutionPolicyOptions & {
    /** Execution policy overrides keyed by alarm name. */
    methods?: Partial<Record<NoInfer<Names>, DurabilityAlarmMethodOptions>>;
    /** Receives best-effort, non-durable lifecycle metrics events. */
    onLifecycleEvent?: LifecycleHook;
  };

/**
 * Constructor configuration: the alarm handlers, their policies, and either a
 * shared `scheduler` or the Durable Object `context` (plus scheduler options)
 * to create a private one.
 */
export type DurabilityAlarmsConfig<Names extends string = string> =
  DurabilityAlarmsOptions<Names> &
    SchedulerAttachment & {
      /** Alarm handlers keyed by the scheduling method names they become. */
      handlers: Record<Names, DurableAlarmHandler>;
    };

/** A lifecycle event for one of this instance's named alarms. */
export type DurabilityAlarmEvent =
  | Extract<DurabilityLifecycleEvent, { entityKind: 'named_alarm' }>
  | Extract<DurabilityLifecycleEvent, { type: 'purged' }>;

/** Schedules (or replaces) the named alarm's pending occurrence. */
export type DurableNamedAlarm = (scheduledTime: number) => Promise<void>;

const readAlarm = (sql: SqlStorage, name: string): AlarmRow | undefined =>
  alarmRowSchema
    .optional()
    .parse(
      sql
        .exec('SELECT * FROM durability_alarms WHERE name = ?', name)
        .toArray()[0]
    );

const alarmRecord = (row: AlarmRow): UntypedRecord => ({
  id: row.name,
  name: row.name,
  generation: row.generation_id,
  createdAt: row.created_at,
  state:
    row.status === 'pending'
      ? {
          status: 'pending',
          attempt: row.attempt,
          nextAttemptAt: row.next_attempt_at,
          lastError: row.last_error,
        }
      : {
          status: 'failed',
          attempt: row.attempt,
          error: {
            name: row.last_error_name ?? 'Error',
            message: row.last_error ?? 'Durable alarm failed',
          },
        },
});

const alarmEntity = (row: AlarmRow): AlarmLifecycleEntity => ({
  entityKind: 'named_alarm',
  alarm: row.name,
  id: row.name,
  generation: row.generation_id,
});

class DurabilityAlarmsCore<Names extends string> {
  readonly #engine: Engine;
  readonly #handlers: Map<string, DurableAlarmHandler>;
  readonly #policy: PolicyResolver<AlarmMethodPolicy>;
  readonly #lifecycle: LifecycleHooks;
  readonly #emit: LifecycleHooks['emit'];
  readonly #active = new Map<string, ActiveExecution>();

  constructor(config: DurabilityAlarmsConfig<Names>) {
    this.#engine = engineFor(config);
    this.#handlers = new Map(
      Object.entries<DurableAlarmHandler>(config.handlers).map(
        ([name, handler]) => [name, alarmHandlerSchema.parse(handler)]
      )
    );
    this.#policy = createPolicyResolver(
      config,
      config.methods ?? {},
      alarmMethodOptionsSchema
    );
    this.#lifecycle = createLifecycleHooks(
      (hook) => this.#engine.emitter(hook),
      config.onLifecycleEvent
    );
    this.#emit = this.#lifecycle.emit;

    const reserved = new Set(
      Object.getOwnPropertyNames(DurabilityAlarmsCore.prototype)
    );
    for (const name of this.#handlers.keys()) {
      if (reserved.has(name)) {
        throw new Error(`"${name}" is reserved by DurabilityAlarms`);
      }
      Object.defineProperty(this, name, {
        value: traceFunction(
          `DurabilityAlarms.${name}`,
          (scheduledTime: number) => this.#schedule(name, scheduledTime)
        ),
        enumerable: true,
      });
    }

    this.#engine.migrateSchema('namedAlarms', durabilityNamedAlarmMigrations);
    this.#engine.register({
      table: alarmsTable,
      runDue: (now, info) => this.#runDue(now, info),
    });
    registerTrackedSource(this, this.#trackedSource());
  }

  /** Applies or reverts the `durability_alarms` schema; see {@link migrate}. */
  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ): DurabilityMigrationResult {
    return migrate(
      context.storage,
      'namedAlarms',
      durabilityNamedAlarmMigrations,
      target
    );
  }

  /** Runs due named alarms and re-arms the physical alarm. */
  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#engine.alarm(info);
  }

  /**
   * Attaches a best-effort lifecycle hook alongside `onLifecycleEvent` and
   * returns a function that detaches it.
   */
  lifecycle(
    hook: (event: DurabilityAlarmEvent) => void | Promise<void>
  ): () => void {
    return this.#lifecycle.add(hook as LifecycleHook);
  }

  /**
   * Destructively removes named alarm records created strictly before the
   * timestamp, regardless of status, and returns how many were removed.
   */
  async purgeBefore(before: number): Promise<number> {
    const count = await this.#engine.purge(
      alarmsTable,
      before,
      this.#active,
      'Durable alarm was purged'
    );
    this.#emit({
      type: 'purged',
      entityKind: 'named_alarm',
      timestamp: Date.now(),
      before,
      count,
    });
    return count;
  }

  /** Success deletes an occurrence, so only pending and failed ones are listed. */
  #trackedSource(): UntypedSource {
    const sql = this.#engine.sql;
    return {
      get: async (name) => {
        const row = readAlarm(sql, name);
        return row && alarmRecord(row);
      },
      list: async ({ limit, cursor, status, name }) => {
        const page = listCreated(sql, alarmsTable, 'name', {
          limit,
          after: cursor,
          status,
          name,
        });
        const records = alarmRowSchema
          .array()
          .parse(page.rows)
          .map(alarmRecord);
        return page.next === undefined
          ? { records }
          : { records, cursor: page.next };
      },
      watch: (name, listener) =>
        this.#engine.watch(alarmsTable, name, (completed) => {
          if (!completed) {
            listener();
            return;
          }
          listener({
            id: name,
            name,
            generation: completed.generation_id,
            createdAt: completed.created_at,
            state: { status: 'completed', result: undefined },
          });
        }),
    };
  }

  async #runDue(
    now: number,
    info: AlarmInvocationInfo | undefined
  ): Promise<void> {
    const due = alarmRowSchema.array().parse(
      this.#engine.sql
        .exec(
          `SELECT * FROM durability_alarms
             WHERE status = 'pending' AND next_attempt_at <= ?
             ORDER BY next_attempt_at ASC
             LIMIT 100`,
          now
        )
        .toArray()
    );
    const failures: unknown[] = [];
    await this.#engine.runConcurrent(due, async (row) => {
      try {
        await this.#execute(row, info);
      } catch (error) {
        failures.push(error);
      }
    });
    if (failures.length > 0) {
      throw failures[0];
    }
  }

  async #schedule(name: string, scheduledTime: number): Promise<void> {
    if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) {
      throw new RangeError('scheduledTime must be a non-negative safe integer');
    }

    const generation = crypto.randomUUID();
    const createdAt = Date.now();
    await this.#engine.transaction((sql) => {
      sql.exec(
        `INSERT INTO durability_alarms
           (name, generation_id, status, scheduled_at, next_attempt_at,
            attempt, last_error, last_error_name, created_at)
         VALUES (?, ?, 'pending', ?, ?, 0, NULL, NULL, ?)
         ON CONFLICT(name) DO UPDATE SET
           generation_id = excluded.generation_id,
           status = excluded.status,
           scheduled_at = excluded.scheduled_at,
           next_attempt_at = excluded.next_attempt_at,
           attempt = excluded.attempt,
           last_error = excluded.last_error,
           last_error_name = excluded.last_error_name,
           created_at = excluded.created_at`,
        name,
        generation,
        scheduledTime,
        scheduledTime,
        createdAt
      );
    });
    // A waiter on the replaced occurrence resolves now instead of at its timeout.
    this.#engine.notify(alarmsTable, name);
    this.#emit({
      type: 'scheduled',
      entityKind: 'named_alarm',
      alarm: name,
      id: name,
      generation,
      timestamp: createdAt,
      attempt: 0,
      scheduledTime,
    });
  }

  /** One name never has more than one running handler in this instance. */
  #execute(
    row: AlarmRow,
    platform: AlarmInvocationInfo | undefined
  ): Promise<void> {
    const running = this.#active.get(row.name);
    if (running) {
      return running.settled;
    }

    const policy = this.#policy(row.name);
    const retryTimeouts = policy.method?.retryTimeouts ?? false;
    return this.#engine.startExecution({
      table: alarmsTable,
      key: row.name,
      row,
      label: `named alarm "${row.name}"`,
      entity: alarmEntity(row),
      active: this.#active,
      policy,
      emit: this.#emit,
      exhaustedError: () =>
        new DurableAttemptsExhaustedError(
          'named alarm',
          row.name,
          policy.maxAttempts
        ),
      timeoutError: () =>
        new DurableAlarmTimeoutError(row.name, policy.attemptTimeoutMs),
      invoke: (attempt, signal) => {
        const handler = this.#handlers.get(row.name);
        if (!handler) {
          throw new NonRetryableError(
            `No named alarm handler registered for "${row.name}"`
          );
        }
        return handler({
          name: row.name,
          scheduledTime: row.scheduled_at,
          attempt,
          isRetry: attempt > 1,
          retryCount: attempt - 1,
          idempotencyKey: `durability-alarm:v1:${row.generation_id}`,
          signal,
          platform,
        });
      },
      complete: (_result, attempt) => {
        const timestamp = Date.now();
        const removed = deleteAttempt(this.#engine.sql, alarmsTable, {
          key: row.name,
          generation: row.generation_id,
          attempt,
        });
        return removed ? timestamp : undefined;
      },
      isTerminal: (error) =>
        isErrorInstance(error, DurableAlarmTimeoutError) && !retryTimeouts,
    });
  }
}

/**
 * Named logical alarms sharing one Durable Object's physical alarm.
 *
 * Every handler becomes a typed scheduling method on the instance. Scheduling
 * a name again replaces its pending occurrence; each occurrence has a stable
 * `idempotencyKey` across retries.
 *
 * @example
 * ```ts
 * class Subscription extends DurableObject<Env> {
 *   private readonly alarms = new DurabilityAlarms({
 *     context: this.ctx,
 *     handlers: {
 *       renew: async ({ idempotencyKey, signal }) => renew(idempotencyKey, signal),
 *     },
 *   });
 *
 *   scheduleRenewal(at: number) {
 *     return this.alarms.renew(at);
 *   }
 *
 *   alarm(info?: AlarmInvocationInfo) {
 *     return this.alarms.alarm(info);
 *   }
 * }
 * ```
 */
export type DurabilityAlarms<Names extends string> =
  DurabilityAlarmsCore<Names> & Record<Names, DurableNamedAlarm>;

/** Any `DurabilityAlarms` instance, without the index signature of `DurabilityAlarms<string>`. */
export type AnyDurabilityAlarms = DurabilityAlarmsCore<string>;

export interface DurabilityAlarmsConstructor {
  new <const Names extends string>(
    config: DurabilityAlarmsConfig<Names>
  ): DurabilityAlarms<Names>;
  migrate: typeof DurabilityAlarmsCore.migrate;
}

traceMethods(DurabilityAlarmsCore.prototype, 'DurabilityAlarms');

// See Durability: members derived from the handler names cannot be declared on
// the class, so the constructor is typed separately.
export const DurabilityAlarms =
  DurabilityAlarmsCore as unknown as DurabilityAlarmsConstructor;
