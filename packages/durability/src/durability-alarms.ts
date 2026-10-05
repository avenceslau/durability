import { z } from 'zod';
import {
  DurableAlarmTimeoutError,
  DurableAttemptsExhaustedError,
  isErrorInstance,
  NonRetryableError,
} from './errors.js';
import {
  type AlarmLifecycleEntity,
  type Emit,
  type LifecycleHook,
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
import type { AlarmRow } from './storage.js';

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

/** Schedules (or replaces) the named alarm's pending occurrence. */
export type DurableNamedAlarm = (scheduledTime: number) => Promise<void>;

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
  readonly #emit: Emit;
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
    this.#emit = this.#engine.emitter(config.onLifecycleEvent);

    const reserved = new Set(
      Object.getOwnPropertyNames(DurabilityAlarmsCore.prototype)
    );
    for (const name of this.#handlers.keys()) {
      if (reserved.has(name)) {
        throw new Error(`"${name}" is reserved by DurabilityAlarms`);
      }
      Object.defineProperty(this, name, {
        value: (scheduledTime: number) => this.#schedule(name, scheduledTime),
        enumerable: true,
      });
    }

    this.#engine.migrateSchema('namedAlarms', durabilityNamedAlarmMigrations);
    this.#engine.register({
      kind: 'alarms',
      runDue: (now, info) => this.#runDue(now, info),
    });
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
   * Destructively removes named alarm records created strictly before the
   * timestamp, regardless of status, and returns how many were removed.
   */
  async purgeBefore(before: number): Promise<number> {
    const count = await this.#engine.purge(
      'alarms',
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

  async #runDue(
    now: number,
    info: AlarmInvocationInfo | undefined
  ): Promise<void> {
    const due = await this.#engine.storage.alarms.listDue(now, 100);
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
    await this.#engine.transaction(async (transaction) => {
      await transaction.alarms.upsert({
        name,
        generation_id: generation,
        status: 'pending',
        scheduled_at: scheduledTime,
        next_attempt_at: scheduledTime,
        attempt: 0,
        last_error: null,
        last_error_name: null,
        created_at: createdAt,
      });
      await this.#engine.reconcile(transaction);
    });
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
      kind: 'alarms',
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
      complete: async (_result, attempt) => {
        const timestamp = Date.now();
        const removed = await this.#engine.storage.alarms.remove(
          row.name,
          row.generation_id,
          attempt
        );
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

export interface DurabilityAlarmsConstructor {
  new <const Names extends string>(
    config: DurabilityAlarmsConfig<Names>
  ): DurabilityAlarms<Names>;
  migrate: typeof DurabilityAlarmsCore.migrate;
}

// See Durability: members derived from the handler names cannot be declared on
// the class, so the constructor is typed separately.
export const DurabilityAlarms =
  DurabilityAlarmsCore as unknown as DurabilityAlarmsConstructor;
