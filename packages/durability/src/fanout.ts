import {
  DurableRetryPolicyError,
  FanoutEnqueueError,
  FanoutSettlementError,
  FanoutTimeoutError,
  reportFailure,
  serializeError,
  type SerializedError,
} from './errors.js';
import type {
  Emit,
  FanoutLifecycleEntity,
  LifecycleHook,
} from './lifecycle.js';
import { RoutingLoad, type EnqueueResult, type LoadSnapshot } from './load.js';
import type { MessageWrite, StoredMessage } from './stored-message.js';
import { durabilityFanoutMigrations, migrate } from './migrations.js';
import {
  assertPositiveInteger,
  createPolicyResolver,
  methodOptionsSchema,
  type AttemptPolicy,
  type ExecutionPolicyOptions,
} from './policy.js';
import {
  engineFor,
  type Engine,
  type SchedulerAttachment,
} from './scheduler.js';
import { deserialize, serialize } from './serialization.js';
import type { DeliveryRow, FanoutMessageRow } from './storage.js';

export type FanoutInput<Body = unknown> = {
  id?: string;
  body: Body;
  /** Defaults to id. Redrive uses the DLQ entry ID to register fresh attempts. */
  deduplicationKey?: string;
};

/** Each target receives its own settlement capability for each message. */
export type DurabilityFanoutMessage<Body = unknown> = {
  id: string;
  deliveryId: string;
  target: string;
  body: Body;
  attempt: number;
  enqueuedAt: number;
  ack(): Promise<void>;
  retry(delayMs?: number): Promise<void>;
  deadLetter(): Promise<void>;
};

export type FanoutTarget<Body> = ExecutionPolicyOptions &
  (
    | {
        deliver(
          messages: DurabilityFanoutMessage<Body>[]
        ): unknown | Promise<unknown>;
        /**
         * Acks every message the consumer leaves unsettled when `deliver`
         * returns without throwing, in one transaction instead of one call
         * per message. Explicit `retry()` and `deadLetter()` still apply.
         */
        ackOnReturn?: boolean;
        storage?: never;
      }
    | { storage: MessageWrite<Body>; deliver?: never; ackOnReturn?: never }
  );

export type FanoutEnqueueOptions = {
  /** Omit for all static targets. Redrive specifies only the failed target. */
  targets?: readonly string[];
};

export type DurabilityFanoutConfig<Body> = SchedulerAttachment &
  ExecutionPolicyOptions & {
    targets: Record<string, FanoutTarget<Body>>;
    routing?: RoutingLoad;
    /** Receives terminal failures. Without it, terminal deliveries are dropped. */
    dlq?: MessageWrite<Body>;
    maxBatchSize?: number;
    /**
     * Holds first deliveries for up to this many milliseconds so messages
     * arriving together share a batch. Defaults to 0 (deliver immediately).
     */
    batchDelayMs?: number;
    onLifecycleEvent?: LifecycleHook;
  };

type DeadLetterReason = NonNullable<StoredMessage['failure']>['reason'];

type Claim = { row: DeliveryRow; message: FanoutMessageRow };
type Settlement = {
  claim: Claim;
  closed: boolean;
  finished?: boolean;
  completed?: boolean;
  outcome?: 'ack' | 'retry' | 'deadLetter';
  pending?: Promise<void>;
};

const infrastructureRetryMs = 60_000;

const entity = (claim: Claim): FanoutLifecycleEntity => ({
  entityKind: 'fanout_delivery',
  id: claim.message.id,
  target: claim.row.target_id,
  generation: claim.row.generation_id,
});

const deliveryIdentity = (row: DeliveryRow): string =>
  JSON.stringify([row.generation_id, row.target_id]);

/**
 * A composable DO capability: durable, independent delivery to static named
 * targets. Share a scheduler with operations/alarms on the same object.
 * Register targets under stable IDs; removing a target pauses its pending work.
 */
