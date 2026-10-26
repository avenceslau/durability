import { z } from 'zod';
import { traceFunction, traceMethods } from './dev.js';
import {
  DurableRetryPolicyError,
  FanoutEnqueueError,
  FanoutSettlementError,
  FanoutTimeoutError,
  reportFailure,
  serializeError,
  type SerializedError,
} from './errors.js';
import {
  createLifecycleHooks,
  type DurabilityLifecycleEvent,
  type FanoutLifecycleEntity,
  type LifecycleHook,
  type LifecycleHooks,
} from './lifecycle.js';
import { RoutingLoad, type EnqueueResult, type LoadSnapshot } from './load.js';
import type { MessageWrite, StoredMessage } from './stored-message.js';
import {
  createMemoize,
  deleteMemos,
  deleteMemosOfDroppedTable,
  type DurableMemoize,
} from './memoize.js';
import {
  durabilityFanoutMigrations,
  durabilityMemoMigrations,
  migrateCapability,
} from './migrations.js';
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
import {
  claimAttempt,
  deleteAttempt,
  updateAttempt,
  type AttemptRef,
  type DurableTable,
} from './storage.js';

const fanoutMessageRowSchema = z.object({
  key: z.string(),
  id: z.string(),
  payload: z.string(),
  targets: z.string(),
  remaining: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  generation_id: z.string(),
});

type FanoutMessageRow = z.infer<typeof fanoutMessageRowSchema>;

const deliveryRowSchema = z.object({
  id: z.string(),
  message_key: z.string(),
  target_id: z.string(),
  seq: z.number().int().nonnegative(),
  status: z.literal('pending'),
  phase: z.enum(['delivery', 'dead_letter']),
  attempt: z.number().int().nonnegative(),
  next_attempt_at: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  last_error_name: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
  generation_id: z.string(),
  dead_lettered_at: z.number().int().nonnegative().nullable(),
  dead_letter_reason: z.enum(['explicit', 'exhausted']).nullable(),
});

type DeliveryRow = z.infer<typeof deliveryRowSchema>;

const deliveriesTable: DurableTable = {
  name: 'durability_fanout_deliveries',
  key: 'id',
};

const countRowSchema = z.object({ count: z.number().int().nonnegative() });
const seqRowSchema = z.object({ seq: z.number().int().nonnegative() });

const readManifest = (
  sql: SqlStorage,
  key: string
): FanoutMessageRow | undefined =>
  fanoutMessageRowSchema
    .optional()
    .parse(
      sql
        .exec('SELECT * FROM durability_fanout_messages WHERE key = ?', key)
        .toArray()[0]
    );

const attemptOf = (row: DeliveryRow): AttemptRef => ({
  key: row.id,
  generation: row.generation_id,
  attempt: row.attempt,
});

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
  /**
   * Persists a callback's result by key for this message and target, so a
   * retried delivery reuses it. Deleted when the delivery is acked or dead-lettered.
   */
  memoize: DurableMemoize;
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

