import { z } from 'zod';
import { traceLifecycle, traceMethods } from './dev.js';
import {
  reportFailure,
  ScheduledOutcomeTimeoutError,
  ScheduledRunInterruptedError,
  ScheduledRunTimeoutError,
  serializeError,
  type SerializedError,
} from './errors.js';
import {
  durabilityScheduleMigrations,
  migrateCapability,
  type DurabilityMigrationResult,
} from './migrations.js';
import {
  assertPositiveInteger,
  type DurabilityRetryOptions,
} from './policy.js';
import {
  engineFor,
  type Engine,
  type SchedulerAttachment,
} from './scheduler.js';
import type { DurableTable } from './storage.js';
import { exponential, jitter } from './utils.js';

const runsTable: DurableTable = {
  name: 'durability_schedule_runs',
  key: 'scheduled_time',
};

// setTimeout overflows past 2^31 - 1 ms.
const maxDelayMs = 2 ** 31 - 1;
const fallbackRetryMs = 60_000;

const scheduleRowSchema = z.object({
  version: z.number().int().nonnegative(),
  expression: z.string().nullable(),
  next_at: z.number().int().nonnegative().nullable(),
});

const runStateSchema = z.enum(['queued', 'running', 'complete', 'errored']);

const runRowSchema = z.object({
  scheduled_time: z.number().int().nonnegative(),
  state: runStateSchema,
  next_at: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  error: z.string().nullable(),
});

type RunRow = z.infer<typeof runRowSchema>;

const timeRowSchema = z.object({
  scheduled_time: z.number().int().nonnegative(),
});
const timedRowSchema = z.object({
  scheduled_time: z.number().int().nonnegative(),
  next_at: z.number().int().nonnegative(),
});
const serializedErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
});

/** A schedule as passed to {@link DurabilitySchedule.set}. */
export type ScheduleDefinition = {
  /** Opaque to durability: only `nextOccurrence` interprets it. */
  expression: string;
  /**
   * Orders updates: `set` stores only a version higher than the stored one,
   * and the same version only re-arms a lost alarm.
   */
  version: number;
};

/** The stored schedule returned by {@link DurabilitySchedule.get}. */
export type ScheduleState = ScheduleDefinition & {
  /** The next tick, or `undefined` once `nextOccurrence` returned none. */
  nextAt: number | undefined;
};

/** One tick's run. */
export type ScheduledRun = {
  /** The tick time the run belongs to. */
  scheduledTime: number;
  /**
   * `<objectId>:<scheduledTime>`, or the bare scheduled time when the context
   * has no object ID. A tick fires at most once, so the key is unique per run.
   */
  idempotencyKey: string;
};

/** What `run` receives. */
export type ScheduledRunContext = ScheduledRun & {
  /** Aborted when the run exceeds `runTimeoutMs`. */
  signal: AbortSignal;
};

/** What a run ended with, as passed to `onOutcome`. */
export type ScheduledRunOutcome =
  | { status: 'complete' }
  | { status: 'errored'; error: SerializedError };

/** The run an `onOutcome` call reports. */
export type ScheduledOutcomeDelivery = ScheduledRun & {
  /** One-based delivery attempt of this outcome. */
  attempt: number;
};

type ScheduledRunEntity = {
  entityKind: 'scheduled_run';
  /** The run's idempotency key. */
  id: string;
  scheduledTime: number;
  timestamp: number;
};

/** Best-effort lifecycle signal for one scheduled run. */
export type DurabilityScheduleEvent = ScheduledRunEntity &
  (
    | {
        /** A tick recorded the run; `queued` when no run slot was free. */
        type: 'due';
        queued: boolean;
      }
    | { type: 'started' }
    | {
        /**
         * The outcome was recorded. An interrupted run has no `durationMs` and
         * a `ScheduledRunInterruptedError`.
         */
        type: 'settled';
        outcome: ScheduledRunOutcome['status'];
        error?: SerializedError;
        durationMs?: number;
      }
    | {
        type: 'outcome_retry';
        attempt: number;
        error: SerializedError;
        nextAttemptAt: number;
      }
    | {
        /** `onOutcome` failed `maxAttempts` times; the run's row is deleted. */
        type: 'dead_lettered';
        attempt: number;
        error: SerializedError;
      }
  );