export class DurabilityFanout<Body = unknown> {
  readonly #engine: Engine;
  readonly #routing: RoutingLoad;
  readonly #targets: Map<string, FanoutTarget<Body>>;
  readonly #policies: Map<string, AttemptPolicy>;
  readonly #dlq: MessageWrite<Body> | undefined;
  readonly #maxBatchSize: number;
  readonly #batchDelayMs: number;
  readonly #emit: Emit;
  readonly #running = new Map<string, Promise<void>>();

  constructor(config: DurabilityFanoutConfig<Body>) {
    this.#maxBatchSize = config.maxBatchSize ?? 10;
    assertPositiveInteger('maxBatchSize', this.#maxBatchSize);
    this.#batchDelayMs = config.batchDelayMs ?? 0;
    if (!Number.isSafeInteger(this.#batchDelayMs) || this.#batchDelayMs < 0) {
      throw new RangeError('batchDelayMs must be a non-negative integer');
    }
    this.#targets = new Map(
      Object.entries(config.targets).map(([id, target]) => [id, { ...target }])
    );
    if (this.#targets.size === 0) {
      throw new TypeError('Fanout requires at least one static target');
    }
    this.#policies = new Map();
    for (const [id, target] of this.#targets) {
      if (
        !id ||
        (typeof target.deliver !== 'function' &&
          typeof target.storage !== 'function')
      ) {
        throw new TypeError(`Invalid fanout target "${id}"`);
      }
      this.#policies.set(
        id,
        createPolicyResolver(config, { [id]: target }, methodOptionsSchema)(id)
      );
    }
    this.#engine = engineFor(config);
    this.#routing = config.routing ?? new RoutingLoad();
    this.#dlq = config.dlq;
    this.#emit = this.#engine.emitter(config.onLifecycleEvent);
    this.#engine.migrateSchema('fanout', durabilityFanoutMigrations);
    this.#engine.register({ kind: 'deliveries', runDue: () => this.#runDue() });
  }

  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ) {
    return migrate(
      context.storage,
      'fanout',
      durabilityFanoutMigrations,
      target
    );
  }

  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#engine.alarm(info);
  }

  async load(): Promise<LoadSnapshot> {
    return this.#routing.snapshot(
      await this.#engine.storage.deliveries.pendingCount()
    );
  }

  /**
   * Atomically accepts the whole batch, including its frozen target set.
   * Definite input conflicts return success:false. Storage/commit uncertainty
   * throws: a transport failure is never represented as definite rejection.
   * IDs deduplicate while their registration is retained, not forever.
   */
  async enqueue(
    messages: FanoutInput<Body> | FanoutInput<Body>[],
    options: FanoutEnqueueOptions = {}
  ): Promise<EnqueueResult<string[]>> {
    const finish = this.#routing.begin('inbound');
    let entries: Array<{ key: string; id: string; payload: string }>;
    let targets: string[];
    try {
      targets = [...(options.targets ?? this.#targets.keys())].sort();
      if (
        targets.length === 0 ||
        new Set(targets).size !== targets.length ||
        targets.some((id) => !this.#targets.has(id))
      ) {
        throw new FanoutEnqueueError(
          'Enqueue targets must be distinct configured target IDs'
        );
      }
      entries = (Array.isArray(messages) ? messages : [messages]).map(
        (message) => {
          const id = message.id ?? crypto.randomUUID();
          const key = message.deduplicationKey ?? id;
          if (
            typeof id !== 'string' ||
            !id ||
            typeof key !== 'string' ||
            !key
          ) {
            throw new FanoutEnqueueError(
              'Message IDs and deduplication keys must be non-empty strings'
            );
          }
          return { key, id, payload: serialize(message.body) };
        }
      );
    } catch (error) {
      finish();
      return {
        success: false,
        error: serializeError(error),
        load: await this.load(),
      };
    }

    const registered: Claim[] = [];
    try {
      await this.#engine.transaction(async (transaction) => {
        registered.length = 0;
        const store = transaction.deliveries;
        for (const entry of entries) {
          // eslint-disable-next-line no-await-in-loop
          const existing = await store.getMessage(entry.key);
          if (existing) {
            if (
              existing.id !== entry.id ||
              existing.payload !== entry.payload ||
              existing.targets !== JSON.stringify(targets)
            ) {
              throw new FanoutEnqueueError(
                `Deduplication key "${entry.key}" already identifies different work`
              );
            }
            continue;
          }
          const message: FanoutMessageRow = {
            ...entry,
            targets: JSON.stringify(targets),
            remaining: targets.length,
            // eslint-disable-next-line no-await-in-loop
            seq: await store.nextSeq(),
            created_at: Date.now(),
            generation_id: crypto.randomUUID(),
          };
          // eslint-disable-next-line no-await-in-loop
          await store.insertMessage(message);
          for (const target of targets) {
            const row: DeliveryRow = {
              id: JSON.stringify([entry.key, target]),
              message_key: entry.key,
              target_id: target,
              seq: message.seq,
              generation_id: message.generation_id,
              created_at: message.created_at,
              status: 'pending',
              phase: 'delivery',
              attempt: 0,
              next_attempt_at: this.#firstAttemptAt(message.created_at),
              last_error: null,
              last_error_name: null,
              dead_lettered_at: null,
              dead_letter_reason: null,
            };
            // eslint-disable-next-line no-await-in-loop
            if (!(await store.insert(row))) {
              throw new Error('Fanout manifest and delivery state disagree');
            }
            registered.push({ row, message });
          }
        }
        await this.#engine.reconcile(transaction);
      });
    } catch (error) {
      if (!(error instanceof FanoutEnqueueError)) {
        throw error;
      }
      finish();
      return {
        success: false,
        error: serializeError(error),
        load: await this.load(),
      };
    } finally {
      finish();
    }

    for (const claim of registered) {
      this.#emit({
        ...entity(claim),
        type: 'registered',
        timestamp: claim.message.created_at,
        attempt: 0,
      });
    }
    const load = await this.load();
    // Delayed first attempts are not due yet; the scheduler wakes for them.
    if (registered.length > 0 && this.#batchDelayMs === 0) {
      const onError = (error: unknown) =>
        reportFailure('durability.fanout.failed', {}, error);
      const work = this.#runDue()
        .then(() => this.#engine.scheduleNextAlarm())
        .catch(onError);
      this.#engine.waitUntil(work, onError);
    }
    return { success: true, value: entries.map(({ id }) => id), load };
  }

  // Rounding up to a shared boundary makes every message in the window due together.
  #firstAttemptAt(createdAt: number): number {
    if (this.#batchDelayMs === 0) {
      return createdAt;
    }

    return Math.ceil(createdAt / this.#batchDelayMs) * this.#batchDelayMs;
  }

  async #runDue(): Promise<void> {
    const targets = await this.#engine.storage.deliveries.listTargets();
    // Each target advances independently; a missing or slow target cannot hide
    // another target behind a global LIMIT. Each pass processes one bounded batch.
    await Promise.all(
      targets.map((id) => {
        const running = this.#running.get(id);
        if (running) {
          return running;
        }
        const work = this.#runTarget(id).finally(() =>
          this.#running.delete(id)
        );
        this.#running.set(id, work);
        return work;
      })
    );
  }

  async #runTarget(id: string): Promise<void> {
    const release = await this.#engine.acquirePermit();
    try {
      const due = await this.#engine.storage.deliveries.listDueForTarget(
        id,
        Date.now(),
        this.#maxBatchSize
      );
      const target = this.#targets.get(id);
      const policy = this.#policies.get(id);
      if (!target || !policy) {
        if (due.length > 0) {
          reportFailure(
            'durability.fanout.target_missing',
            { target: id },
            new Error(`Target "${id}" is no longer configured; retaining work`)
          );
          await this.#postpone(due);
        }
        return;
      }
      const claims: Claim[] = [];
      for (const row of due) {
        // eslint-disable-next-line no-await-in-loop
        const message = await this.#engine.storage.deliveries.getMessage(
          row.message_key
        );
        if (!message || message.generation_id !== row.generation_id) {
          throw new Error('Fanout delivery is missing its message manifest');
        }
        if (row.phase === 'dead_letter' || row.attempt >= policy.maxAttempts) {
          // eslint-disable-next-line no-await-in-loop
          await this.#deadLetter(
            { row, message },
            row.dead_letter_reason ?? 'exhausted'
          );
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const attempt = await this.#engine.transaction(async (transaction) => {
          const claimed = await transaction.deliveries.claimAttempt(
            row.id,
            row.generation_id,
            policy.maxAttempts
          );
          if (claimed !== undefined) {
            await transaction.deliveries.settle(
              row.id,
              row.generation_id,
              claimed,
              {
                next_attempt_at: Date.now() + policy.attemptTimeoutMs,
              }
            );
            await this.#engine.reconcile(transaction);
          }
          return claimed;
        });
        if (attempt !== undefined) {
          claims.push({ row: { ...row, attempt }, message });
        }
      }
      if (claims.length > 0) {
        await this.#deliver(target, claims, policy);
      }
    } finally {
      release();
    }
  }

  async #postpone(rows: DeliveryRow[]): Promise<void> {
    await this.#engine.transaction(async (transaction) => {
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop
        await transaction.deliveries.settle(
          row.id,
          row.generation_id,
          row.attempt,
          {
            next_attempt_at: Date.now() + infrastructureRetryMs,
          }
        );
      }
      await this.#engine.reconcile(transaction);
    });
  }

  async #deliver(
    target: FanoutTarget<Body>,
    claims: Claim[],
    policy: AttemptPolicy
  ): Promise<void> {
    const startedAt = Date.now();
    const finish = this.#routing.begin('outbound');
    const states: Settlement[] = claims.map((claim) => ({
      claim,
      closed: false,
    }));
    const messages = states.map((state) =>
      this.#message(state, policy, startedAt)
    );
    for (const claim of claims) {
      this.#emit({
        ...entity(claim),
        type: 'attempt_started',
        timestamp: startedAt,
        attempt: claim.row.attempt,
      });
    }
    let failure: unknown = new Error(
      'Consumer returned without settling the message'
    );
    try {
      await this.#deadline(async () => {
        let invocationFailed = false;
        let invocationError: unknown;
        try {
          if (target.deliver) {
            await target.deliver(messages);
          } else {
            const writes = await Promise.allSettled(
              messages.map(async (message) => {
                await target.storage({
                  id: message.deliveryId,
                  messageId: message.id,
                  target: message.target,
                  body: message.body,
                  enqueuedAt: message.enqueuedAt,
                  storedAt: Date.now(),
                  attempts: message.attempt,
                });
                await message.ack();
              })
            );
            const rejected = writes.find(
              (write) => write.status === 'rejected'
            );
            if (rejected?.status === 'rejected') {
              throw rejected.reason;
            }
          }
        } catch (error) {
          invocationFailed = true;
          invocationError = error;
        }
        for (const state of states) {
          state.closed = true;
        }
        if (!invocationFailed && target.ackOnReturn) {
          this.#ackUnsettled(states, startedAt);
        }
        // A callback failure must not bypass already-started settlements.
        // The outer deadline still bounds a hung storage or RPC operation.
        const settlements = await Promise.allSettled(
          states.map((state) => state.pending)
        );
        if (invocationFailed) {
          throw invocationError;
        }
        const rejected = settlements.find(
          (settlement) => settlement.status === 'rejected'
        );
        if (rejected?.status === 'rejected') {
          throw rejected.reason;
        }
      }, policy.attemptTimeoutMs);
    } catch (error) {
      failure = error;
    } finally {
      for (const state of states) {
        state.closed = true;
      }
      finish();
    }
    for (const state of states) {
      if (state.completed) {
        continue;
      }
      if (state.outcome !== undefined) {
        // Pending actions retain their persisted claim deadline. Failed actions
        // may have committed despite throwing; consult state before retrying.
        if (!state.finished) {
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const current = await this.#engine.storage.deliveries.get(
          state.claim.row.id
        );
        if (
          !current ||
          current.generation_id !== state.claim.row.generation_id ||
          current.attempt !== state.claim.row.attempt ||
          current.phase === 'dead_letter'
        ) {
          continue;
        }
      }
      state.outcome = 'retry';
      // eslint-disable-next-line no-await-in-loop
      await this.#retry(
        state.claim,
        policy,
        undefined,
        serializeError(failure),
        startedAt
      );
    }
  }

  /** Acks every unsettled message of a batch in one transaction. */
  #ackUnsettled(states: Settlement[], startedAt: number): void {
    const unsettled = states.filter((state) => state.outcome === undefined);
    if (unsettled.length === 0) {
      return;
    }

    const removed = this.#engine.transaction(async (transaction) => {
      const ids = new Set<string>();
      for (const { claim } of unsettled) {
        // eslint-disable-next-line no-await-in-loop
        const deleted = await transaction.deliveries.remove(
          claim.row.id,
          claim.row.generation_id,
          claim.row.attempt
        );
        if (deleted) {
          ids.add(claim.row.id);
        }
      }
      await this.#engine.reconcile(transaction);
      return ids;
    });

    for (const state of unsettled) {
      state.outcome = 'ack';
      state.pending = removed
        .then((ids) => {
          // A row a later attempt already reclaimed stays with that attempt.
          if (!ids.has(state.claim.row.id)) {
            return undefined;
          }
          state.completed = true;
          this.#emit({
            ...entity(state.claim),
            type: 'attempt_settled',
            timestamp: Date.now(),
            attempt: state.claim.row.attempt,
            durationMs: Math.max(0, Date.now() - startedAt),
            outcome: 'completed',
          });
          return undefined;
        })
        .finally(() => {
          state.finished = true;
        });
      void state.pending.catch(() => undefined);
    }
  }

  #message(
    state: Settlement,
    policy: AttemptPolicy,
    startedAt: number
  ): DurabilityFanoutMessage<Body> {
    const { row, message } = state.claim;
    const settle = (
      outcome: NonNullable<Settlement['outcome']>,
      action: () => Promise<void>
    ): Promise<void> => {
      if (state.closed || state.outcome !== undefined) {
        return Promise.reject(
          new FanoutSettlementError(message.id, state.outcome)
        );
      }
      state.outcome = outcome;
      state.pending = action()
        .then(() => {
          state.completed = true;
          return undefined;
        })
        .finally(() => {
          state.finished = true;
        });
      void state.pending.catch(() => undefined);
      return state.pending;
    };
    return {
      id: message.id,
      deliveryId: deliveryIdentity(row),
      target: row.target_id,
      body: deserialize(message.payload) as Body,
      enqueuedAt: message.created_at,
      attempt: row.attempt,
      ack: () =>
        settle('ack', async () => {
          await this.#remove(row);
          this.#emit({
            ...entity(state.claim),
            type: 'attempt_settled',
            timestamp: Date.now(),
            attempt: row.attempt,
            durationMs: Math.max(0, Date.now() - startedAt),
            outcome: 'completed',
          });
        }),
      retry: (delayMs) => {
        if (
          delayMs !== undefined &&
          (!Number.isSafeInteger(delayMs) ||
            delayMs < 0 ||
            !Number.isSafeInteger(Date.now() + delayMs))
        ) {
          return Promise.reject(
            new RangeError(
              'delayMs must produce a non-negative safe-integer timestamp'
            )
          );
        }
        return settle('retry', () =>
          this.#retry(
            state.claim,
            policy,
            delayMs,
            { name: 'Retry', message: 'Retried by consumer' },
            startedAt
          )
        );
      },
      deadLetter: () =>
        settle('deadLetter', () => this.#deadLetter(state.claim, 'explicit')),
    };
  }

  async #remove(row: DeliveryRow): Promise<void> {
    await this.#engine.transaction(async (transaction) => {
      if (
        !(await transaction.deliveries.remove(
          row.id,
          row.generation_id,
          row.attempt
        ))
      ) {
        throw new FanoutSettlementError(row.id);
      }
      await this.#engine.reconcile(transaction);
    });
  }

  async #retry(
    claim: Claim,
    policy: AttemptPolicy,
    override: number | undefined,
    error: SerializedError,
    startedAt: number
  ): Promise<void> {
    const { row } = claim;
    if (row.attempt >= policy.maxAttempts) {
      await this.#deadLetter(claim, 'exhausted', error);
      return;
    }
    let nextAttemptAt: number;
    try {
      const rawDelay = override ?? policy.delay(row.attempt);
      const delay = Math.round(rawDelay);
      nextAttemptAt = Date.now() + delay;
      if (
        !Number.isFinite(rawDelay) ||
        rawDelay < 0 ||
        !Number.isSafeInteger(nextAttemptAt)
      ) {
        throw new DurableRetryPolicyError('fanout');
      }
    } catch (caught) {
      await this.#deadLetter(claim, 'exhausted', serializeError(caught));
      return;
    }
    await this.#engine.transaction(async (transaction) => {
      const updated = await transaction.deliveries.settle(
        row.id,
        row.generation_id,
        row.attempt,
        {
          next_attempt_at: nextAttemptAt,
          last_error: error.message,
          last_error_name: error.name,
        }
      );
      if (!updated) {
        throw new FanoutSettlementError(row.id);
      }
      await this.#engine.reconcile(transaction);
    });
    this.#emit({
      ...entity(claim),
      type: 'attempt_settled',
      timestamp: Date.now(),
      attempt: row.attempt,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome: 'retry_scheduled',
      nextAttemptAt,
      error,
    });
  }

  async #deadLetter(
    claim: Claim,
    reason: DeadLetterReason,
    failure?: SerializedError
  ): Promise<void> {
    const { row, message } = claim;
    const timestamp = row.dead_lettered_at ?? Date.now();
    const error =
      failure ??
      (row.last_error === null
        ? null
        : { name: row.last_error_name ?? 'Error', message: row.last_error });
    // Without a DLQ nothing could ever accept this delivery, and retrying the
    // dead-letter step would keep the object awake forever, so it is dropped.
    if (!this.#dlq) {
      await this.#remove(row);
      this.#emitTerminal(claim, reason, error);
      return;
    }
    // Persist intent BEFORE external I/O: eviction or timeout must never turn
    // a terminal decision into another consumer delivery.
    await this.#engine.transaction(async (transaction) => {
      const updated = await transaction.deliveries.settle(
        row.id,
        row.generation_id,
        row.attempt,
        {
          phase: 'dead_letter',
          dead_lettered_at: timestamp,
          dead_letter_reason: reason,
          next_attempt_at: Date.now() + infrastructureRetryMs,
          last_error: error?.message ?? null,
          last_error_name: error?.name ?? null,
        }
      );
      if (!updated) {
        throw new FanoutSettlementError(row.id);
      }
      await this.#engine.reconcile(transaction);
    });
    try {
      const stored: StoredMessage<Body> = {
        id: deliveryIdentity(row),
        messageId: message.id,
        target: row.target_id,
        body: deserialize(message.payload) as Body,
        enqueuedAt: message.created_at,
        storedAt: timestamp,
        attempts: row.attempt,
        failure: { reason, error },
      };
      await this.#deadline(() => this.#dlq!(stored), infrastructureRetryMs);
      await this.#remove(row);
      this.#emitTerminal(claim, reason, error);
    } catch (caught) {
      reportFailure(
        'durability.fanout.dead_letter_failed',
        { id: message.id, target: row.target_id },
        caught
      );
    }
  }

  #emitTerminal(
    claim: Claim,
    reason: DeadLetterReason,
    error: SerializedError | null
  ): void {
    this.#emit({
      ...entity(claim),
      type: 'terminal',
      timestamp: Date.now(),
      attempt: claim.row.attempt,
      reason: reason === 'explicit' ? 'dead_lettered' : 'attempts_exhausted',
      error: error ?? {
        name: 'DeadLetter',
        message: 'Dead-lettered by consumer',
      },
    });
  }

  async #deadline(
    run: () => Promise<unknown>,
    timeoutMs: number
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new FanoutTimeoutError(timeoutMs)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
