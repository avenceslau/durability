import { z } from 'zod';
import { trace, traceMethods, traceStorage } from './dev.js';
import {
  DurableRetryPolicyError,
  isErrorInstance,
  isNonRetryable,
  reportFailure,
  serializeError,
  type SerializedError,
} from './errors.js';
import {
  createEmitter,
  type DurabilityLifecycleEvent,
  type Emit,
  type LifecycleEntity,
} from './lifecycle.js';
import {
  isSchemaCurrent,
  migrateCapability,
  type MigrationCapability,
} from './migrations.js';
import { assertPositiveInteger, type AttemptPolicy } from './policy.js';
import { deleteMemos, deleteStaleMemos } from './memoize.js';
import {
  claimAttempt,
  exhaustAttempts,
  updateAttempt,
  type DurableTable,
} from './storage.js';
import type { DurableMigrations } from '@durability/storage';

/** The Durable Object state durability needs: storage plus optional `waitUntil`. */
export type DurabilityContext = Pick<DurableObjectState, 'storage'> &
  Partial<Pick<DurableObjectState, 'waitUntil'>>;

/** Options for the scheduler shared by every durability helper in one Durable Object. */
export type DurabilitySchedulerOptions = {
  /** Maximum handlers running at once across eager operations and alarm work. Defaults to 10. */
  alarmConcurrency?: number;
  /** Physical-alarm delay from 1 to 15 seconds. Defaults to 15 seconds. */
  alarmMinDelayMs?: number;
  /** Time before a running alarm hands unfinished work to a new alarm. Defaults to 14 minutes. */
  alarmHandoffMs?: number;
  /**
   * Experimental. Start due work from in-memory timers at its exact scheduled
   * time, independent of `alarmMinDelayMs`, and let newly due work run without
   * waiting behind long-running handlers. The physical alarm stays armed as the
   * eviction fallback. Off by default.
   */
  liveTimers?: boolean;
  /**
   * Called each time an alarm run fails and the scheduler re-arms its own
   * fallback alarm instead of letting the platform retry, for example to send
   * the error to an external service. Best effort: it runs after the fallback is
   * armed, a returned promise is passed to `waitUntil`, and a throw or rejection
   * is only logged, so it never changes scheduling.
   */
  onAlarmRetry?: (info: AlarmRetryInfo) => void | Promise<void>;
};

/** Details of a failed alarm run passed to `onAlarmRetry`. */
export type AlarmRetryInfo = {
  error: SerializedError;
  /** Delay until the re-armed fallback alarm fires. */
  retryInMs: number;
  /** The platform's retry count for this alarm invocation, when it provided one. */
  retryCount?: number;
  /** Whether the platform marked this invocation as a retry, when it provided one. */
  isRetry?: boolean;
  /** The owning Durable Object's ID, when the context carries one. */
  objectId?: string;
};

/** Configuration for a scheduler shared by several helpers. */
export type DurabilitySchedulerConfig = DurabilitySchedulerOptions & {
  context: DurabilityContext;
};

/**
 * How a helper attaches to a scheduler: an existing shared one, or a private
 * one created from the Durable Object context with the given scheduler options.
 */
export type SchedulerAttachment =
  | { scheduler: DurabilityScheduler; context?: never }
  | (DurabilitySchedulerConfig & { scheduler?: never });

const minAlarmDelayMs = 1_000;
const maxAlarmDelayMs = 15_000;
// setTimeout treats delays past this as zero, so anything further out can only
// be served by the physical alarm fallback.
const maxTimerMs = 2 ** 31 - 1;

const pendingHeadRowSchema = z.object({
  pk: z.string(),
  next_attempt_at: z.number().int().nonnegative(),
});
const countRowSchema = z.object({ count: z.number().int().nonnegative() });

type PhysicalAlarm = Pick<
  DurableObjectTransaction,
  'getAlarm' | 'setAlarm' | 'deleteAlarm'
>;

/** One record table attached to the scheduler: how to find and run its due work. */
export type Participant = {
  table: DurableTable;
  runDue(now: number, info: AlarmInvocationInfo | undefined): Promise<void>;
  /** Earliest due time, for tables without `status` and `next_attempt_at` columns. */
  nextPendingAt?(sql: SqlStorage): number | undefined;
};