export type DurabilityScheduleConfig = SchedulerAttachment & {
  /**
   * Returns the first tick strictly after `after`, or `undefined` for none.
   * Must be synchronous and deterministic; durability ships no cron parser.
   */
  nextOccurrence(expression: string, after: number): number | undefined;
  /** The work of one tick. Throwing or timing out makes the run `errored`. */
  run(run: ScheduledRunContext): unknown;
  /**
   * Receives each run's outcome at least once. Returning acknowledges it and
   * deletes the run's row; throwing retries it with `outcomeRetries`.
   */
  onOutcome(
    run: ScheduledOutcomeDelivery,
    outcome: ScheduledRunOutcome
  ): unknown;
  /** Runs in flight at once; later runs wait durably in order. Defaults to 10. */
  maxConcurrentRuns?: number;
  /** Maximum duration of one run. Defaults to 15 minutes. */
  runTimeoutMs?: number;
  /** Maximum duration of one `onOutcome` call. Defaults to 60 seconds. */
  outcomeTimeoutMs?: number;
  /** `onOutcome` retries. `maxAttempts` defaults to 10, counting the first. */
  outcomeRetries?: DurabilityRetryOptions;
  onLifecycleEvent?: (event: DurabilityScheduleEvent) => void | Promise<void>;
};

type StoredSchedule = z.infer<typeof scheduleRowSchema>;

const readSchedule = (sql: SqlStorage): StoredSchedule | undefined =>
  scheduleRowSchema
    .optional()
    .parse(
      sql
        .exec(
          'SELECT version, expression, next_at FROM durability_schedule WHERE id = 1'
        )
        .toArray()[0]
    );

const writeSchedule = (
  sql: SqlStorage,
  version: number,
  expression: string | null,
  nextAt: number | null
): void => {
  sql.exec(
    `INSERT INTO durability_schedule (id, version, expression, next_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       version = excluded.version,
       expression = excluded.expression,
       next_at = excluded.next_at`,
    version,
    expression,
    nextAt
  );
};

const scheduledTimes = (cursor: { toArray(): unknown[] }): number[] =>
  timeRowSchema
    .array()
    .parse(cursor.toArray())
    .map((row) => row.scheduled_time);

const outcomeOf = (row: RunRow): ScheduledRunOutcome =>
  row.state === 'errored'
    ? {
        status: 'errored',
        error: serializedErrorSchema.parse(JSON.parse(row.error ?? '{}')),
      }
    : { status: 'complete' };

const assertVersion = (version: number): void => {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError(
      'Schedule version must be a non-negative safe integer'
    );
  }
};

const assertDelay = (name: string, value: number): void => {
  assertPositiveInteger(name, value);
  if (value > maxDelayMs) {
    throw new RangeError(`${name} must be at most ${maxDelayMs}`);
  }
};

