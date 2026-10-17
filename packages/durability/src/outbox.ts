import {
  OutboxTimeoutError,
  reportFailure,
  serializeError,
  type SerializedError,
} from './errors.js';
import type {
  DurabilityLifecycleEvent,
  Emit,
  LifecycleHook,
  OutboxLifecycleEntity,
} from './lifecycle.js';
import {
  durabilityOutboxMigrations,
  migrate,
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
import { deserialize, serialize } from './serialization.js';
import {
  claimAttempt,
  deleteAttempt,
  updateAttempt,
  type DurableTable,
} from './storage.js';
import { exponential, jitter } from './utils.js';
import { z } from 'zod';

const outboxTable: DurableTable = { name: 'durability_outbox', key: 'id' };

const outboxRowSchema = z.object({
  id: z.string(),
  channel: z.string(),
  entry_key: z.string(),
  version: z.number().int().positive(),
  payload: z.string(),
  status: z.literal('pending'),
  attempt: z.number().int().nonnegative(),
  next_attempt_at: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  last_error_name: z.string().nullable(),
  created_at: z.number().int().nonnegative(),
  generation_id: z.string(),
});

type OutboxRow = z.infer<typeof outboxRowSchema>;

const versionRowSchema = z.object({ version: z.number().int().positive() });
const channelRowSchema = z.object({ channel: z.string() });

const listDueForChannel = (
  sql: SqlStorage,
  channel: string,
  now: number,
  limit: number
): OutboxRow[] =>
  outboxRowSchema.array().parse(
    sql
      .exec(
        `SELECT * FROM durability_outbox
         WHERE channel = ? AND status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, version ASC
         LIMIT ?`,
        channel,
        now,
        limit
      )
      .toArray()
  );

/** Allocates a version from a durable counter that survives row deletion. */
const nextVersion = (sql: SqlStorage): number => {
  const { version } = versionRowSchema.parse(
    sql
      .exec(
        `UPDATE durability_outbox_seq
         SET next_version = next_version + 1
         WHERE id = 1
         RETURNING next_version - 1 AS version`
      )
      .toArray()[0]
  );
  if (!Number.isSafeInteger(version + 1)) {
    throw new RangeError('Outbox version exhausted');
  }
  return version;
};

/** The newest staged version of one key, handed to `publish`. */
export type OutboxEntry<Value> = {
  key: string;
  /** Monotonic across the whole Durable Object; newer stages are larger. */
  version: number;
  value: Value;
  /** One-based publication attempt for this version. */
  attempt: number;
  stagedAt: number;
  /**
   * Keeps this entry pending instead of acknowledging it when `publish`
   * returns. Only callable while `publish` is running.
   */
  retry(delayMs?: number): void;
};

export type DurabilityOutboxConfig<Value> = SchedulerAttachment & {
  /**
   * Stable channel ID. Outboxes on one scheduler share storage, partitioned by
   * channel, and each owns its own `publish`. Defaults to `default`.
   */
  channel?: string;
  /**
   * Publishes a batch of the newest pending versions. Returning acknowledges
   * every entry not marked with `retry()`; throwing retries the whole batch.
   * Sinks must be idempotent on `(key, version)` and keep the highest version.
   */
  publish(entries: OutboxEntry<Value>[]): unknown | Promise<unknown>;
  /** Defaults to 50. */
  maxBatchSize?: number;
  /**
   * Rounds first publication up to the next multiple of this delay so stages
   * within one window share a batch. Defaults to 0.
   */
  batchDelayMs?: number;
  /** Maximum duration of one `publish` call. Defaults to 60 seconds. */
  attemptTimeoutMs?: number;
  /** Publication is retried until acknowledged; only the delay is configurable. */
  retries?: Pick<DurabilityRetryOptions, 'delay'>;
  onLifecycleEvent?: LifecycleHook;
};

/** A lifecycle event for one of this outbox's entries. */
export type DurabilityOutboxEvent = Extract<
  DurabilityLifecycleEvent,
  { entityKind: 'outbox_entry' }
>;

type Channels = Map<string, () => Promise<void>>;

/**
 * Package-internal: stages inside a transaction another helper already holds,
 * so its reports commit atomically with that helper's own rows. Assigned by
 * the class's static block.
 */
export let stageWithin: <Value>(
  outbox: DurabilityOutbox<Value>,
  sql: SqlStorage,
  key: string,
  value: Value
) => number;

const infrastructureRetryMs = 60_000;
// setTimeout overflows past 2^31 - 1 ms, and it keeps every derived timestamp
// far inside the safe-integer range the storage indexes accept.
const maxDelayMs = 2 ** 31 - 1;
const orphanBatchSize = 50;
const channelsByEngine = new WeakMap<Engine, Channels>();

const rowId = (channel: string, key: string): string =>
  JSON.stringify([channel, key]);

const entity = (row: OutboxRow): OutboxLifecycleEntity => ({
  entityKind: 'outbox_entry',
  channel: row.channel,
  id: row.entry_key,
  generation: row.generation_id,
});

/**
 * Rows of a channel no outbox registers would stay due forever and keep the
 * alarm awake, so they are postponed like a removed fanout target's work.
 */
const postponeOrphans = async (
  engine: Engine,
  channels: Channels
): Promise<void> => {
  const orphans = channelRowSchema
    .array()
    .parse(
      engine.sql
        .exec('SELECT DISTINCT channel FROM durability_outbox ORDER BY channel')
        .toArray()
    )
    .map((row) => row.channel)
    .filter((channel) => !channels.has(channel));
  for (const channel of orphans) {
    const due = listDueForChannel(
      engine.sql,
      channel,
      Date.now(),
      orphanBatchSize
    );
    if (due.length === 0) {
      continue;
    }

    reportFailure(
      'durability.outbox.channel_missing',
      { channel },
      new Error(
        `Outbox channel "${channel}" is no longer configured; retaining entries`
      )
    );
    // eslint-disable-next-line no-await-in-loop
    await engine.transaction((sql) => {
      const postponedTo = Date.now() + infrastructureRetryMs;
      for (const row of due) {
        updateAttempt(
          sql,
          outboxTable,
          { key: row.id, generation: row.generation_id, attempt: row.attempt },
          'next_attempt_at = ?',
          postponedTo
        );
      }
    });
  }
};

/**
 * A composable DO capability: keyed latest-state publication. Stage the
 * newest value for a key in the same transaction as the state it describes;
 * the outbox republishes the newest version until `publish` acknowledges it.
 * Superseded versions are coalesced and may never be published.
 */
export class DurabilityOutbox<Value = unknown> {
  readonly #engine: Engine;
  readonly #channel: string;
  readonly #publish: DurabilityOutboxConfig<Value>['publish'];
  readonly #maxBatchSize: number;
  readonly #batchDelayMs: number;
  readonly #attemptTimeoutMs: number;
  readonly #delay: (attempt: number) => number;
  readonly #emit: Emit;
  #running: Promise<void> | undefined;

  constructor(config: DurabilityOutboxConfig<Value>) {
    this.#channel = config.channel ?? 'default';
    if (typeof this.#channel !== 'string' || this.#channel.length === 0) {
      throw new TypeError('Outbox channel must be a non-empty string');
    }
    if (typeof config.publish !== 'function') {
      throw new TypeError('Outbox requires a publish function');
    }
    this.#maxBatchSize = config.maxBatchSize ?? 50;
    assertPositiveInteger('maxBatchSize', this.#maxBatchSize);
    this.#batchDelayMs = config.batchDelayMs ?? 0;
    if (!Number.isSafeInteger(this.#batchDelayMs) || this.#batchDelayMs < 0) {
      throw new RangeError('batchDelayMs must be a non-negative integer');
    }
    this.#attemptTimeoutMs = config.attemptTimeoutMs ?? 60_000;
    assertPositiveInteger('attemptTimeoutMs', this.#attemptTimeoutMs);
    if (this.#attemptTimeoutMs > maxDelayMs) {
      throw new RangeError(`attemptTimeoutMs must be at most ${maxDelayMs}`);
    }
    if (this.#batchDelayMs > maxDelayMs) {
      throw new RangeError(`batchDelayMs must be at most ${maxDelayMs}`);
    }
    this.#delay =
      config.retries?.delay ?? ((attempt) => jitter(exponential(attempt)));
    this.#publish = config.publish;

    this.#engine = engineFor(config);
    this.#emit = this.#engine.emitter(config.onLifecycleEvent);
    this.#engine.migrateSchema('outbox', durabilityOutboxMigrations);
    this.#attach();
  }

  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ): DurabilityMigrationResult {
    return migrate(
      context.storage,
      'outbox',
      durabilityOutboxMigrations,
      target
    );
  }

  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#engine.alarm(info);
  }

  /**
   * Durably stages the newest value for `key` and returns its version. On a
   * SQLite-backed object, staging inside `ctx.storage.transaction()` commits
   * atomically with the application's own writes in that transaction.
   */
  async stage(key: string, value: Value): Promise<number> {
    const row = await this.#engine.transaction((sql) =>
      this.#stageIn(sql, key, value)
    );
    this.#emitRegistered(row);
    return row.version;
  }

  #stageIn(sql: SqlStorage, key: string, value: Value): OutboxRow {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('Outbox keys must be non-empty strings');
    }
    const payload = serialize(value);
    const version = nextVersion(sql);
    const createdAt = Date.now();
    const staged: OutboxRow = {
      id: rowId(this.#channel, key),
      channel: this.#channel,
      entry_key: key,
      version,
      payload,
      status: 'pending',
      attempt: 0,
      next_attempt_at: this.#firstAttemptAt(createdAt),
      last_error: null,
      last_error_name: null,
      created_at: createdAt,
      generation_id: String(version),
    };
    // Replacing the generation fences any in-flight publication of an older
    // version: its acknowledgement can no longer delete this row.
    sql.exec(
      `INSERT OR REPLACE INTO durability_outbox
       (id, channel, entry_key, version, payload, status, attempt,
        next_attempt_at, last_error, last_error_name, created_at, generation_id)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)`,
      staged.id,
      staged.channel,
      staged.entry_key,
      staged.version,
      staged.payload,
      staged.next_attempt_at,
      staged.created_at,
      staged.generation_id
    );
    return staged;
  }

  #emitRegistered(row: OutboxRow): void {
    this.#emit({
      ...entity(row),
      type: 'registered',
      timestamp: row.created_at,
      attempt: 0,
    });
  }

  static {
    stageWithin = (outbox, sql, key, value) => {
      const row = outbox.#stageIn(sql, key, value);
      outbox.#emitRegistered(row);
      return row.version;
    };
  }

  #attach(): void {
    let channels = channelsByEngine.get(this.#engine);
    if (!channels) {
      const created: Channels = new Map();
      const engine = this.#engine;
      engine.register({
        table: outboxTable,
        runDue: async () => {
          await Promise.all([...created.values()].map((run) => run()));
          await postponeOrphans(engine, created);
        },
      });
      channelsByEngine.set(engine, created);
      channels = created;
    }
    if (channels.has(this.#channel)) {
      throw new Error(
        `An outbox for channel "${this.#channel}" is already attached to this scheduler`
      );
    }
    channels.set(this.#channel, () => this.#runDue());
  }

  // Rounding up to a shared boundary makes every stage in the window due together.
  #firstAttemptAt(createdAt: number): number {
    if (this.#batchDelayMs === 0) {
      return createdAt;
    }

    return Math.ceil(createdAt / this.#batchDelayMs) * this.#batchDelayMs;
  }

  #runDue(): Promise<void> {
    this.#running ??= this.#runBatch().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #runBatch(): Promise<void> {
    // Every transaction reconciles the alarm; one per idle run keeps re-arming
    // it while anything else on the scheduler is due, such as a running operation.
    if (
      listDueForChannel(this.#engine.sql, this.#channel, Date.now(), 1)
        .length === 0
    ) {
      return;
    }
    const release = await this.#engine.acquirePermit();
    try {
      const claims = await this.#engine.transaction((sql) => {
        const due = listDueForChannel(
          sql,
          this.#channel,
          Date.now(),
          this.#maxBatchSize
        );
        const deadline = Date.now() + this.#attemptTimeoutMs;
        const claimed: OutboxRow[] = [];
        for (const row of due) {
          const attempt = claimAttempt(
            sql,
            outboxTable,
            row.id,
            row.generation_id,
            Number.MAX_SAFE_INTEGER
          );
          if (attempt === undefined) {
            continue;
          }
          // A crash mid-publication leaves the claim due again at the deadline.
          updateAttempt(
            sql,
            outboxTable,
            { key: row.id, generation: row.generation_id, attempt },
            'next_attempt_at = ?',
            deadline
          );
          claimed.push({ ...row, attempt });
        }
        return claimed;
      });

      if (claims.length > 0) {
        await this.#publishBatch(claims);
      }
    } finally {
      release();
    }
  }

  async #publishBatch(claims: OutboxRow[]): Promise<void> {
    const startedAt = Date.now();
    const retries = new Map<string, number | undefined>();
    let open = true;

    const entries = claims.map(
      (row): OutboxEntry<Value> => ({
        key: row.entry_key,
        version: row.version,
        value: deserialize(row.payload) as Value,
        attempt: row.attempt,
        stagedAt: row.created_at,
        retry: (delayMs) => {
          if (!open) {
            throw new Error(
              'Outbox entries can only be retried while publish is running'
            );
          }
          if (
            delayMs !== undefined &&
            (!Number.isSafeInteger(delayMs) ||
              delayMs < 0 ||
              delayMs > maxDelayMs)
          ) {
            throw new RangeError(
              `delayMs must be an integer from 0 to ${maxDelayMs}`
            );
          }
          retries.set(row.id, delayMs);
        },
      })
    );
    for (const row of claims) {
      this.#emit({
        ...entity(row),
        type: 'attempt_started',
        timestamp: startedAt,
        attempt: row.attempt,
      });
    }

    let failure: SerializedError | undefined;
    try {
      await this.#deadline(() => this.#publish(entries));
    } catch (error) {
      failure = serializeError(error);
    } finally {
      open = false;
    }

    const retryError = failure ?? {
      name: 'Retry',
      message: 'Retried by publisher',
    };
    const acknowledged: OutboxRow[] = [];
    const retried: Array<{ row: OutboxRow; nextAttemptAt: number }> = [];
    await this.#engine.transaction((sql) => {
      for (const row of claims) {
        const ref = {
          key: row.id,
          generation: row.generation_id,
          attempt: row.attempt,
        };
        if (failure === undefined && !retries.has(row.id)) {
          if (deleteAttempt(sql, outboxTable, ref)) {
            acknowledged.push(row);
          }
          continue;
        }

        const nextAttemptAt =
          Date.now() + (retries.get(row.id) ?? this.#retryDelay(row.attempt));
        const settled = updateAttempt(
          sql,
          outboxTable,
          ref,
          'next_attempt_at = ?, last_error = ?, last_error_name = ?',
          nextAttemptAt,
          retryError.message,
          retryError.name
        );
        if (settled) {
          retried.push({ row, nextAttemptAt });
        }
      }
    });

    const timestamp = Date.now();
    const durationMs = Math.max(0, timestamp - startedAt);
    for (const row of acknowledged) {
      this.#emit({
        ...entity(row),
        type: 'attempt_settled',
        timestamp,
        attempt: row.attempt,
        durationMs,
        outcome: 'completed',
      });
    }
    for (const { row, nextAttemptAt } of retried) {
      this.#emit({
        ...entity(row),
        type: 'attempt_settled',
        timestamp,
        attempt: row.attempt,
        durationMs,
        outcome: 'retry_scheduled',
        nextAttemptAt,
        error: retryError,
      });
    }
  }

  // A broken delay policy must not strand the entry: fall back to a fixed delay.
  #retryDelay(attempt: number): number {
    try {
      const delay = Math.round(this.#delay(attempt));
      if (Number.isSafeInteger(delay) && delay >= 0 && delay <= maxDelayMs) {
        return delay;
      }
    } catch (error) {
      reportFailure(
        'durability.outbox.retry_policy_failed',
        { channel: this.#channel },
        error
      );
    }
    return infrastructureRetryMs;
  }

  async #deadline(run: () => unknown): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new OutboxTimeoutError(this.#attemptTimeoutMs)),
            this.#attemptTimeoutMs
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
