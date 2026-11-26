import * as v from 'valibot';
import { traceFunction, traceMethods } from '../dev.js';
import {
  DurableAlarmTimeoutError,
  DurableAttemptsExhaustedError,
  isErrorInstance,
  NonRetryableError,
} from '../errors.js';
import {
  createLifecycleHooks,
  type AlarmLifecycleEntity,
  type DurabilityLifecycleEvent,
  type LifecycleHook,
  type LifecycleHooks,
} from '../lifecycle.js';
import { durabilityNamedAlarmMigrations } from './migrations.js';
import { durabilityMemoMigrations } from '../memoize/migrations.js';
import {
  migrateCapability,
  type DurabilityMigrationResult,
} from '../migrations.js';
import {
  alarmMethodOptionsSchema,
  createPolicyResolver,
  type AlarmMethodPolicy,
  type DurabilityAlarmMethodOptions,
  type ExecutionPolicyOptions,
  type PolicyResolver,
} from '../policy.js';
import { isFunction } from '../predicates.js';
import {
  isAlarmPeriod,
  nextRunAt,
  periodFor,
  recurringAlarmSchema,
  type RecurringAlarm,
  type RecurringAlarmEntry,
} from './every.js';
import {
  assertChannel,
  defaultChannel,
  engineFor,
  type ActiveExecution,
  type Engine,
  type SchedulerAttachment,
} from '../scheduler/index.js';
import {
  createMemoize,
  deleteMemos,
  deleteMemosOfDroppedTable,
  memoizedKeys,
  type DurableMemoize,
} from '../memoize/index.js';
import {
  deleteAttempt,
  listCreated,
  updateAttempt,
  type DurableTable,
} from '../storage.js';
import {
  registerTrackedSource,
  type UntypedRecord,
  type UntypedSource,
} from '../tracker/source.js';

export {
  every,
  type AlarmPeriod,
  type AlarmPeriods,
  type RecurringAlarm,
  type RecurringAlarmInfo,
} from './every.js';