const deadline = async (
  work: Promise<unknown>,
  timeoutMs: number,
  onTimeout: () => Error
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

/**
 * Experimental. One recurring schedule per Durable Object whose ticks start
 * individually tracked, overlapping runs and report each run's outcome once,
 * keeping a run's row only until its outcome is delivered.
 *
 * A tick inserts its run in the transaction that advances the stored next
 * tick, so a tick fires at most once without retaining finished runs. Missed
 * ticks collapse into one run for the earliest missed time.
 */
export class DurabilitySchedule {
  readonly #engine: Engine;
  readonly #nextOccurrence: DurabilityScheduleConfig['nextOccurrence'];
  readonly #run: DurabilityScheduleConfig['run'];
  readonly #onOutcome: DurabilityScheduleConfig['onOutcome'];
  readonly #maxConcurrentRuns: number;
  readonly #runTimeoutMs: number;
  readonly #outcomeTimeoutMs: number;
  readonly #maxOutcomeAttempts: number;
  readonly #delay: (attempt: number) => number;
  readonly #keyPrefix: string;
  readonly #emit: (event: DurabilityScheduleEvent) => void;
  /** Runs holding a slot: marked running and not yet settled in this instance. */
  readonly #active = new Set<number>();
  readonly #delivering = new Set<number>();
  /** The loop that keeps an alarm invocation open while work is in flight. */
  #loop: Promise<void> | undefined;
  #woken = false;
  #wakeSleeper: (() => void) | undefined;

  constructor(config: DurabilityScheduleConfig) {
    for (const name of ['nextOccurrence', 'run', 'onOutcome'] as const) {
      if (typeof config[name] !== 'function') {
        throw new TypeError(`Schedule requires a ${name} function`);
      }
    }
    this.#nextOccurrence = config.nextOccurrence;
    this.#run = config.run;
    this.#onOutcome = config.onOutcome;
    this.#maxConcurrentRuns = config.maxConcurrentRuns ?? 10;
    assertPositiveInteger('maxConcurrentRuns', this.#maxConcurrentRuns);
    this.#runTimeoutMs = config.runTimeoutMs ?? 15 * 60_000;
    assertDelay('runTimeoutMs', this.#runTimeoutMs);
    this.#outcomeTimeoutMs = config.outcomeTimeoutMs ?? 60_000;
    assertDelay('outcomeTimeoutMs', this.#outcomeTimeoutMs);
    this.#maxOutcomeAttempts = config.outcomeRetries?.maxAttempts ?? 10;
    assertPositiveInteger(
      'outcomeRetries.maxAttempts',
      this.#maxOutcomeAttempts
    );
    this.#delay =
      config.outcomeRetries?.delay ??
      ((attempt) => jitter(exponential(attempt)));

    this.#engine = engineFor(config);
    const objectId = this.#engine.objectId();
    this.#keyPrefix = objectId === undefined ? '' : `${objectId}:`;
    this.#emit = traceLifecycle(
      this.#engine.emitter<DurabilityScheduleEvent>(config.onLifecycleEvent)
    );
    this.#engine.migrateSchema('schedule', durabilityScheduleMigrations);
    this.#engine.register({
      table: runsTable,
      runDue: () => this.#hold(),
      nextPendingAt: (sql) => this.#nextPendingAt(sql),
      holding: () => this.#loop !== undefined,
    });
  }

  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ): DurabilityMigrationResult {
    return migrateCapability(
      context.storage,
      'schedule',
      durabilityScheduleMigrations,
      target
    );
  }

  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#engine.alarm(info);
  }

  /** The stored schedule, or `undefined` when none is set or it was cancelled. */
  get(): ScheduleState | undefined {
    const stored = readSchedule(this.#engine.sql);
    if (stored === undefined || stored.expression === null) {
      return undefined;
    }

    return {
      expression: stored.expression,
      version: stored.version,
      nextAt: stored.next_at ?? undefined,
    };
  }

  /**
   * Stores the schedule and its next tick when `version` is higher than the
   * stored one, and resolves `true` when it did. A lower version is ignored; the
   * same version changes nothing but re-arms the alarm if it was lost.
   */
  async set(definition: ScheduleDefinition): Promise<boolean> {
    const { expression, version } = definition;
    if (typeof expression !== 'string' || expression.length === 0) {
      throw new TypeError('Schedule expression must be a non-empty string');
    }
    assertVersion(version);

    // Even a no-op transaction reconciles the physical alarm.
    const applied = await this.#engine.transaction((sql) => {
      const stored = readSchedule(sql);
      if (stored !== undefined && stored.version >= version) {
        return false;
      }
      const nextAt = this.#nextAfter(expression, Date.now());
      writeSchedule(sql, version, expression, nextAt ?? null);
      return true;
    });
    this.#wake();
    return applied;
  }

  /**
   * Stops future ticks and resolves `true` when a schedule was live. Runs
   * already due or running still finish and report. With `version`, the
   * cancellation is ignored when the stored version is higher, and is
   * otherwise recorded so a later `set` of that version or lower is ignored.
   */
  async cancel(version?: number): Promise<boolean> {
    if (version !== undefined) {
      assertVersion(version);
    }

    return this.#engine.transaction((sql) => {
      const stored = readSchedule(sql);
      const live = stored !== undefined && stored.expression !== null;
      if (version === undefined && !live) {
        return false;
      }
      if (
        version !== undefined &&
        stored !== undefined &&
        stored.version > version
      ) {
        return false;
      }
      writeSchedule(sql, version ?? stored?.version ?? 0, null, null);
      return live;
    });
  }

  /**
   * A run or delivery this instance holds needs the physical alarm only as its
   * eviction fallback, which the next tick already provides. Counting it only
   * when nothing else is pending keeps a run to one alarm write, instead of
   * arming a fallback when it starts and re-arming the next tick when it ends.
   */
  #nextPendingAt(sql: SqlStorage): number | undefined {
    const rows = timedRowSchema
      .array()
      .parse(
        sql
          .exec('SELECT scheduled_time, next_at FROM durability_schedule_runs')
          .toArray()
      );
    const held: number[] = [];
    const pending: number[] = [];
    for (const row of rows) {
      if (
        this.#active.has(row.scheduled_time) ||
        this.#delivering.has(row.scheduled_time)
      ) {
        held.push(row.next_at);
      } else {
        pending.push(row.next_at);
      }
    }
    const tick = readSchedule(sql)?.next_at;
    if (tick !== undefined && tick !== null) {
      pending.push(tick);
    }

    if (pending.length > 0) {
      return Math.min(...pending);
    }
    return held.length === 0 ? undefined : Math.min(...held);
  }

  #nextAfter(expression: string, after: number): number | undefined {
    const next = this.#nextOccurrence(expression, after);
    if (next === undefined) {
      return undefined;
    }
    if (!Number.isSafeInteger(next) || next <= after) {
      throw new RangeError(
        `nextOccurrence must return undefined or a safe integer after ${after}, got ${String(next)}`
      );
    }
    return next;
  }

  #describe(scheduledTime: number): ScheduledRun {
    return {
      scheduledTime,
      idempotencyKey: `${this.#keyPrefix}${scheduledTime}`,
    };
  }

  #entity(run: ScheduledRun): ScheduledRunEntity {
    return {
      entityKind: 'scheduled_run',
      id: run.idempotencyKey,
      scheduledTime: run.scheduledTime,
      timestamp: Date.now(),
    };
  }

  /**
   * The scheduler's alarm pass for this capability. While runs or deliveries
   * are in flight it stays pending, so the alarm invocation that called it
   * keeps the object in memory; the scheduler hands off to a fresh alarm before
   * the wall-time limit, and that alarm joins the same loop.
   */
  #hold(): Promise<void> {
    this.#wake();
    if (this.#loop) {
      return this.#loop;
    }

    const loop = this.#drive().finally(() => {
      if (this.#loop === loop) {
        this.#loop = undefined;
      }
      // A loop that outlived its alarm invocation republishes the in-memory
      // timer it suppressed while holding.
      void this.#engine
        .scheduleNextAlarm()
        .catch((error) =>
          reportFailure('durability.schedule.refresh_failed', {}, error)
        );
    });
    this.#loop = loop;
    return loop;
  }

  async #drive(): Promise<void> {
    for (;;) {
      this.#woken = false;
      // eslint-disable-next-line no-await-in-loop
      await this.#pass();
      if (this.#active.size === 0 && this.#delivering.size === 0) {
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.#sleep(this.#nextWakeAt());
    }
  }

  async #pass(): Promise<void> {
    await this.#interruptOrphans();
    this.#deliverDue();
    try {
      await this.#tick();
    } finally {
      await this.#startQueued();
    }
  }

  #wake(): void {
    this.#woken = true;
    this.#wakeSleeper?.();
  }

  async #sleep(until: number | undefined): Promise<void> {
    if (this.#woken) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => {
        this.#wakeSleeper = resolve;
        if (until !== undefined) {
          const delay = Math.min(Math.max(until - Date.now(), 0), maxDelayMs);
          timer = setTimeout(resolve, delay);
        }
      });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      this.#wakeSleeper = undefined;
    }
  }

  /** The next time the loop has timed work: a tick or an outcome retry. */
  #nextWakeAt(): number | undefined {
    const sql = this.#engine.sql;
    const times = runRowSchema
      .array()
      .parse(
        sql
          .exec(
            `SELECT * FROM durability_schedule_runs
             WHERE state IN ('complete', 'errored')`
          )
          .toArray()
      )
      .filter((row) => !this.#delivering.has(row.scheduled_time))
      .map((row) => row.next_at);
    const tick = readSchedule(sql)?.next_at;
    if (tick !== undefined && tick !== null) {
      times.push(tick);
    }
    return times.length === 0 ? undefined : Math.min(...times);
  }

  /**
   * A row marked running that no slot in this instance holds outlived the
   * instance that started it, so it is reported as errored instead of re-run.
   */
  async #interruptOrphans(): Promise<void> {
    const orphans = (sql: SqlStorage): number[] =>
      scheduledTimes(
        sql.exec(
          `SELECT scheduled_time FROM durability_schedule_runs
           WHERE state = 'running'`
        )
      ).filter((time) => !this.#active.has(time));
    if (orphans(this.#engine.sql).length === 0) {
      return;
    }

    const error = serializeError(new ScheduledRunInterruptedError());
    const interrupted = await this.#engine.transaction((sql) => {
      const times = orphans(sql);
      const now = Date.now();
      for (const time of times) {
        sql.exec(
          `UPDATE durability_schedule_runs
           SET state = 'errored', error = ?, next_at = ?, attempt = 0
           WHERE scheduled_time = ?`,
          JSON.stringify(error),
          now,
          time
        );
      }
      return times;
    });
    for (const time of interrupted) {
      this.#emit({
        ...this.#entity(this.#describe(time)),
        type: 'settled',
        outcome: 'errored',
        error,
      });
    }
  }

  async #tick(): Promise<void> {
    const stored = readSchedule(this.#engine.sql);
    if (
      stored?.next_at === undefined ||
      stored.next_at === null ||
      stored.next_at > Date.now()
    ) {
      return;
    }

    const due = await this.#reserveSlots((sql, free) => {
      const schedule = readSchedule(sql);
      const now = Date.now();
      if (
        schedule === undefined ||
        schedule.expression === null ||
        schedule.next_at === null ||
        schedule.next_at > now
      ) {
        return { reserve: [], result: undefined };
      }

      const scheduledTime = schedule.next_at;
      const nextAt = this.#nextAfter(
        schedule.expression,
        Math.max(scheduledTime, now)
      );
      sql.exec(
        'UPDATE durability_schedule SET next_at = ? WHERE id = 1',
        nextAt ?? null
      );
      const queued = free <= 0;
      const inserted = scheduledTimes(
        sql.exec(
          `INSERT INTO durability_schedule_runs (scheduled_time, state, next_at)
           VALUES (?, ?, ?)
           ON CONFLICT DO NOTHING
           RETURNING scheduled_time`,
          scheduledTime,
          queued ? 'queued' : 'running',
          queued ? scheduledTime : now
        )
      );
      if (inserted.length === 0) {
        return { reserve: [], result: undefined };
      }
      return {
        reserve: queued ? [] : inserted,
        result: { scheduledTime, queued },
      };
    });
    if (due === undefined) {
      return;
    }

    this.#emit({
      ...this.#entity(this.#describe(due.scheduledTime)),
      type: 'due',
      queued: due.queued,
    });
    if (!due.queued) {
      this.#start(due.scheduledTime);
    }
  }

  async #startQueued(): Promise<void> {
    if (this.#active.size >= this.#maxConcurrentRuns) {
      return;
    }
    const queued = this.#engine.sql
      .exec(
        "SELECT 1 FROM durability_schedule_runs WHERE state = 'queued' LIMIT 1"
      )
      .toArray();
    if (queued.length === 0) {
      return;
    }

    const started = await this.#reserveSlots((sql, free) => {
      const times =
        free <= 0
          ? []
          : scheduledTimes(
              sql.exec(
                `UPDATE durability_schedule_runs
               SET state = 'running', next_at = ?
               WHERE scheduled_time IN (
                 SELECT scheduled_time FROM durability_schedule_runs
                 WHERE state = 'queued'
                 ORDER BY scheduled_time
                 LIMIT ?
               )
               RETURNING scheduled_time`,
                Date.now(),
                free
              )
            );
      return { reserve: times, result: times };
    });
    for (const time of started.sort((a, b) => a - b)) {
      this.#start(time);
    }
  }

  /**
   * Runs `mark`, which marks runs running and returns them in `reserve`, in a
   * transaction that reserves their slots before it commits, so concurrent
   * transactions cannot overfill the slots; a rollback releases them.
   */
  async #reserveSlots<Result>(
    mark: (
      sql: SqlStorage,
      free: number
    ) => { reserve: number[]; result: Result }
  ): Promise<Result> {
    let reserved: number[] = [];
    try {
      return await this.#engine.transaction((sql) => {
        const { reserve, result } = mark(
          sql,
          this.#maxConcurrentRuns - this.#active.size
        );
        reserved = reserve;
        for (const time of reserve) {
          this.#active.add(time);
        }
        return result;
      });
    } catch (error) {
      for (const time of reserved) {
        this.#active.delete(time);
      }
      throw error;
    }
  }

  #start(scheduledTime: number): void {
    const run = this.#describe(scheduledTime);
    const startedAt = Date.now();
    this.#emit({ ...this.#entity(run), type: 'started' });

    const controller = new AbortController();
    const handler = Promise.resolve().then(() =>
      this.#run({ ...run, signal: controller.signal })
    );
    const recorded = deadline(handler, this.#runTimeoutMs, () => {
      const error = new ScheduledRunTimeoutError(this.#runTimeoutMs);
      controller.abort(error);
      return error;
    })
      .then(
        (): ScheduledRunOutcome => ({ status: 'complete' }),
        (error: unknown): ScheduledRunOutcome => ({
          status: 'errored',
          error: serializeError(error),
        })
      )
      .then((outcome) => this.#record(run, outcome, startedAt))
      .catch((error) =>
        reportFailure(
          'durability.schedule.record_failed',
          { scheduledTime },
          error
        )
      );

    // The slot is held until the handler itself settles, even after a
    // timeout, so maxConcurrentRuns bounds the work actually in flight.
    void Promise.allSettled([handler, recorded])
      .then(() => {
        this.#active.delete(scheduledTime);
        this.#wake();
        return this.#startQueued();
      })
      .catch((error) =>
        reportFailure(
          'durability.schedule.dispatch_failed',
          { scheduledTime },
          error
        )
      );
  }

  async #record(
    run: ScheduledRun,
    outcome: ScheduledRunOutcome,
    startedAt: number
  ): Promise<void> {
    const error = outcome.status === 'errored' ? outcome.error : undefined;
    const recorded = await this.#engine.transaction(
      (sql) =>
        scheduledTimes(
          sql.exec(
            `UPDATE durability_schedule_runs
             SET state = ?, error = ?, next_at = ?, attempt = 0
             WHERE scheduled_time = ? AND state = 'running'
             RETURNING scheduled_time`,
            outcome.status,
            error === undefined ? null : JSON.stringify(error),
            Date.now(),
            run.scheduledTime
          )
        ).length > 0
    );
    if (!recorded) {
      return;
    }

    const entity = this.#entity(run);
    this.#emit({
      ...entity,
      type: 'settled',
      outcome: outcome.status,
      durationMs: Math.max(0, entity.timestamp - startedAt),
      ...(error === undefined ? {} : { error }),
    });
    this.#deliver(run.scheduledTime, outcome, 1);
  }

  #deliverDue(): void {
    const due = runRowSchema.array().parse(
      this.#engine.sql
        .exec(
          `SELECT * FROM durability_schedule_runs
           WHERE state IN ('complete', 'errored') AND next_at <= ?`,
          Date.now()
        )
        .toArray()
    );
    for (const row of due) {
      this.#deliver(row.scheduled_time, outcomeOf(row), row.attempt + 1);
    }
  }

  #deliver(
    scheduledTime: number,
    outcome: ScheduledRunOutcome,
    attempt: number
  ): void {
    if (this.#delivering.has(scheduledTime)) {
      return;
    }

    this.#delivering.add(scheduledTime);
    void this.#deliverOnce(scheduledTime, outcome, attempt)
      .catch((error) =>
        reportFailure(
          'durability.schedule.delivery_failed',
          { scheduledTime },
          error
        )
      )
      .finally(() => {
        this.#delivering.delete(scheduledTime);
        this.#wake();
      });
  }

  async #deliverOnce(
    scheduledTime: number,
    outcome: ScheduledRunOutcome,
    attempt: number
  ): Promise<void> {
    const run = this.#describe(scheduledTime);
    try {
      await deadline(
        Promise.resolve().then(() =>
          this.#onOutcome({ ...run, attempt }, outcome)
        ),
        this.#outcomeTimeoutMs,
        () => new ScheduledOutcomeTimeoutError(this.#outcomeTimeoutMs)
      );
    } catch (failure) {
      await this.#failDelivery(run, attempt, failure);
      return;
    }

    await this.#engine.transaction((sql) => {
      sql.exec(
        'DELETE FROM durability_schedule_runs WHERE scheduled_time = ?',
        scheduledTime
      );
    });
  }

  async #failDelivery(
    run: ScheduledRun,
    attempt: number,
    failure: unknown
  ): Promise<void> {
    const error = serializeError(failure);
    if (attempt >= this.#maxOutcomeAttempts) {
      await this.#engine.transaction((sql) => {
        sql.exec(
          'DELETE FROM durability_schedule_runs WHERE scheduled_time = ?',
          run.scheduledTime
        );
      });
      reportFailure(
        'durability.schedule.outcome_dead_lettered',
        { scheduledTime: run.scheduledTime, attempt },
        failure
      );
      this.#emit({
        ...this.#entity(run),
        type: 'dead_lettered',
        attempt,
        error,
      });
      return;
    }

    const nextAttemptAt = Date.now() + this.#retryDelay(attempt);
    await this.#engine.transaction((sql) => {
      sql.exec(
        `UPDATE durability_schedule_runs SET attempt = ?, next_at = ?
         WHERE scheduled_time = ?`,
        attempt,
        nextAttemptAt,
        run.scheduledTime
      );
    });
    this.#emit({
      ...this.#entity(run),
      type: 'outcome_retry',
      attempt,
      error,
      nextAttemptAt,
    });
  }

  // A broken delay policy must not strand the outcome: fall back to a fixed delay.
  #retryDelay(attempt: number): number {
    try {
      const delay = Math.round(this.#delay(attempt));
      if (Number.isSafeInteger(delay) && delay >= 0 && delay <= maxDelayMs) {
        return delay;
      }
    } catch (error) {
      reportFailure('durability.schedule.retry_policy_failed', {}, error);
    }
    return fallbackRetryMs;
  }
}

traceMethods(DurabilitySchedule.prototype, 'DurabilitySchedule');