/**
 * Called after a record may have settled. Successful completions pass the
 * executed row because some tables delete it on success; other changes pass
 * nothing and listeners re-read storage.
 */
export type SettlementListener = (completed?: ExecutionSpec['row']) => void;

export type ActiveExecution = {
  generation: string;
  createdAt: number;
  settled: Promise<void>;
  controller?: AbortController;
};

/** Everything that differs between running a durable operation and a named alarm attempt. */
export type ExecutionSpec = {
  table: DurableTable;
  key: string;
  row: { generation_id: string; created_at: number };
  label: string;
  entity: LifecycleEntity;
  active: Map<string, ActiveExecution>;
  policy: AttemptPolicy;
  emit: Emit;
  /** When true, the completed event carries the handler result; omitted by default to keep results out of telemetry. */
  includeResult?: boolean;
  exhaustedError: () => Error;
  timeoutError: () => Error;
  invoke: (attempt: number, signal: AbortSignal) => unknown;
  /**
   * Persists a successful attempt and returns its settlement timestamp, or
   * undefined when a newer generation won. May throw to turn the success into
   * a failure.
   */
  complete: (result: unknown, attempt: number) => number | undefined;
  /** Kind-specific terminal rule beyond non-retryable errors and exhausted attempts. */
  isTerminal: (error: unknown) => boolean;
};

type RetryDecision = {
  error: unknown;
  terminal: boolean;
  timestamp: number;
  nextAttemptAt: number;
};

const decideRetry = (
  spec: ExecutionSpec,
  attempt: number,
  error: unknown
): RetryDecision => {
  const terminal =
    isNonRetryable(error) ||
    attempt >= spec.policy.maxAttempts ||
    spec.isTerminal(error);
  if (terminal) {
    const timestamp = Date.now();
    return { error, terminal, timestamp, nextAttemptAt: timestamp };
  }

  try {
    const rawDelay = spec.policy.delay(attempt);
    if (!Number.isFinite(rawDelay) || rawDelay < 0) {
      throw new DurableRetryPolicyError(spec.label);
    }
    const delay = Math.round(rawDelay);
    const timestamp = Date.now();
    if (
      !Number.isSafeInteger(delay) ||
      !Number.isSafeInteger(timestamp + delay)
    ) {
      throw new DurableRetryPolicyError(spec.label);
    }
    return {
      error,
      terminal: false,
      timestamp,
      nextAttemptAt: timestamp + delay,
    };
  } catch (policyError) {
    const timestamp = Date.now();
    return {
      error: isErrorInstance(policyError, DurableRetryPolicyError)
        ? policyError
        : new DurableRetryPolicyError(spec.label, policyError),
      terminal: true,
      timestamp,
      nextAttemptAt: timestamp,
    };
  }
};

/**
 * Shared machinery behind {@link DurabilityScheduler}: transactions, the physical
 * alarm, the concurrency pool, and the attempt lifecycle. Package-internal.
 */
export class Engine {
  readonly sql: SqlStorage;
  private readonly context: DurabilityContext;
  private readonly storage: DurableObjectStorage;
  private readonly alarmConcurrency: number;
  private readonly alarmMinDelayMs: number;
  private readonly alarmHandoffMs: number;
  readonly liveTimers: boolean;
  private readonly onAlarmRetry: DurabilitySchedulerOptions['onAlarmRetry'];
  private readonly participants: Participant[] = [];
  private readonly migrated = new Set<MigrationCapability>();
  private availablePermits: number;
  private readonly permitWaiters: Array<(release: () => void) => void> = [];
  private alarmRefresh: Promise<void> | undefined;
  private earlyAlarm:
    | { timestamp: number; timer: ReturnType<typeof setTimeout> }
    | undefined;
  private readonly watchers = new Map<
    string,
    Map<string, Set<SettlementListener>>
  >();
  // Keys whose attempt is currently executing, per table. The in-memory timer
  // skips these so a still-due active row cannot drive a zero-delay timer loop.
  private readonly activeByTable = new Map<string, Set<string>>();

