import { z } from 'zod';
import {
  DurableRetryPolicyError,
  isErrorInstance,
  isNonRetryable,
  serializeError,
} from './errors.js';
import { createKvDurabilityStorage } from './kv-storage.js';
import {
  createEmitter,
  type Emit,
  type LifecycleEntity,
  type LifecycleHook,
} from './lifecycle.js';
import { migrate, type MigrationCapability } from './migrations.js';
import { assertPositiveInteger, type AttemptPolicy } from './policy.js';
import { createSqliteDurabilityStorage } from './sqlite-storage.js';
import {
  reconcilePhysicalAlarm,
  type DurabilityStorage,
  type DurabilityStorageTransaction,
  type DurableRecord,
  type RecordKind,
} from './storage.js';
import type { DurableMigrations } from '@durability/storage';

/** The Durable Object state durability needs: storage plus optional `waitUntil`. */
export type DurabilityContext = Pick<DurableObjectState, 'storage'> &
  Partial<Pick<DurableObjectState, 'waitUntil'>>;

export type DurabilityStorageBackend = 'sqlite' | 'kv';

/** Options for the scheduler shared by every durability helper in one Durable Object. */
export type DurabilitySchedulerOptions = {
  /** Storage backend configured for the Durable Object class. Defaults to SQLite. */
  storageBackend?: DurabilityStorageBackend;
  /** Maximum handlers running at once across eager operations and alarm work. Defaults to 10. */
  alarmConcurrency?: number;
  /** Time before a running alarm hands unfinished work to a new alarm. Defaults to 14 minutes. */
  alarmHandoffMs?: number;
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

const storageBackendSchema = z.enum(['sqlite', 'kv']);

/** One record kind attached to the scheduler: how to find and run its due work. */
export type Participant = {
  kind: RecordKind;
  runDue(now: number, info: AlarmInvocationInfo | undefined): Promise<void>;
};

export type ActiveExecution = {
  generation: string;
  createdAt: number;
  settled: Promise<void>;
  controller?: AbortController;
};

/** Everything that differs between running a durable operation and a named alarm attempt. */
export type ExecutionSpec = {
  kind: RecordKind;
  key: string;
  row: DurableRecord;
  label: string;
  entity: LifecycleEntity;
  active: Map<string, ActiveExecution>;
  policy: AttemptPolicy;
  emit: Emit;
  exhaustedError: () => Error;
  timeoutError: () => Error;
  invoke: (attempt: number, signal: AbortSignal) => unknown;
  /**
   * Persists a successful attempt and returns its settlement timestamp, or
   * undefined when a newer generation won. May throw to turn the success into
   * a failure.
   */
  complete: (result: unknown, attempt: number) => Promise<number | undefined>;
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
 * Shared machinery behind {@link DurabilityScheduler}: storage, the physical
 * alarm, the concurrency pool, and the attempt lifecycle. Package-internal.
 */
export class Engine {
  readonly storage: DurabilityStorage;
  private readonly backend: DurabilityStorageBackend;
  private readonly context: DurabilityContext;
  private readonly alarmConcurrency: number;
  private readonly alarmHandoffMs: number;
  private readonly participants: Participant[] = [];
  private availablePermits: number;
  private readonly permitWaiters: Array<(release: () => void) => void> = [];
  private alarmRefresh: Promise<void> | undefined;

  constructor(context: DurabilityContext, options: DurabilitySchedulerOptions) {
    this.context = context;
    this.backend = storageBackendSchema.parse(
      options.storageBackend ?? 'sqlite'
    );
    this.storage =
      this.backend === 'kv'
        ? createKvDurabilityStorage(context.storage)
        : createSqliteDurabilityStorage(context.storage);
    this.alarmConcurrency = options.alarmConcurrency ?? 10;
    this.alarmHandoffMs = options.alarmHandoffMs ?? 14 * 60_000;
    assertPositiveInteger('alarmConcurrency', this.alarmConcurrency);
    assertPositiveInteger('alarmHandoffMs', this.alarmHandoffMs);
    this.availablePermits = this.alarmConcurrency;
  }

  register(participant: Participant): void {
    if (this.participants.some(({ kind }) => kind === participant.kind)) {
      throw new Error(
        `A ${participant.kind} helper is already attached to this scheduler`
      );
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

  emitter(hook: LifecycleHook | undefined): Emit {
    return createEmitter(hook, (promise) => this.context.waitUntil?.(promise));
  }

  /** Applies a helper's SQLite migrations; KV storage has no schema. */
  migrateSchema(
    capability: MigrationCapability,
    migrations: DurableMigrations
  ): void {
    if (this.backend === 'sqlite') {
      migrate(this.context.storage, capability, migrations, undefined);
    }
  }

  reconcile(transaction: DurabilityStorageTransaction): Promise<void> {
    return reconcilePhysicalAlarm(
      transaction,
      this.participants.map(({ kind }) => kind)
    );
  }

  /** Coalesces concurrent refresh requests into one reconciliation transaction. */
  scheduleNextAlarm(): Promise<void> {
    if (this.alarmRefresh) {
      return this.alarmRefresh;
    }
    this.alarmRefresh = this.storage
      .transaction((transaction) => this.reconcile(transaction))
      .finally(() => {
        this.alarmRefresh = undefined;
      });
    return this.alarmRefresh;
  }

  /**
   * Aborts matching active handlers, then deletes one kind's records created
   * before the timestamp, reconciling the alarm after each committed batch.
   */
  async purge(
    kind: RecordKind,
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

    let total = 0;
    let removed = 0;
    do {
      // eslint-disable-next-line no-await-in-loop
      removed = await this.storage.transaction(async (transaction) => {
        const count = await transaction[kind].deleteCreatedBefore(before);
        await this.reconcile(transaction);
        return count;
      });
      total += removed;
    } while (removed > 0);
    return total;
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
   * Runs every participant's due work, hands off to a fresh alarm if the
   * invocation approaches its wall-time limit, and re-arms the physical alarm.
   */
  async alarm(info?: AlarmInvocationInfo): Promise<void> {
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

  private armForHandoff(timestamp: number): Promise<void> {
    return this.storage.transaction(async ({ physicalAlarm }) => {
      const currentAlarm = await physicalAlarm.getAlarm();
      if (currentAlarm === null || currentAlarm > timestamp) {
        await physicalAlarm.setAlarm(timestamp);
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
      const attempt = await this.storage[spec.kind].claimAttempt(
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

        const timestamp = await spec.complete(result, attempt);
        if (timestamp !== undefined) {
          spec.emit({
            ...spec.entity,
            type: 'attempt_settled',
            timestamp,
            attempt,
            durationMs: Math.max(0, timestamp - startedAt),
            outcome: 'completed',
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
    });
    return execution;
  }

  private async failExhausted(spec: ExecutionSpec): Promise<void> {
    const { key, row, policy } = spec;
    const current = await this.storage[spec.kind].get(key);
    if (
      current?.generation_id !== row.generation_id ||
      current.status !== 'pending' ||
      current.attempt < policy.maxAttempts
    ) {
      return;
    }

    const exhausted = serializeError(spec.exhaustedError());
    let updated = false;
    await this.storage.transaction(async (transaction) => {
      updated = await transaction[spec.kind].exhaust(
        key,
        row.generation_id,
        policy.maxAttempts,
        {
          status: 'failed',
          last_error: exhausted.message,
          last_error_name: exhausted.name,
        }
      );
      await this.reconcile(transaction);
    });
    if (updated) {
      spec.emit({
        ...spec.entity,
        type: 'terminal',
        timestamp: Date.now(),
        attempt: current.attempt,
        reason: 'attempts_exhausted',
        error: exhausted,
      });
    }
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
    let updated = false;
    await this.storage.transaction(async (transaction) => {
      updated = await transaction[spec.kind].settle(
        key,
        row.generation_id,
        attempt,
        {
          status: decision.terminal ? 'failed' : 'pending',
          next_attempt_at: decision.nextAttemptAt,
          last_error: serializedError.message,
          last_error_name: serializedError.name,
        }
      );
      await this.reconcile(transaction);
    });
    if (!updated) {
      return;
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
 * Owns the Durable Object's physical alarm, storage backend, and concurrency
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