const alarmRowSchema = v.object({
  name: v.string(),
  channel: v.string(),
  generation_id: v.string(),
  status: v.picklist(['pending', 'failed']),
  scheduled_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  next_attempt_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  attempt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  last_error: v.nullable(v.string()),
  last_error_name: v.nullable(v.string()),
  created_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

type AlarmRow = v.InferOutput<typeof alarmRowSchema>;

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
  /** Persists a callback's result by key so a retry of this occurrence reuses it. */
  memoize: DurableMemoize;
  /** Invocation information for the shared physical Durable Object alarm. */
  platform: AlarmInvocationInfo | undefined;
};

/** A handler for one named logical alarm. */
export type DurableAlarmHandler = (
  info: DurableAlarmInfo
) => void | Promise<void>;

const alarmHandlerSchema = v.union([
  v.custom<DurableAlarmHandler>(isFunction),
  recurringAlarmSchema,
]);

const upsertOccurrence = (
  sql: SqlStorage,
  occurrence: {
    channel: string;
    name: string;
    generation: string;
    scheduledTime: number;
    createdAt: number;
  }
): void => {
  sql.exec(
    `INSERT INTO durability_alarms
       (name, channel, generation_id, status, scheduled_at,
        next_attempt_at, attempt, last_error, last_error_name, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, 0, NULL, NULL, ?)
     ON CONFLICT(channel, name) DO UPDATE SET
       generation_id = excluded.generation_id,
       status = excluded.status,
       scheduled_at = excluded.scheduled_at,
       next_attempt_at = excluded.next_attempt_at,
       attempt = excluded.attempt,
       last_error = excluded.last_error,
       last_error_name = excluded.last_error_name,
       created_at = excluded.created_at`,
    occurrence.name,
    occurrence.channel,
    occurrence.generation,
    occurrence.scheduledTime,
    occurrence.scheduledTime,
    occurrence.createdAt
  );
};

// Turns a settled occurrence into the next one in place, so no moment exists
// where a recurring alarm has no row.
const nextOccurrenceAssignments = `generation_id = ?, status = 'pending',
  scheduled_at = ?, next_attempt_at = ?, attempt = 0, last_error = NULL,
  last_error_name = NULL, created_at = ?`;

type ScheduledOccurrence = {
  name: string;
  generation: string;
  scheduledTime: number;
  createdAt: number;
};

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
export type DurabilityAlarmsConfig<
  Names extends string = string,
  Level extends string = never,
> = DurabilityAlarmsOptions<Names> &
  SchedulerAttachment & {
    /**
     * Alarm handlers keyed by the scheduling method names they become. A
     * handler built by {@link every} recurs at the period of the current
     * activity level.
     */
    handlers: Record<
      Names,
      DurableAlarmHandler | RecurringAlarm<NoInfer<Level> | '*'>
    >;
    /**
     * Returns the object's current activity level. Recurring alarms read it
     * when an attempt starts, to skip a level they list no period for, and
     * when it settles, to schedule the next occurrence. It must be
     * synchronous and must not throw.
     */
    activity?: () => Level;
    /**
     * Stable channel ID. Instances on one scheduler share storage,
     * partitioned by channel; alarm names are unique within a channel, and
     * each instance runs, lists and purges only its own. A library should
     * use its own channel so its alarms never meet the application's.
     * Defaults to `default`.
     */
    channel?: string;
  };

/** A lifecycle event for one of this instance's named alarms. */
export type DurabilityAlarmEvent =
  | Extract<DurabilityLifecycleEvent, { entityKind: 'named_alarm' }>
  | Extract<DurabilityLifecycleEvent, { type: 'purged' }>;

/** Schedules (or replaces) the named alarm's pending occurrence. */
export type DurableNamedAlarm = ((scheduledTime: number) => Promise<void>) & {
  /**
   * Experimental. Deletes the alarm's pending occurrence and reconciles the
   * physical alarm, then aborts a running attempt of it. That attempt can no
   * longer retry when it settles, but calling the scheduling method again,
   * including from that handler, schedules a new occurrence. Resolves whether
   * a pending occurrence was deleted.
   */
  cancel: () => Promise<boolean>;
};

const readAlarm = (
  sql: SqlStorage,
  channel: string,
  name: string
): AlarmRow | undefined =>
  v.parse(
    v.optional(alarmRowSchema),
    sql
      .exec(
        'SELECT * FROM durability_alarms WHERE channel = ? AND name = ?',
        channel,
        name
      )
      .toArray()[0]
  );

const alarmRecord = (sql: SqlStorage, row: AlarmRow): UntypedRecord => ({
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
          memoized: memoizedKeys(
            sql,
            { ...alarmsTable, channel: row.channel },
            row.name,
            row.generation_id
          ),
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

class DurabilityAlarmsCore<Names extends string, Level extends string = never> {
  readonly #engine: Engine;
  readonly #channel: string;
  readonly #table: DurableTable;
  readonly #handlers = new Map<string, DurableAlarmHandler>();
  readonly #recurring = new Map<string, RecurringAlarmEntry>();
  readonly #activity: (() => string) | undefined;
  readonly #policy: PolicyResolver<AlarmMethodPolicy>;
  readonly #lifecycle: LifecycleHooks;
  readonly #emit: LifecycleHooks['emit'];
  readonly #active = new Map<string, ActiveExecution>();

  constructor(config: DurabilityAlarmsConfig<Names, Level>) {
    this.#channel = assertChannel(
      'DurabilityAlarms',
      config.channel ?? defaultChannel
    );
    this.#table = { ...alarmsTable, channel: this.#channel };
    this.#engine = engineFor(config);
    this.#activity = v.parse(
      v.optional(v.custom<() => string>(isFunction)),
      config.activity
    );

    const methods: NonNullable<DurabilityAlarmsOptions['methods']> = {
      ...config.methods,
    };

    for (const [name, value] of Object.entries<unknown>(config.handlers)) {
      const handler = v.parse(alarmHandlerSchema, value);

      if (isFunction(handler)) {
        this.#handlers.set(name, handler);
        continue;
      }

      this.#addRecurring(name, handler, methods);
    }

    this.#policy = createPolicyResolver(
      config,
      methods,
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

    for (const name of Object.keys(config.handlers)) {
      if (reserved.has(name)) {
        throw new Error(`"${name}" is reserved by DurabilityAlarms`);
      }

      const method = Object.assign(
        traceFunction(`DurabilityAlarms.${name}`, (scheduledTime: number) =>
          this.#schedule(name, scheduledTime)
        ),
        {
          cancel: traceFunction(`DurabilityAlarms.${name}.cancel`, () =>
            this.#cancel(name)
          ),
        }
      );

      Object.defineProperty(this, name, {
        value: method,
        enumerable: true,
      });
    }

    this.#engine.migrateSchema('namedAlarms', durabilityNamedAlarmMigrations);
    this.#engine.migrateSchema('memos', durabilityMemoMigrations);
    this.#engine.registerChannel({
      table: this.#table,
      channel: this.#channel,
      helper: 'DurabilityAlarms',
      runDue: (now, info) => this.#runDue(now, info),
    });
    registerTrackedSource(this, this.#trackedSource());
  }

  /** Applies or reverts the `durability_alarms` schema; see {@link migrateCapability}. */
  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ): DurabilityMigrationResult {
    const result = migrateCapability(
      context.storage,
      'namedAlarms',
      durabilityNamedAlarmMigrations,
      target
    );

    deleteMemosOfDroppedTable(context.storage.sql, alarmsTable);

    return result;
  }

  #addRecurring(
    name: string,
    recurring: v.InferOutput<typeof recurringAlarmSchema>,
    methods: NonNullable<DurabilityAlarmsOptions['methods']>
  ): void {
    const { periods, run, options } = recurring;

    const listsLevels =
      !isAlarmPeriod(periods) &&
      Object.keys(periods).some((level) => level !== '*');

    if (listsLevels && this.#activity === undefined) {
      throw new TypeError(
        `Named alarm "${name}" lists activity levels but no activity is configured`
      );
    }

    if (options !== undefined) {
      if (methods[name] !== undefined) {
        throw new TypeError(
          `Named alarm "${name}" sets options in both every() and methods`
        );
      }

      methods[name] = options;
    }

    this.#recurring.set(name, {
      periods: isAlarmPeriod(periods)
        ? periods
        : new Map(Object.entries(periods)),
      run,
    });
  }

  /** Runs due named alarms and re-arms the physical alarm. */
  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#engine.alarm(info);
  }

  /**
   * Moves recurring alarms earlier to the periods of `level`, after state
   * changed that `activity` will report on. A pending occurrence that is
   * already sooner, running, or waiting to retry keeps its time; a missing or
   * failed one is scheduled. It never moves an occurrence later: the next
   * settlement reads `activity` and schedules from the level it reports.
   */
  async raiseActivity(level: Level): Promise<void> {
    if (this.#activity === undefined) {
      throw new TypeError('raiseActivity requires the activity option');
    }

    const now = Date.now();

    const scheduled = await this.#engine.transaction((sql) => {
      const changes: (ScheduledOccurrence & { replaced: boolean })[] = [];

      for (const [name, { periods }] of this.#recurring) {
        const period = periodFor(periods, level);

        if (period === undefined) {
          continue;
        }

        const change = this.#scheduleNoLaterThan(
          sql,
          name,
          nextRunAt(period, now),
          now
        );

        if (change !== undefined) {
          changes.push(change);
        }
      }

      return changes;
    });

    for (const occurrence of scheduled) {
      if (occurrence.replaced) {
        this.#engine.notify(this.#table, occurrence.name);
      }

      this.#emitScheduled(occurrence);
    }
  }

  /** Leaves an occurrence that is sooner, running, or waiting to retry alone. */
  #scheduleNoLaterThan(
    sql: SqlStorage,
    name: string,
    scheduledTime: number,
    now: number
  ): (ScheduledOccurrence & { replaced: boolean }) | undefined {
    const row = readAlarm(sql, this.#channel, name);

    if (row?.status === 'pending') {
      if (row.attempt > 0 || row.next_attempt_at <= scheduledTime) {
        return undefined;
      }

      sql.exec(
        `UPDATE durability_alarms SET scheduled_at = ?, next_attempt_at = ?
         WHERE channel = ? AND name = ? AND generation_id = ?`,
        scheduledTime,
        scheduledTime,
        this.#channel,
        name,
        row.generation_id
      );

      return {
        name,
        generation: row.generation_id,
        scheduledTime,
        createdAt: now,
        replaced: false,
      };
    }

    const generation = crypto.randomUUID();
    upsertOccurrence(sql, {
      channel: this.#channel,
      name,
      generation,
      scheduledTime,
      createdAt: now,
    });
    deleteMemos(sql, this.#table, name);

    return {
      name,
      generation,
      scheduledTime,
      createdAt: now,
      replaced: row !== undefined,
    };
  }

  /**
   * Attaches a best-effort lifecycle hook alongside `onLifecycleEvent` and
   * returns a function that detaches it.
   */
  lifecycle(
    hook: (event: DurabilityAlarmEvent) => void | Promise<void>
  ): () => void {
    // SAFETY: every event this instance emits, from scheduling, alarmEntity
    // attempts, and purges, has entityKind 'named_alarm'.
    return this.#lifecycle.add(hook as LifecycleHook);
  }

  /**
   * Destructively removes named alarm records created strictly before the
   * timestamp, regardless of status, and returns how many were removed.
   */
  async purgeBefore(before: number): Promise<number> {
    const count = await this.#engine.purge(
      this.#table,
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
        const row = readAlarm(sql, this.#channel, name);

        return row && alarmRecord(sql, row);
      },
      list: async ({ limit, cursor, status, name }) => {
        const page = listCreated(sql, this.#table, 'name', {
          limit,
          after: cursor,
          status,
          name,
        });

        const records = v
          .parse(v.array(alarmRowSchema), page.rows)
          .map((row) => alarmRecord(sql, row));

        return page.next === undefined
          ? { records }
          : { records, cursor: page.next };
      },
      watch: (name, listener) => {
        return this.#engine.watch(this.#table, name, (completed) => {
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
        });
      },
    };
  }

  async #runDue(
    now: number,
    info: AlarmInvocationInfo | undefined
  ): Promise<void> {
    const due = v.parse(
      v.array(alarmRowSchema),
      this.#engine.sql
        .exec(
          `SELECT * FROM durability_alarms
             WHERE channel = ? AND status = 'pending' AND next_attempt_at <= ?
             ORDER BY next_attempt_at ASC
             LIMIT 100`,
          this.#channel,
          now
        )
        .toArray()
    );

    // With liveTimers a running occurrence re-arms itself when it settles, so
    // skipping it keeps a long handler from blocking a concurrent alarm pass.
    const pending = this.#engine.liveTimers
      ? due.filter((row) => !this.#active.has(row.name))
      : due;

    const failures: unknown[] = [];
    await this.#engine.runConcurrent(pending, async (row) => {
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

    const key = name;
    const generation = crypto.randomUUID();
    const createdAt = Date.now();
    await this.#engine.transaction((sql) => {
      upsertOccurrence(sql, {
        channel: this.#channel,
        name: key,
        generation,
        scheduledTime,
        createdAt,
      });
      // Memoized results belong to the replaced occurrence, never to the new one.
      deleteMemos(sql, this.#table, key);
    });
    // A waiter on the replaced occurrence resolves now instead of at its timeout.
    this.#engine.notify(this.#table, key);
    this.#emitScheduled({ name, generation, scheduledTime, createdAt });
  }

  #emitScheduled(occurrence: ScheduledOccurrence): void {
    this.#emit({
      type: 'scheduled',
      entityKind: 'named_alarm',
      alarm: occurrence.name,
      id: occurrence.name,
      generation: occurrence.generation,
      timestamp: occurrence.createdAt,
      attempt: 0,
      scheduledTime: occurrence.scheduledTime,
    });
  }

  #nextRunAt(name: string, now: number): number | undefined {
    const recurring = this.#recurring.get(name);

    if (recurring === undefined) {
      return undefined;
    }

    const period = periodFor(recurring.periods, this.#activity?.());

    return period === undefined ? undefined : nextRunAt(period, now);
  }

  async #cancel(name: string): Promise<boolean> {
    const key = name;

    const cancelled = await this.#engine.transaction((sql) => {
      const removed =
        sql
          .exec(
            `DELETE FROM durability_alarms
             WHERE channel = ? AND name = ? AND status = 'pending'
             RETURNING name`,
            this.#channel,
            key
          )
          .toArray().length > 0;

      if (removed) {
        deleteMemos(sql, this.#table, key);
      }

      return removed;
    });

    if (!cancelled) {
      return false;
    }

    // Every settlement write is conditional on the deleted row, so a running
    // attempt can no longer retry; abort it as purging does.
    this.#active
      .get(key)
      ?.controller?.abort(new Error(`Durable alarm "${name}" was cancelled`));
    this.#engine.notify(this.#table, key);

    return true;
  }

  #invoke(
    row: AlarmRow,
    attempt: number,
    signal: AbortSignal,
    platform: AlarmInvocationInfo | undefined
  ): void | Promise<void> {
    const name = row.name;

    const alarmInfo: DurableAlarmInfo = {
      name,
      scheduledTime: row.scheduled_at,
      attempt,
      isRetry: attempt > 1,
      retryCount: attempt - 1,
      idempotencyKey: `durability-alarm:v1:${row.generation_id}`,
      signal,
      memoize: createMemoize(this.#engine.sql, this.#table, {
        key: name,
        generation: row.generation_id,
        attempt,
      }),
      platform,
    };

    const recurring = this.#recurring.get(name);

    if (recurring !== undefined) {
      const level = this.#activity?.();

      if (periodFor(recurring.periods, level) === undefined) {
        return undefined;
      }

      return recurring.run({ ...alarmInfo, level });
    }

    const handler = this.#handlers.get(name);

    if (!handler) {
      throw new NonRetryableError(
        `No named alarm handler registered for "${name}"`
      );
    }

    return handler(alarmInfo);
  }

  /**
   * One name never has more than one attempt in progress in this instance. A
   * handler whose attempt timed out may still be running beside the next one.
   */
  async #execute(
    row: AlarmRow,
    platform: AlarmInvocationInfo | undefined
  ): Promise<void> {
    const running = this.#active.get(row.name);

    if (running) {
      return running.settled;
    }

    const name = row.name;
    const policy = this.#policy(name);
    const retryTimeouts = policy.method?.retryTimeouts ?? false;
    let next: ScheduledOccurrence | undefined;

    const replaceWithNextOccurrence = (
      replace: (
        generation: string,
        scheduledTime: number,
        createdAt: number
      ) => boolean
    ): boolean => {
      const createdAt = Date.now();
      const scheduledTime = this.#nextRunAt(name, createdAt);

      if (scheduledTime === undefined) {
        return false;
      }

      const generation = crypto.randomUUID();

      if (!replace(generation, scheduledTime, createdAt)) {
        return false;
      }

      next = { name, generation, scheduledTime, createdAt };

      return true;
    };

    const execution = this.#engine.startExecution({
      table: this.#table,
      key: row.name,
      row,
      label: `named alarm "${name}"`,
      entity: alarmEntity(row),
      active: this.#active,
      policy,
      emit: this.#emit,
      exhaustedError: () =>
        new DurableAttemptsExhaustedError(
          'named alarm',
          name,
          policy.maxAttempts
        ),
      timeoutError: () =>
        new DurableAlarmTimeoutError(name, policy.attemptTimeoutMs),
      invoke: (attempt, signal) => this.#invoke(row, attempt, signal, platform),
      complete: (_result, attempt) => {
        const timestamp = Date.now();
        const sql = this.#engine.sql;

        const ref = {
          key: row.name,
          generation: row.generation_id,
          attempt,
        };

        const replaced = replaceWithNextOccurrence(
          (generation, scheduledTime, createdAt) =>
            updateAttempt(
              sql,
              this.#table,
              ref,
              nextOccurrenceAssignments,
              generation,
              scheduledTime,
              scheduledTime,
              createdAt
            )
        );

        if (replaced) {
          return timestamp;
        }

        return deleteAttempt(sql, this.#table, ref) ? timestamp : undefined;
      },
      // A recurring alarm keeps its cadence: the next occurrence replaces the
      // failed one, whose error stays in the lifecycle events.
      failed: (sql) => {
        replaceWithNextOccurrence(
          (generation, scheduledTime, createdAt) =>
            sql
              .exec(
                `UPDATE durability_alarms SET ${nextOccurrenceAssignments}
                 WHERE channel = ? AND name = ? AND generation_id = ?
                 RETURNING name`,
                generation,
                scheduledTime,
                scheduledTime,
                createdAt,
                this.#channel,
                name,
                row.generation_id
              )
              .toArray().length > 0
        );
      },
      isTerminal: (error) =>
        isErrorInstance(error, DurableAlarmTimeoutError) && !retryTimeouts,
    });

    await execution;

    // A rolled-back settlement or a later replacement leaves another
    // generation in the row, and that one reports its own scheduling.
    if (
      next !== undefined &&
      readAlarm(this.#engine.sql, this.#channel, name)?.generation_id ===
        next.generation
    ) {
      this.#emitScheduled(next);
    }
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
export type DurabilityAlarms<
  Names extends string,
  Level extends string = never,
> = DurabilityAlarmsCore<Names, Level> & Record<Names, DurableNamedAlarm>;

/** Any `DurabilityAlarms` instance, without the index signature of `DurabilityAlarms<string>`. */
export type AnyDurabilityAlarms = DurabilityAlarmsCore<string, string>;

export interface DurabilityAlarmsConstructor {
  new <const Names extends string, const Level extends string = never>(
    config: DurabilityAlarmsConfig<Names, Level>
  ): DurabilityAlarms<Names, Level>;
  migrate: typeof DurabilityAlarmsCore.migrate;
}

traceMethods(DurabilityAlarmsCore.prototype, 'DurabilityAlarms');

// SAFETY: the constructor defines a scheduling method for every handler name on
// the instance, members TypeScript cannot declare from a generic name union.
export const DurabilityAlarms =
  DurabilityAlarmsCore as DurabilityAlarmsConstructor;