  constructor(context: DurabilityContext, options: DurabilitySchedulerOptions) {
    this.context = context;
    this.storage = traceStorage(context.storage);
    this.sql = this.storage.sql;
    this.alarmConcurrency = options.alarmConcurrency ?? 10;
    this.alarmMinDelayMs = options.alarmMinDelayMs ?? 15_000;
    this.alarmHandoffMs = options.alarmHandoffMs ?? 14 * 60_000;
    this.liveTimers = options.liveTimers ?? false;
    this.onAlarmRetry = options.onAlarmRetry;
    if (
      this.onAlarmRetry !== undefined &&
      typeof this.onAlarmRetry !== 'function'
    ) {
      throw new TypeError('onAlarmRetry must be a function');
    }
    assertPositiveInteger('alarmConcurrency', this.alarmConcurrency);
    assertPositiveInteger('alarmMinDelayMs', this.alarmMinDelayMs);
    if (
      this.alarmMinDelayMs < minAlarmDelayMs ||
      this.alarmMinDelayMs > maxAlarmDelayMs
    ) {
      throw new RangeError(
        `alarmMinDelayMs must be between ${minAlarmDelayMs} and ${maxAlarmDelayMs}`
      );
    }
    assertPositiveInteger('alarmHandoffMs', this.alarmHandoffMs);
    this.availablePermits = this.alarmConcurrency;
  }

  register(participant: Participant): void {
    const { name } = participant.table;
    if (this.participants.some(({ table }) => table.name === name)) {
      throw new Error(`A ${name} helper is already attached to this scheduler`);
    }
    this.participants.push(participant);
  }

  waitUntil(
    promise: Promise<unknown>,
    onError: (error: unknown) => void
  ): void {
    if (!this.context.waitUntil) {
      return;
    }
    try {
      this.context.waitUntil(promise);
    } catch (error) {
      onError(error);
    }
  }

  /**
   * The owning Durable Object's ID. The public context type omits it, but the
   * `DurableObjectState` applications pass at runtime carries it.
   */
  objectId(): string | undefined {
    const id: unknown = Reflect.get(this.context, 'id');
    return id === undefined || id === null ? undefined : String(id);
  }

  emitter<
    Event extends { entityKind: string; type: string } =
      DurabilityLifecycleEvent,
  >(
    hook: ((event: Event) => void | Promise<void>) | undefined
  ): (event: Event) => void {
    return createEmitter<Event>(hook, (promise) =>
      this.context.waitUntil?.(promise)
    );
  }

  /** Applies a helper's SQLite migrations. */
  migrateSchema(
    capability: MigrationCapability,
    migrations: DurableMigrations
  ): void {
    // Helpers of one kind on one scheduler share their tables; checking the
    // schema again for each would only add statements to every construction.
    if (this.migrated.has(capability)) {
      return;
    }
    if (!isSchemaCurrent(this.sql, capability, migrations)) {
      migrateCapability(this.storage, capability, migrations, undefined);
    }
    this.migrated.add(capability);
  }

  /** Runs synchronous writes atomically without touching the physical alarm. */
  transactionSync<T>(write: (sql: SqlStorage) => T): T {
    return this.storage.transactionSync(() => write(this.sql));
  }

  /**
   * Runs the writes and reconciles the physical alarm in one storage
   * transaction, then publishes the in-memory timer only after commit.
   */
  async transaction<T>(write: (sql: SqlStorage) => T): Promise<T> {
    let nextPendingAt: number | undefined;
    const result = await this.storage.transaction(async (transaction) => {
      const value = write(this.sql);
      nextPendingAt = await this.reconcile(transaction);
      return value;
    });
    this.scheduleEarlyAlarm(nextPendingAt);
    return result;
  }

  private trackActive(table: string, key: string): void {
    let keys = this.activeByTable.get(table);
    if (!keys) {
      keys = new Set();
      this.activeByTable.set(table, keys);
    }
    keys.add(key);
  }

  private releaseActive(table: string, key: string): void {
    const keys = this.activeByTable.get(table);
    if (!keys) {
      return;
    }
    keys.delete(key);
    if (keys.size === 0) {
      this.activeByTable.delete(table);
    }
  }