/** A lifecycle event for one of this instance's deliveries. */
export type DurabilityFanoutEvent =
  | Extract<DurabilityLifecycleEvent, { entityKind: 'fanout_delivery' }>
  | Extract<DurabilityLifecycleEvent, { type: 'purged' }>;

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
  readonly #lifecycle: LifecycleHooks;
  readonly #emit: LifecycleHooks['emit'];
  readonly #running = new Map<string, Promise<void>>();
  /**
   * Cached pending-delivery count. Counting the table on every enqueue costs
   * O(backlog), which made a shard that fell behind fall further behind. It is
   * hydrated once and kept exact by inserts and removals; a failed transaction
   * may leave it wrong, so it is discarded and recounted on the next read.
   */
  #pending: number | undefined;

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
    this.#lifecycle = createLifecycleHooks(
      (hook) => this.#engine.emitter(hook),
      config.onLifecycleEvent
    );
    this.#emit = this.#lifecycle.emit;
    this.#engine.migrateSchema('fanout', durabilityFanoutMigrations);
    this.#engine.migrateSchema('memos', durabilityMemoMigrations);
    this.#engine.register({
      table: deliveriesTable,
      runDue: () => this.#runDue(),
    });
  }

  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ) {
    const result = migrateCapability(
      context.storage,
      'fanout',
      durabilityFanoutMigrations,
      target
    );
    deleteMemosOfDroppedTable(context.storage.sql, deliveriesTable);
    return result;
  }

  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#engine.alarm(info);
  }

  /**
   * Attaches a best-effort lifecycle hook alongside `onLifecycleEvent` and
   * returns a function that detaches it.
   */
  lifecycle(
    hook: (event: DurabilityFanoutEvent) => void | Promise<void>
  ): () => void {
    return this.#lifecycle.add(hook as LifecycleHook);
  }

  async load(): Promise<LoadSnapshot> {
    return this.#routing.snapshot(this.#pendingCount());
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

    let registered: Claim[];
    try {
      registered = await this.#transaction((sql) => {
        const claims: Claim[] = [];
        for (const entry of entries) {
          const existing = readManifest(sql, entry.key);
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
          const { seq } = seqRowSchema.parse(
            sql
              .exec(
                `UPDATE durability_fanout_seq
                 SET next_seq = next_seq + 1
                 WHERE id = 1
                 RETURNING next_seq - 1 AS seq`
              )
              .toArray()[0]
          );
          const message: FanoutMessageRow = {
            ...entry,
            targets: JSON.stringify(targets),
            remaining: targets.length,
            seq,
            created_at: Date.now(),
            generation_id: crypto.randomUUID(),
          };
          sql.exec(
            `INSERT INTO durability_fanout_messages
               (key, id, payload, targets, remaining, seq, created_at,
                generation_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            message.key,
            message.id,
            message.payload,
            message.targets,
            message.remaining,
            message.seq,
            message.created_at,
            message.generation_id
          );
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
            const inserted =
              sql
                .exec(
                  `INSERT INTO durability_fanout_deliveries
                     (id, message_key, target_id, seq, status, phase, attempt,
                      next_attempt_at, created_at, generation_id)
                   VALUES (?, ?, ?, ?, 'pending', 'delivery', 0, ?, ?, ?)
                   ON CONFLICT(id) DO NOTHING
                   RETURNING id`,
                  row.id,
                  row.message_key,
                  row.target_id,
                  row.seq,
                  row.next_attempt_at,
                  row.created_at,
                  row.generation_id
                )
                .toArray().length > 0;
            if (!inserted) {
              throw new Error('Fanout manifest and delivery state disagree');
            }
            this.#adjustPending(1);
            claims.push({ row, message });
          }
        }
        return claims;
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
    const targets = z
      .object({ target_id: z.string() })
      .array()
      .parse(
        this.#engine.sql
          .exec(
            `SELECT DISTINCT target_id FROM durability_fanout_deliveries
             ORDER BY target_id`
          )
          .toArray()
      )
      .map((row) => row.target_id);
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
      const due = this.#listDue(id, Date.now());
      if (due.length === 0) {
        return;
      }

      const target = this.#targets.get(id);
      const policy = this.#policies.get(id);
      if (!target || !policy) {
        reportFailure(
          'durability.fanout.target_missing',
          { target: id },
          new Error(`Target "${id}" is no longer configured; retaining work`)
        );
        await this.#postpone(due);
        return;
      }
      // One transaction claims the whole batch: per-message transactions made the
      // pass cost O(batch) commits, which capped a shard's throughput.
      const { claims, terminal } = await this.#transaction((sql) => {
        const claimed: Claim[] = [];
        const exhausted: Claim[] = [];
        const deadline = Date.now() + policy.attemptTimeoutMs;
        for (const row of due) {
          const message = readManifest(sql, row.message_key);
          if (!message || message.generation_id !== row.generation_id) {
            throw new Error('Fanout delivery is missing its message manifest');
          }
          if (
            row.phase === 'dead_letter' ||
            row.attempt >= policy.maxAttempts
          ) {
            exhausted.push({ row, message });
            continue;
          }
          const attempt = claimAttempt(
            sql,
            deliveriesTable,
            row.id,
            row.generation_id,
            policy.maxAttempts,
            deadline
          );
          if (attempt === undefined) {
            continue;
          }
          claimed.push({ row: { ...row, attempt }, message });
        }
        return { claims: claimed, terminal: exhausted };
      });
      for (const claim of terminal) {
        // eslint-disable-next-line no-await-in-loop
        await this.#deadLetter(
          claim,
          claim.row.dead_letter_reason ?? 'exhausted'
        );
      }
      if (claims.length > 0) {
        await this.#deliver(target, claims, policy);
      }
    } finally {
      release();
    }
  }

  async #postpone(rows: DeliveryRow[]): Promise<void> {
    await this.#transaction((sql) => {
      for (const row of rows) {
        updateAttempt(
          sql,
          deliveriesTable,
          attemptOf(row),
          'next_attempt_at = ?',
          Date.now() + infrastructureRetryMs
        );
      }
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
        const current = deliveryRowSchema
          .optional()
          .parse(
            this.#engine.sql
              .exec(
                'SELECT * FROM durability_fanout_deliveries WHERE id = ?',
                state.claim.row.id
              )
              .toArray()[0]
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

    const removed = this.#transaction((sql) => {
      const ids = new Set<string>();
      for (const { claim } of unsettled) {
        if (this.#removeDelivery(sql, claim.row)) {
          ids.add(claim.row.id);
        }
      }
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
    const identity = {
      deliveryId: deliveryIdentity(row),
      target: row.target_id,
    };
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
      ...identity,
      body: deserialize(message.payload) as Body,
      enqueuedAt: message.created_at,
      attempt: row.attempt,
      memoize: createMemoize(this.#engine.sql, deliveriesTable, attemptOf(row)),
      ack: traceFunction(
        'DurabilityFanoutMessage.ack',
        () =>
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
        identity
      ),
      retry: traceFunction(
        'DurabilityFanoutMessage.retry',
        (delayMs?: number) => {
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
        identity
      ),
      deadLetter: traceFunction(
        'DurabilityFanoutMessage.deadLetter',
        () =>
          settle('deadLetter', () => this.#deadLetter(state.claim, 'explicit')),
        identity
      ),
    };
  }

  async #remove(row: DeliveryRow): Promise<void> {
    await this.#transaction((sql) => {
      if (!this.#removeDelivery(sql, row)) {
        throw new FanoutSettlementError(row.id);
      }
    });
  }

  /** Deletes a delivery the attempt still owns and releases its manifest share. */
  #removeDelivery(sql: SqlStorage, row: DeliveryRow): boolean {
    if (!deleteAttempt(sql, deliveriesTable, attemptOf(row))) {
      return false;
    }
    deleteMemos(sql, deliveriesTable, row.id);

    this.#adjustPending(-1);
    sql.exec(
      `UPDATE durability_fanout_messages
       SET remaining = remaining - 1
       WHERE key = ?`,
      row.message_key
    );
    sql.exec(
      `DELETE FROM durability_fanout_messages
       WHERE key = ? AND remaining = 0`,
      row.message_key
    );
    return true;
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
    await this.#transaction((sql) => {
      const updated = updateAttempt(
        sql,
        deliveriesTable,
        attemptOf(row),
        'next_attempt_at = ?, last_error = ?, last_error_name = ?',
        nextAttemptAt,
        error.message,
        error.name
      );
      if (!updated) {
        throw new FanoutSettlementError(row.id);
      }
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
    await this.#transaction((sql) => {
      const updated = updateAttempt(
        sql,
        deliveriesTable,
        attemptOf(row),
        `phase = 'dead_letter', dead_lettered_at = ?, dead_letter_reason = ?,
         next_attempt_at = ?, last_error = ?, last_error_name = ?`,
        timestamp,
        reason,
        Date.now() + infrastructureRetryMs,
        error?.message ?? null,
        error?.name ?? null
      );
      if (!updated) {
        throw new FanoutSettlementError(row.id);
      }
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

  async #transaction<T>(write: (sql: SqlStorage) => T): Promise<T> {
    try {
      return await this.#engine.transaction(write);
    } catch (error) {
      this.#pending = undefined;
      throw error;
    }
  }

  #pendingCount(): number {
    this.#pending ??= countRowSchema.parse(
      this.#engine.sql
        .exec(
          `SELECT COUNT(*) AS count FROM durability_fanout_deliveries
           WHERE status = 'pending'`
        )
        .toArray()[0]
    ).count;
    return this.#pending;
  }

  #adjustPending(delta: number): void {
    if (this.#pending !== undefined) {
      this.#pending += delta;
    }
  }

  /**
   * First deliveries (attempt = 0) in sequence, then retries: two indexed
   * queries instead of one sort over every pending row.
   */
  #listDue(target: string, now: number): DeliveryRow[] {
    const first = deliveryRowSchema.array().parse(
      this.#engine.sql
        .exec(
          `SELECT * FROM durability_fanout_deliveries
           WHERE target_id = ? AND phase = 'delivery' AND status = 'pending'
             AND attempt = 0 AND next_attempt_at <= ?
           ORDER BY seq ASC
           LIMIT ?`,
          target,
          now,
          this.#maxBatchSize
        )
        .toArray()
    );
    if (first.length >= this.#maxBatchSize) {
      return first;
    }

    const retries = deliveryRowSchema.array().parse(
      this.#engine.sql
        .exec(
          `SELECT * FROM durability_fanout_deliveries
           WHERE target_id = ? AND status = 'pending'
             AND attempt > 0 AND next_attempt_at <= ?
           ORDER BY seq ASC
           LIMIT ?`,
          target,
          now,
          this.#maxBatchSize - first.length
        )
        .toArray()
    );
    return [...first, ...retries];
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

traceMethods(DurabilityFanout.prototype, 'DurabilityFanout');
