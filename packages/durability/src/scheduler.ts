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
  channelBindings,
  channelClause,
  claimAttempt,
  exhaustAttempts,
  tableOwner,
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
 * How a helper attaches to the object's scheduler: through a
 * {@link DurabilityScheduler}, or from the Durable Object context, which joins
 * the scheduler already there or creates it with the given options.
 */
export type SchedulerAttachment =
  | { scheduler: DurabilityScheduler; context?: never }
  | (DurabilitySchedulerConfig & { scheduler?: never });

const minAlarmDelayMs = 1_000;
const failedRunRetryMs = 1_000;
const defaultAlarmConcurrency = 10;
const schedulerOptionKeys = [
  'alarmConcurrency',
  'alarmMinDelayMs',
  'alarmHandoffMs',
  'liveTimers',
  'onAlarmRetry',
] as const satisfies ReadonlyArray<keyof DurabilitySchedulerOptions>;
const maxAlarmDelayMs = 15_000;
// setTimeout treats delays past this as zero, so anything further out can only
// be served by the physical alarm fallback.
const maxTimerMs = 2 ** 31 - 1;

const pendingHeadRowSchema = z.object({
  pk: z.string(),
  channel: z.string().optional(),
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
  /**
   * True while the participant runs its own due work from an alarm invocation
   * it keeps open. The in-memory timer then ignores its pending time, which only
   * arms the physical alarm as the eviction fallback.
   */
  holding?(): boolean;
};

/** The channel every helper uses when it is not given one. */
export const defaultChannel = 'default';

/**
 * One helper instance's share of a table that several instances partition by
 * a `channel` column. Each runs only its own channel's due rows.
 */
export type ChannelParticipant = {
  table: DurableTable;
  channel: string;
  /** How errors name the helper, such as `An outbox`. */
  helper: string;
  runDue(now: number, info: AlarmInvocationInfo | undefined): Promise<void>;
};

/** How long records of a channel no instance attached wait before they are looked at again. */
const unattachedChannelRetryMs = 60_000;

const channelRowSchema = z.object({ channel: z.string() });

const activeKey = (channel: string | undefined, key: string): string =>
  JSON.stringify([channel ?? null, key]);

/** Rejects a channel name a helper would otherwise store rows under. */
export const assertChannel = (helper: string, channel: unknown): string => {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new TypeError(`${helper} channel must be a non-empty string`);
  }
  return channel;
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
  private context: DurabilityContext;
  private readonly storage: DurableObjectStorage;
  private alarmConcurrency = defaultAlarmConcurrency;
  private alarmMinDelayMs = 15_000;
  private alarmHandoffMs = 14 * 60_000;
  liveTimers = false;
  private onAlarmRetry: DurabilitySchedulerOptions['onAlarmRetry'];
  // Only options someone set can conflict; an omitted one takes any value.
  private explicitOptions: DurabilitySchedulerOptions = {};
  private readonly participants: Participant[] = [];
  private readonly channelsByTable = new Map<
    string,
    Map<string, ChannelParticipant>
  >();
  private readonly migrated = new Set<MigrationCapability>();
  private availablePermits = defaultAlarmConcurrency;
  private readonly permitWaiters: Array<(release: () => void) => void> = [];
  private alarmRefresh: Promise<void> | undefined;
  private failedRuns = 0;
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
    this.configure(options);
  }

  /**
   * Joins one more helper or scheduler handle to this object's scheduler. The
   * first context that can `waitUntil` is kept, so a bare `{ storage }` context
   * attached first does not hide it from the rest.
   */
  attach(
    context: DurabilityContext,
    options: DurabilitySchedulerOptions
  ): void {
    if (
      this.context.waitUntil === undefined &&
      context.waitUntil !== undefined
    ) {
      this.context = context;
    }
    this.configure(options);
  }

  private configure(options: DurabilitySchedulerOptions): void {
    const merged: DurabilitySchedulerOptions = { ...this.explicitOptions };
    for (const key of schedulerOptionKeys) {
      const value = options[key];
      if (value === undefined) {
        continue;
      }
      const current = this.explicitOptions[key];
      if (current !== undefined && current !== value) {
        throw new Error(
          `Scheduler option "${key}" is already set to a different value for this Durable Object`
        );
      }
      Object.assign(merged, { [key]: value });
    }

    const alarmConcurrency = merged.alarmConcurrency ?? defaultAlarmConcurrency;
    const alarmMinDelayMs = merged.alarmMinDelayMs ?? 15_000;
    const alarmHandoffMs = merged.alarmHandoffMs ?? 14 * 60_000;
    if (
      merged.onAlarmRetry !== undefined &&
      typeof merged.onAlarmRetry !== 'function'
    ) {
      throw new TypeError('onAlarmRetry must be a function');
    }
    assertPositiveInteger('alarmConcurrency', alarmConcurrency);
    assertPositiveInteger('alarmMinDelayMs', alarmMinDelayMs);
    if (
      alarmMinDelayMs < minAlarmDelayMs ||
      alarmMinDelayMs > maxAlarmDelayMs
    ) {
      throw new RangeError(
        `alarmMinDelayMs must be between ${minAlarmDelayMs} and ${maxAlarmDelayMs}`
      );
    }
    assertPositiveInteger('alarmHandoffMs', alarmHandoffMs);

    // Permits already handed out stay out; raising the limit frees more now.
    this.availablePermits += alarmConcurrency - this.alarmConcurrency;
    this.alarmConcurrency = alarmConcurrency;
    this.alarmMinDelayMs = alarmMinDelayMs;
    this.alarmHandoffMs = alarmHandoffMs;
    this.liveTimers = merged.liveTimers ?? false;
    this.onAlarmRetry = merged.onAlarmRetry;
    this.explicitOptions = merged;
  }

  register(participant: Participant): void {
    const { name } = participant.table;
    if (this.participants.some(({ table }) => table.name === name)) {
      throw new Error(`A ${name} helper is already attached to this scheduler`);
    }
    this.participants.push(participant);
  }

  /**
   * Attaches one channel of a table several helper instances share. The first
   * attachment registers the table; each run then runs every attached
   * channel's due rows and retains the rows of channels nothing attached.
   */
  registerChannel(participant: ChannelParticipant): void {
    const { table, channel, helper } = participant;
    let channels = this.channelsByTable.get(table.name);
    if (!channels) {
      const created = new Map<string, ChannelParticipant>();
      this.register({
        table: { name: table.name, key: table.key },
        runDue: async (now, info) => {
          await Promise.all(
            [...created.values()].map((attached) => attached.runDue(now, info))
          );
          await this.postponeUnattachedChannels(table, created);
        },
      });
      this.channelsByTable.set(table.name, created);
      channels = created;
    }
    if (channels.has(channel)) {
      throw new Error(
        `${helper} for channel "${channel}" is already attached to this scheduler`
      );
    }
    channels.set(channel, participant);
  }

  /**
   * Due rows of a channel no instance attached, such as one a deploy removed
   * or a library not yet constructed, would keep the alarm awake forever. They
   * are kept and looked at again later, since their owner may return.
   */
  private async postponeUnattachedChannels(
    table: DurableTable,
    channels: ReadonlyMap<string, ChannelParticipant>
  ): Promise<void> {
    const now = Date.now();
    const unattached = channelRowSchema
      .array()
      .parse(
        this.sql
          .exec(
            `SELECT DISTINCT channel FROM ${table.name}
             WHERE status = 'pending' AND next_attempt_at <= ?`,
            now
          )
          .toArray()
      )
      .map((row) => row.channel)
      .filter((channel) => !channels.has(channel));
    if (unattached.length === 0) {
      return;
    }

    for (const channel of unattached) {
      reportFailure(
        'durability.channel_missing',
        { table: table.name, channel },
        new Error(
          `Channel "${channel}" of ${table.name} has no helper attached; retaining its records`
        )
      );
    }
    await this.transaction((sql) => {
      for (const channel of unattached) {
        sql.exec(
          `UPDATE ${table.name} SET next_attempt_at = ?
           WHERE channel = ? AND status = 'pending' AND next_attempt_at <= ?`,
          now + unattachedChannelRetryMs,
          channel,
          now
        );
      }
    });
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
      if (at === undefined) {
        return {};
      }
      return participant.holding?.()
        ? { physical: at }
        : { physical: at, timer: at };
    }
    const active = this.activeByTable.get(participant.table.name);
    const partitioned = this.channelsByTable.has(participant.table.name);
    const limit = this.liveTimers ? (active?.size ?? 0) + 1 : 1;
    const rows = pendingHeadRowSchema.array().parse(
      this.sql
        .exec(
          `SELECT ${participant.table.key} AS pk, next_attempt_at${partitioned ? ', channel' : ''}
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
    const eligible = rows.find(
      (row) => !active?.has(activeKey(row.channel, row.pk))
    );
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

    const where = `created_at < ?${channelClause(table)}`;
    const params = [before, ...channelBindings(table)];
    const removed = await this.transaction((sql) => {
      const { count } = countRowSchema.parse(
        sql
          .exec(
            `SELECT COUNT(*) AS count FROM ${table.name} WHERE ${where}`,
            ...params
          )
          .toArray()[0]
      );
      sql.exec(`DELETE FROM ${table.name} WHERE ${where}`, ...params);
      deleteStaleMemos(sql, table);
      return count;
    });

    if (removed > 0) {
      for (const key of this.watchers.get(tableOwner(table))?.keys() ?? []) {
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
    const owner = tableOwner(table);
    const byKey =
      this.watchers.get(owner) ?? new Map<string, Set<SettlementListener>>();
    this.watchers.set(owner, byKey);
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
    for (const listener of this.watchers.get(tableOwner(table))?.get(key) ??
      []) {
      listener(completed);
    }
  }

  tryAcquirePermit(): (() => void) | undefined {
    if (this.availablePermits <= 0) {
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
      this.failedRuns = 0;
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
      this.retryFailedRun();
    }
  }

  /**
   * A transient storage fault would otherwise leave all due work to the
   * fallback alarm, up to `alarmMinDelayMs` away: longer than a holder's
   * grant window, for one. The in-memory timer retries sooner, backing off to
   * that fallback while runs keep failing.
   */
  private retryFailedRun(): void {
    this.failedRuns += 1;
    const delay = Math.min(
      failedRunRetryMs * 2 ** (this.failedRuns - 1),
      this.alarmMinDelayMs
    );
    this.scheduleEarlyAlarm(Date.now() + delay);
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
    this.trackActive(spec.table.name, activeKey(spec.table.channel, key));

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
      this.releaseActive(spec.table.name, activeKey(spec.table.channel, key));
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

type ObjectScheduler = { engine: unknown; installation: symbol };

// Every copy of this package in an isolate shares the registry, so a second
// copy reaching the same object is caught instead of fighting over its alarm.
const installation = Symbol('durability installation');
const globalRegistry = globalThis as { [key: symbol]: unknown };
const registryKey = Symbol.for('durability.object-schedulers');
globalRegistry[registryKey] ??= new WeakMap<object, ObjectScheduler>();
const objectSchedulers = globalRegistry[registryKey] as WeakMap<
  object,
  ObjectScheduler
>;

/** The one engine behind every scheduler and helper of a Durable Object. */
const engineForObject = (config: DurabilitySchedulerConfig): Engine => {
  const { context } = config;
  const existing = objectSchedulers.get(context.storage);
  if (existing === undefined) {
    const engine = new Engine(context, config);
    objectSchedulers.set(context.storage, { engine, installation });
    return engine;
  }
  if (existing.installation !== installation) {
    throw new Error(
      'Another copy of durability is already attached to this Durable Object; install durability once, for example as a peer dependency'
    );
  }

  const engine = existing.engine as Engine;
  engine.attach(context, config);
  return engine;
};

/**
 * Owns the Durable Object's physical alarm, storage, and concurrency pool so
 * every durability helper on the object shares them.
 *
 * A Durable Object has one scheduler. Constructing another for the same
 * object, or a helper from the object's context, joins it; scheduler options
 * merge, and a different value for an option already set throws. Delegate the
 * object's `alarm` method to {@link DurabilityScheduler.alarm} or to any
 * helper's `alarm`: each runs the due work of every helper on the object.
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
    engines.set(this, engineForObject(config));
  }

  /** Runs due work for every attached helper and re-arms the physical alarm. */
  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return engineFor({ scheduler: this }).alarm(info);
  }
}

traceMethods(DurabilityScheduler.prototype, 'DurabilityScheduler');

/** Resolves the engine a helper attaches to: the object's one scheduler. */
export const engineFor = (attachment: SchedulerAttachment): Engine => {
  if (attachment.scheduler === undefined) {
    return engineForObject(attachment);
  }
  const engine = engines.get(attachment.scheduler);
  if (!engine) {
    throw new Error('Unknown DurabilityScheduler instance');
  }
  return engine;
};