  /**
   * The earliest pending time for one participant: `physical` arms the physical
   * alarm (eviction fallback) and includes active work; `timer` drives the
   * in-memory timer and, under liveTimers, skips work that is already executing
   * so a still-due active row cannot re-fire a zero-delay timer in a loop.
   */
  private pendingTimes(participant: Participant): {
    physical?: number | undefined;
    timer?: number | undefined;
  } {
    if (participant.nextPendingAt) {
      const at = participant.nextPendingAt(this.sql);
      return at === undefined ? {} : { physical: at, timer: at };
    }
    const active = this.activeByTable.get(participant.table.name);
    const limit = this.liveTimers ? (active?.size ?? 0) + 1 : 1;
    const rows = pendingHeadRowSchema.array().parse(
      this.sql
        .exec(
          `SELECT ${participant.table.key} AS pk, next_attempt_at
           FROM ${participant.table.name}
           WHERE status = 'pending'
           ORDER BY next_attempt_at ASC
           LIMIT ?`,
          limit
        )
        .toArray()
    );
    const physical = rows[0]?.next_attempt_at;
    if (!this.liveTimers) {
      if (physical === undefined) {
        return {};
      }
      return { physical, timer: physical };
    }
    const eligible = rows.find((row) => !active?.has(row.pk));
    return { physical, timer: eligible?.next_attempt_at };
  }

  /**
   * Arms the physical alarm from the earliest pending time (the eviction
   * fallback) and returns the earliest time the in-memory timer should fire.
   */
  private async reconcile(
    physicalAlarm: PhysicalAlarm
  ): Promise<number | undefined> {
    const physicalTimes: number[] = [];
    const timerTimes: number[] = [];
    for (const participant of this.participants) {
      const { physical, timer } = this.pendingTimes(participant);
      if (physical !== undefined) {
        physicalTimes.push(physical);
      }
      if (timer !== undefined) {
        timerTimes.push(timer);
      }
    }

    const physicalNextAt =
      physicalTimes.length === 0 ? undefined : Math.min(...physicalTimes);
    const currentAlarm = await physicalAlarm.getAlarm();
    if (physicalNextAt === undefined) {
      if (currentAlarm !== null) {
        await physicalAlarm.deleteAlarm();
      }
      return undefined;
    }

    const target = Math.max(physicalNextAt, Date.now() + this.alarmMinDelayMs);
    // Preserve a fallback inside this range so frequent reconciliation cannot push it later.
    if (
      currentAlarm === null ||
      currentAlarm < physicalNextAt ||
      currentAlarm > target
    ) {
      await physicalAlarm.setAlarm(target);
    }
    return timerTimes.length === 0 ? undefined : Math.min(...timerTimes);
  }

  private scheduleEarlyAlarm(timestamp: number | undefined): void {
    if (this.earlyAlarm?.timestamp === timestamp) {
      return;
    }
    if (this.earlyAlarm) {
      clearTimeout(this.earlyAlarm.timer);
      this.earlyAlarm = undefined;
    }
    if (timestamp === undefined) {
      return;
    }
    const delay = timestamp - Date.now();
    // Without liveTimers the in-memory timer only covers the sub-min-delay
    // window; the physical alarm handles everything beyond it. With liveTimers
    // it fires at the exact due time no matter how far out, except past the
    // timer's range where only the physical fallback can serve it.
    if (!this.liveTimers && delay >= this.alarmMinDelayMs) {
      return;
    }
    if (delay > maxTimerMs) {
      return;
    }

    const timer = setTimeout(
      () => {
        if (this.earlyAlarm?.timer !== timer) {
          return;
        }
        this.earlyAlarm = undefined;
        trace('scheduler.early_alarm', { scheduledTime: timestamp });
        const onError = (error: unknown) =>
          reportFailure(
            'durability.background_execution.failed',
            { scheduledTime: timestamp },
            error
          );
        const execution = this.alarm().catch(onError);
        this.waitUntil(execution, onError);
      },
      Math.max(delay, 0)
    );
    this.earlyAlarm = { timestamp, timer };
  }

  /** Coalesces concurrent refresh requests into one reconciliation transaction. */
  scheduleNextAlarm(): Promise<void> {
    if (this.alarmRefresh) {
      return this.alarmRefresh;
    }
    this.alarmRefresh = this.transaction(() => undefined).finally(() => {
      this.alarmRefresh = undefined;
    });
    return this.alarmRefresh;
  }

  /**
   * Aborts matching active handlers, then deletes one kind's records created
   * before the timestamp and reconciles the alarm in the same transaction.
   */
  async purge(
    table: DurableTable,
    before: number,
    active: Map<string, ActiveExecution>,
    abortReason: string
  ): Promise<number> {
    if (!Number.isSafeInteger(before) || before < 0) {
      throw new RangeError('timestamp must be a non-negative safe integer');
    }
    for (const running of active.values()) {
      if (running.createdAt < before) {
        running.controller?.abort(new Error(abortReason));
      }
    }

    const removed = await this.transaction((sql) => {
      const { count } = countRowSchema.parse(
        sql
          .exec(
            `SELECT COUNT(*) AS count FROM ${table.name} WHERE created_at < ?`,
            before
          )
          .toArray()[0]
      );
      sql.exec(`DELETE FROM ${table.name} WHERE created_at < ?`, before);
      deleteStaleMemos(sql, table);
      return count;
    });

    if (removed > 0) {
      for (const key of this.watchers.get(table.name)?.keys() ?? []) {
        this.notify(table, key);
      }
    }
    return removed;
  }

  /** In-memory only: listeners never survive eviction. */
  watch(
    table: DurableTable,
    key: string,
    listener: SettlementListener
  ): () => void {
    const byKey =
      this.watchers.get(table.name) ??
      new Map<string, Set<SettlementListener>>();
    this.watchers.set(table.name, byKey);
    const listeners = byKey.get(key) ?? new Set<SettlementListener>();
    byKey.set(key, listeners);
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && byKey.get(key) === listeners) {
        byKey.delete(key);
      }
    };
  }

  /** Call only after the change has committed. */
  notify(
    table: DurableTable,
    key: string,
    completed?: ExecutionSpec['row']
  ): void {
    for (const listener of this.watchers.get(table.name)?.get(key) ?? []) {
      listener(completed);
    }
  }

  tryAcquirePermit(): (() => void) | undefined {
    if (this.availablePermits === 0) {
      return undefined;
    }
    this.availablePermits -= 1;
    return this.createRelease();
  }

  acquirePermit(): Promise<() => void> {
    const release = this.tryAcquirePermit();
    if (release) {
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      this.permitWaiters.push(resolve);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const waiter = this.permitWaiters.shift();
      if (waiter) {
        waiter(this.createRelease());
      } else {
        this.availablePermits += 1;
      }
    };
  }

  async runConcurrent<Item>(
    items: Item[],
    worker: (item: Item) => Promise<void>
  ): Promise<void> {
    let nextIndex = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(this.alarmConcurrency, items.length) },
        async () => {
          while (nextIndex < items.length) {
            const item = items[nextIndex++];
            if (item !== undefined) {
              // eslint-disable-next-line no-await-in-loop
              await worker(item);
            }
          }
        }
      )
    );
  }

  /**
   * Runs due work and re-arms the physical alarm. A failure that would
   * otherwise propagate to the platform is turned into a retry of our own,
   * because the platform drops an alarm after a few failed deliveries.
   */
  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    try {
      await this.runAlarm(info);
    } catch (error) {
      // Throwing lets the platform retry, but it gives up after a few failures
      // and drops the alarm, stranding pending work. Keeping our own alarm
      // armed turns the failure into a retry we control instead.
      if (!(await this.armFallbackAlarm())) {
        throw error;
      }
      reportFailure(
        'durability.alarm.failed',
        { retryInMs: this.alarmMinDelayMs },
        error
      );
      this.notifyAlarmRetry(error, info);
    }
  }

  private notifyAlarmRetry(
    failure: unknown,
    invocation: AlarmInvocationInfo | undefined
  ): void {
    const hook = this.onAlarmRetry;
    if (!hook) {
      return;
    }

    const objectId = this.objectId();
    const info: AlarmRetryInfo = {
      error: serializeError(failure),
      retryInMs: this.alarmMinDelayMs,
      ...(invocation === undefined
        ? {}
        : {
            retryCount: invocation.retryCount,
            isRetry: invocation.isRetry,
          }),
      ...(objectId === undefined ? {} : { objectId }),
    };
    const report = (hookError: unknown): void =>
      reportFailure(
        'durability.alarm.retry_hook_failed',
        { retryInMs: info.retryInMs },
        hookError
      );
    try {
      const result = hook(info);
      if (result !== undefined) {
        this.waitUntil(Promise.resolve(result).catch(report), report);
      }
    } catch (hookError) {
      report(hookError);
    }
  }

  /**
   * Runs every participant's due work, hands off to a fresh alarm if the
   * invocation approaches its wall-time limit, and re-arms the physical alarm.
   */
  private async runAlarm(info?: AlarmInvocationInfo): Promise<void> {
    const startedAt = Date.now();
    const execution = Promise.all(
      this.participants.map((participant) =>
        participant.runDue(startedAt, info)
      )
    ).then(() => undefined);
    void execution.catch(() => undefined);

    const handoff = Symbol('alarm handoff');
    const remaining = this.alarmHandoffMs - (Date.now() - startedAt);
    let timeout: ReturnType<typeof setTimeout> | undefined;
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
      await this.armForHandoff(Date.now());
      return;
    }
    await this.scheduleNextAlarm();
  }

  /** Arms the physical alarm directly, outside any transaction; the next run reconciles properly. */
  private async armFallbackAlarm(): Promise<boolean> {
    try {
      await this.storage.setAlarm(Date.now() + this.alarmMinDelayMs);
      return true;
    } catch {
      return false;
    }
  }

  private armForHandoff(timestamp: number): Promise<void> {
    return this.storage.transaction(async (physicalAlarm) => {
      const currentAlarm = await physicalAlarm.getAlarm();
      const target = Math.max(timestamp, Date.now() + this.alarmMinDelayMs);
      if (currentAlarm === null || currentAlarm > target) {
        await physicalAlarm.setAlarm(target);
      }
    });
  }

  /**
   * Registers the execution in its active map synchronously, then claims and
   * runs one attempt in the background. The returned promise settles when the
   * attempt's outcome has been persisted, not when a timed-out handler settles.
   */
  startExecution(spec: ExecutionSpec, eagerPermit?: () => void): Promise<void> {
    const { key, row, policy } = spec;
    let settleActive!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleActive = resolve;
    });
    const activeExecution: ActiveExecution = {
      generation: row.generation_id,
      createdAt: row.created_at,
      settled,
    };
    spec.active.set(key, activeExecution);
    this.trackActive(spec.table.name, key);

    let releasePermit = eagerPermit;
    let handlerStarted = false;
    let handlerSettled = false;
    let policySettled = false;
    const releaseIfSettled = (): void => {
      if (policySettled && (!handlerStarted || handlerSettled)) {
        releasePermit?.();
        settleActive();
      }
    };

    const execution = (async (): Promise<void> => {
      releasePermit ??= await this.acquirePermit();
      const attempt = claimAttempt(
        this.sql,
        spec.table,
        key,
        row.generation_id,
        policy.maxAttempts
      );
      if (attempt === undefined) {
        await this.failExhausted(spec);
        return;
      }

      const startedAt = Date.now();
      spec.emit({
        ...spec.entity,
        type: 'attempt_started',
        timestamp: startedAt,
        attempt,
      });
      const controller = new AbortController();
      activeExecution.controller = controller;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        handlerStarted = true;
        const handlerResult = Promise.resolve().then(() =>
          spec.invoke(attempt, controller.signal)
        );
        void handlerResult
          .finally(() => {
            handlerSettled = true;
            releaseIfSettled();
          })
          .catch(() => undefined);
        const timeoutResult = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = spec.timeoutError();
            controller.abort(error);
            reject(error);
          }, policy.attemptTimeoutMs);
        });
        const result = await Promise.race([handlerResult, timeoutResult]);

        // One transaction: a failed memo cleanup must undo the completion, not orphan the memos.
        const timestamp = this.transactionSync((sql) => {
          const completedAt = spec.complete(result, attempt);
          if (completedAt !== undefined) {
            deleteMemos(sql, spec.table, key);
          }
          return completedAt;
        });
        if (timestamp !== undefined) {
          this.notify(spec.table, key, row);
          spec.emit({
            ...spec.entity,
            type: 'attempt_settled',
            timestamp,
            attempt,
            durationMs: Math.max(0, timestamp - startedAt),
            outcome: 'completed',
            ...(spec.includeResult ? { result } : {}),
          });
        }
      } catch (caught) {
        await this.settleFailure(spec, attempt, startedAt, caught);
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
      if (spec.active.get(key) === activeExecution) {
        spec.active.delete(key);
      }
      this.releaseActive(spec.table.name, key);
      // Re-arm the in-memory timer now that this key is eligible again, so work
      // the timer skipped while it executed is picked up at its exact time.
      if (this.liveTimers) {
        void this.scheduleNextAlarm().catch((error) =>
          reportFailure(
            'durability.scheduler.refresh_failed',
            { table: spec.table.name, key },
            error
          )
        );
      }
    });
    return execution;
  }

  private async failExhausted(spec: ExecutionSpec): Promise<void> {
    const { key, row, policy } = spec;
    const exhausted = serializeError(spec.exhaustedError());
    const attempt = await this.transaction((sql) => {
      const exhaustedAttempt = exhaustAttempts(
        sql,
        spec.table,
        key,
        row.generation_id,
        policy.maxAttempts,
        exhausted
      );
      if (exhaustedAttempt !== undefined) {
        deleteMemos(sql, spec.table, key);
      }
      return exhaustedAttempt;
    });
    if (attempt === undefined) {
      return;
    }

    this.notify(spec.table, key);
    spec.emit({
      ...spec.entity,
      type: 'terminal',
      timestamp: Date.now(),
      attempt,
      reason: 'attempts_exhausted',
      error: exhausted,
    });
  }

  private async settleFailure(
    spec: ExecutionSpec,
    attempt: number,
    startedAt: number,
    caught: unknown
  ): Promise<void> {
    const { key, row } = spec;
    const decision = decideRetry(spec, attempt, caught);
    const serializedError = serializeError(decision.error);
    const updated = await this.transaction((sql) => {
      const owned = updateAttempt(
        sql,
        spec.table,
        { key, generation: row.generation_id, attempt },
        'status = ?, next_attempt_at = ?, last_error = ?, last_error_name = ?',
        decision.terminal ? 'failed' : 'pending',
        decision.nextAttemptAt,
        serializedError.message,
        serializedError.name
      );
      if (owned && decision.terminal) {
        deleteMemos(sql, spec.table, key);
      }
      return owned;
    });
    if (!updated) {
      return;
    }
    if (decision.terminal) {
      this.notify(spec.table, key);
    }

    const settled = {
      ...spec.entity,
      type: 'attempt_settled' as const,
      timestamp: decision.timestamp,
      attempt,
      durationMs: Math.max(0, decision.timestamp - startedAt),
      error: serializedError,
    };
    spec.emit(
      decision.terminal
        ? { ...settled, outcome: 'failed' }
        : {
            ...settled,
            outcome: 'retry_scheduled',
            nextAttemptAt: decision.nextAttemptAt,
          }
    );
  }
}

const engines = new WeakMap<DurabilityScheduler, Engine>();

/**
 * Owns the Durable Object's physical alarm, storage, and concurrency
 * pool so {@link Durability} and {@link DurabilityAlarms} can share them.
 *
 * Construct one per Durable Object when using both helpers, pass it to each,
 * and delegate the object's `alarm` method to {@link DurabilityScheduler.alarm}.
 * A helper constructed directly from the Durable Object context creates a
 * private scheduler instead.
 *
 * @example
 * ```ts
 * class Jobs extends DurableObject<Env> {
 *   private readonly scheduler = new DurabilityScheduler({ context: this.ctx });
 *   private readonly durability = new Durability({
 *     scheduler: this.scheduler,
 *     handlers,
 *   });
 *   private readonly alarms = new DurabilityAlarms({
 *     scheduler: this.scheduler,
 *     handlers: alarmHandlers,
 *   });
 *
 *   alarm(info?: AlarmInvocationInfo) {
 *     return this.scheduler.alarm(info);
 *   }
 * }
 * ```
 */
export class DurabilityScheduler {
  constructor(config: DurabilitySchedulerConfig) {
    engines.set(this, new Engine(config.context, config));
  }

  /** Runs due work for every attached helper and re-arms the physical alarm. */
  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return engineFor({ scheduler: this }).alarm(info);
  }
}

traceMethods(DurabilityScheduler.prototype, 'DurabilityScheduler');

/**
 * Resolves the engine a helper should attach to: the shared one behind a
 * scheduler, or a private one built from the Durable Object context.
 */
export const engineFor = (attachment: SchedulerAttachment): Engine => {
  if (attachment.scheduler === undefined) {
    return new Engine(attachment.context, attachment);
  }
  const engine = engines.get(attachment.scheduler);
  if (!engine) {
    throw new Error('Unknown DurabilityScheduler instance');
  }
  return engine;
};
