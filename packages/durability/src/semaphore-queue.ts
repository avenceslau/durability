import { traceLifecycle, traceMethods } from './dev.js';
import { reportFailure, serializeError } from './errors.js';
import {
  durabilitySemaphoreQueueMigrations,
  migrate,
  type DurabilityMigrationResult,
} from './migrations.js';
import { DurabilityOutbox, stageWithin, type OutboxEntry } from './outbox.js';
import {
  assertPositiveInteger,
  type DurabilityRetryOptions,
} from './policy.js';
import {
  DurabilityScheduler,
  engineFor,
  type Engine,
  type SchedulerAttachment,
} from './scheduler.js';
import type {
  GrantReport,
  GrantResult,
  LeaseGrant,
  LeaseReport,
  PermitGrant,
  PermitRequest,
  PermitSync,
  PermitSyncResult,
  SemaphoreBlockedReason,
} from './semaphore-protocol.js';
import { deserialize, serialize } from './serialization.js';
import {
  QueueStore,
  type QueueGrantRow,
  type QueueItemRow,
  type QueueLeaseRow,
} from './semaphore-queue-store.js';
import type { DurableTable } from './storage.js';
import { exponential, jitter } from './utils.js';

const queueItemsTable: DurableTable = {
  name: 'durability_semaphore_queue_items',
  key: 'id',
};

export type SemaphoreInput<Body> = {
  /** Stable item ID; enqueueing a known ID again is a no-op. Defaults to random. */
  id?: string;
  /** Semaphore key: the name of the holder Durable Object, e.g. an account ID. */
  key: string;
  /** Optional sub-partition with its own ceiling at the holder. Defaults to ''. */
  group?: string;
  body: Body;
};

export type AdmittedItem<Body> = {
  id: string;
  key: string;
  group: string;
  body: Body;
  enqueuedAt: number;
  admittedAt: number;
  /** `grant`: confirmed by the holder; `lease`: drawn locally from a lease. */
  via: 'grant' | 'lease';
};

export type SemaphoreItemStatus =
  | { state: 'queued'; enqueuedAt: number; blocked?: SemaphoreBlockedReason }
  | { state: 'claiming'; enqueuedAt: number }
  | { state: 'admitted'; enqueuedAt: number; admittedAt: number };

/** What the queue needs from `DurabilitySemaphore.client()`. */
export type SemaphoreHolder = {
  request(key: string, message: PermitRequest): Promise<PermitGrant>;
  sync(key: string, message: PermitSync): Promise<PermitSyncResult>;
};

export type DurabilitySemaphoreQueueConfig<Body> = SchedulerAttachment & {
  /** The holder, from `DurabilitySemaphore.client()`; caller transforms apply. */
  server: SemaphoreHolder;
  /** Stable identity of this client Durable Object, e.g. `ctx.id.toString()`. */
  clientId: string;
  /**
   * Receives items once the holder has confirmed their permits, after the
   * admission commits. Retried until it returns; must be idempotent on item ID.
   */
  admit(items: AdmittedItem<Body>[]): unknown | Promise<unknown>;
  /**
   * Returns which of these admitted items are done. The queue asks on its own
   * alarm and releases them, so a permit whose `release()` was lost (a
   * best-effort lifecycle hook, a crash) still comes back. Without it,
   * `release()` is the only way a permit returns.
   */
  finished?(ids: string[]): string[] | Promise<string[]>;
  /** How long an admitted item runs before `finished` is asked, and between asks. Defaults to 60 seconds. */
  finishedCheckMs?: number;
  /** Items per `admit()` and `finished()` call. Defaults to 100. */
  maxAdmitBatch?: number;
  /** Maximum duration of one `admit()` call. Defaults to 60 seconds. */
  attemptTimeoutMs?: number;
  /** Backoff for failed `admit()` calls and holder requests. */
  retries?: Pick<DurabilityRetryOptions, 'delay'>;
  onLifecycleEvent?: (
    event: DurabilitySemaphoreQueueEvent
  ) => void | Promise<void>;
};

export type DurabilitySemaphoreQueueEvent =
  | {
      entityKind: 'semaphore_item';
      type: 'queued' | 'released' | 'cancelled';
      timestamp: number;
      id: string;
      key: string;
      group: string;
    }
  | {
      entityKind: 'semaphore_item';
      type: 'admitted';
      timestamp: number;
      id: string;
      key: string;
      group: string;
      waitMs: number;
    }
  | {
      entityKind: 'semaphore_item';
      type: 'blocked';
      timestamp: number;
      key: string;
      group: string;
      reason: SemaphoreBlockedReason;
      count: number;
    };

type Report =
  | { kind: 'grant'; claimed: number; released: number }
  | { kind: 'lease'; drawn: number; released: number; retired?: boolean };

const outboxChannel = 'durability.semaphore-queue';
/** Half the holder's default grantTimeoutMs. */
const maxReportRetryMs = 5_000;
/** Queued items read per key when building a request's demand. */
const demandScanLimit = 200;
const maxDelayMs = 2 ** 31 - 1;

const pairKey = (key: string, second: string): string =>
  JSON.stringify([key, second]);
const parsePairKey = (value: string): [string, string] =>
  JSON.parse(value) as [string, string];

const grantReport = (grant: QueueGrantRow): GrantReport => ({
  grantId: grant.grant_id,
  claimed: grant.claimed,
  released: grant.released,
});

// A lease stops drawing by moving its expiry to now, whoever retired it.
const retiredLocally = (lease: QueueLeaseRow, now: number): boolean =>
  lease.expires_at <= now;

const leaseReport = (lease: QueueLeaseRow): LeaseReport => ({
  leaseId: lease.lease_id,
  drawn: lease.drawn,
  released: lease.released,
  ...(retiredLocally(lease, Date.now()) ? { retired: true } : {}),
});

/**
 * The holder sweeps a lease at its expiry by its own clock; stopping local
 * draws this long before it bounds the window a skewed clock could open.
 */
const leaseDrawMarginMs = 30_000;

/**
 * Renews at half the lifetime the holder last gave the lease. The holder
 * sweeps a lease nobody reports, and a lease with permits in use must not be
 * swept while its work runs: the holder would lease those permits again.
 */
const renewal = (
  now: number,
  expiresAt: number
): Pick<QueueLeaseRow, 'renew_at' | 'renew_ms'> => {
  const renewMs = Math.max(1_000, Math.floor((expiresAt - now) / 2));
  return { renew_at: now + renewMs, renew_ms: renewMs };
};

const drawable = (lease: QueueLeaseRow, now: number): boolean =>
  lease.drawn < lease.permits && lease.expires_at - leaseDrawMarginMs > now;

/**
 * A composable DO capability for the client side of {@link DurabilitySemaphore}:
 * queues items per semaphore key in arrival order, asks the holder for
 * permits, and hands admitted items to the application. Claims and releases
 * are published to the holder through an internal outbox channel as
 * cumulative counts, so nothing is lost or double-counted across retries.
 */
export class DurabilitySemaphoreQueue<Body = unknown> {
  readonly #engine: Engine;
  readonly #store: QueueStore;
  readonly #server: SemaphoreHolder;
  readonly #clientId: string;
  readonly #admit: DurabilitySemaphoreQueueConfig<Body>['admit'];
  readonly #finished: DurabilitySemaphoreQueueConfig<Body>['finished'];
  readonly #finishedCheckMs: number;
  readonly #maxAdmitBatch: number;
  readonly #attemptTimeoutMs: number;
  readonly #delay: (attempt: number) => number;
  readonly #emit: (event: DurabilitySemaphoreQueueEvent) => void;
  readonly #outbox: DurabilityOutbox<Report>;
  readonly #requesting = new Set<string>();
  readonly #blocked = new Map<string, SemaphoreBlockedReason>();
  #notifying: Promise<void> | undefined;
  #checking: Promise<void> | undefined;

  constructor(config: DurabilitySemaphoreQueueConfig<Body>) {
    if (typeof config.clientId !== 'string' || config.clientId.length === 0) {
      throw new TypeError('clientId must be a non-empty string');
    }
    if (typeof config.admit !== 'function') {
      throw new TypeError('Semaphore queue requires an admit function');
    }
    this.#server = config.server;
    this.#clientId = config.clientId;
    this.#admit = config.admit;
    if (
      config.finished !== undefined &&
      typeof config.finished !== 'function'
    ) {
      throw new TypeError('finished must be a function');
    }
    this.#finished = config.finished;
    this.#finishedCheckMs = config.finishedCheckMs ?? 60_000;
    assertPositiveInteger('finishedCheckMs', this.#finishedCheckMs);
    if (this.#finishedCheckMs > maxDelayMs) {
      throw new RangeError(`finishedCheckMs must be at most ${maxDelayMs}`);
    }
    this.#maxAdmitBatch = config.maxAdmitBatch ?? 100;
    assertPositiveInteger('maxAdmitBatch', this.#maxAdmitBatch);
    this.#attemptTimeoutMs = config.attemptTimeoutMs ?? 60_000;
    assertPositiveInteger('attemptTimeoutMs', this.#attemptTimeoutMs);
    if (this.#attemptTimeoutMs > maxDelayMs) {
      throw new RangeError(`attemptTimeoutMs must be at most ${maxDelayMs}`);
    }
    this.#delay =
      config.retries?.delay ?? ((attempt) => jitter(exponential(attempt)));

    // The internal outbox must share this helper's engine, so a private
    // scheduler is created explicitly instead of letting each attach its own.
    const scheduler = config.scheduler ?? new DurabilityScheduler(config);
    this.#engine = engineFor({ scheduler });
    this.#store = new QueueStore(this.#engine.sql);
    this.#emit = traceLifecycle(
      this.#engine.emitter<DurabilitySemaphoreQueueEvent>(
        config.onLifecycleEvent
      )
    );
    this.#engine.migrateSchema(
      'semaphoreQueue',
      durabilitySemaphoreQueueMigrations
    );
    this.#outbox = new DurabilityOutbox<Report>({
      scheduler,
      channel: outboxChannel,
      publish: (entries) => this.#publishReports(entries),
      // A claim the holder has not heard about within its grant window is
      // reclaimed, so reports retry well inside it instead of backing off for minutes.
      retries: {
        delay: (attempt) =>
          Math.min(this.#retryDelay(attempt), maxReportRetryMs),
      },
    });
    this.#engine.register({
      table: queueItemsTable,
      runDue: (now) => this.#runDue(now),
      nextPendingAt: () =>
        this.#store.nextPendingAt(this.#finished !== undefined),
    });
  }

  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ): DurabilityMigrationResult {
    return migrate(
      context.storage,
      'semaphoreQueue',
      durabilitySemaphoreQueueMigrations,
      target
    );
  }

  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#engine.alarm(info);
  }

  /**
   * Durably accepts items. Each is admitted once the holder confirms a
   * permit; items whose key already holds unclaimed permits skip the request.
   */
  async enqueue(
    items: readonly SemaphoreInput<Body>[]
  ): Promise<{ queued: string[]; duplicates: string[] }> {
    const rows = items.map((item): QueueItemRow => {
      const id = item.id ?? crypto.randomUUID();
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        typeof item.key !== 'string' ||
        item.key.length === 0 ||
        (item.group !== undefined && typeof item.group !== 'string')
      ) {
        throw new TypeError(
          'Semaphore items need a non-empty id, a semaphore key, and a string group'
        );
      }
      const now = Date.now();
      return {
        id,
        key: item.key,
        grp: item.group ?? '',
        payload: serialize(item.body),
        status: 'queued',
        grant_id: null,
        lease_id: null,
        created_at: now,
        admitted_at: null,
        notified: 0,
        attempt: 0,
        next_attempt_at: now,
      };
    });

    const { queued, duplicates } = await this.#engine.transaction(() => {
      const store = this.#store;
      const inserted: QueueItemRow[] = [];
      const existing: string[] = [];
      for (const row of rows) {
        if (store.insertItem(row)) {
          inserted.push(row);
        } else {
          existing.push(row.id);
        }
      }
      for (const key of new Set(inserted.map((row) => row.key))) {
        this.#claimLocally(key);
        this.#refreshKey(key);
      }
      return { queued: inserted, duplicates: existing };
    });

    for (const row of queued) {
      this.#emit({
        entityKind: 'semaphore_item',
        type: 'queued',
        timestamp: row.created_at,
        id: row.id,
        key: row.key,
        group: row.grp,
      });
    }
    return { queued: queued.map((row) => row.id), duplicates };
  }

  /** The item finished: its permit returns to the holder. Idempotent. */
  async release(id: string): Promise<boolean> {
    const released = await this.#engine.transaction(() => {
      const store = this.#store;
      const item = store.getItem(id);
      if (!item || item.status !== 'admitted') {
        return undefined;
      }
      store.removeItem(id);
      if (item.lease_id !== null) {
        const lease = store.getLease(item.lease_id);
        if (lease) {
          const returned = lease.released + 1;
          // A spent lease is retired; its row is dropped later, in #runDue.
          const updated = {
            ...lease,
            released: returned,
            expires_at:
              returned >= lease.permits
                ? Math.min(lease.expires_at, Date.now())
                : lease.expires_at,
          };
          store.updateLease(updated);
          this.#stageLeaseReport(updated);
        }
      } else if (item.grant_id !== null) {
        const grant = store.getGrant(item.grant_id);
        if (grant) {
          const updated = { ...grant, released: grant.released + 1 };
          store.updateGrant(updated);
          this.#stageReport(updated);
        }
      }
      return item;
    });
    if (!released) {
      return false;
    }

    this.#emit({
      entityKind: 'semaphore_item',
      type: 'released',
      timestamp: Date.now(),
      id,
      key: released.key,
      group: released.grp,
    });
    return true;
  }

  /** Removes a still-queued item. False once it counts against a grant. */
  async cancel(id: string): Promise<boolean> {
    const cancelled = await this.#engine.transaction(() => {
      const store = this.#store;
      const item = store.getItem(id);
      if (!item || item.status !== 'queued') {
        return undefined;
      }
      store.removeItem(id);
      this.#refreshKey(item.key);
      return item;
    });
    if (!cancelled) {
      return false;
    }

    this.#emit({
      entityKind: 'semaphore_item',
      type: 'cancelled',
      timestamp: Date.now(),
      id,
      key: cancelled.key,
      group: cancelled.grp,
    });
    return true;
  }

  async status(id: string): Promise<SemaphoreItemStatus | undefined> {
    const item = this.#store.getItem(id);
    if (!item) {
      return undefined;
    }
    if (item.status === 'admitted') {
      return {
        state: 'admitted',
        enqueuedAt: item.created_at,
        admittedAt: item.admitted_at ?? item.created_at,
      };
    }
    if (item.status === 'claiming') {
      return { state: 'claiming', enqueuedAt: item.created_at };
    }
    const blocked = this.#blocked.get(pairKey(item.key, item.grp));
    return blocked === undefined
      ? { state: 'queued', enqueuedAt: item.created_at }
      : { state: 'queued', enqueuedAt: item.created_at, blocked };
  }

  async usage(): Promise<Record<QueueItemRow['status'], number>> {
    return this.#store.countItems();
  }

  async #runDue(now: number): Promise<void> {
    // A spent lease row is kept as long as a late reply could still refer to
    // it; deleted sooner, an older echo of the live lease would insert it again.
    this.#engine.transactionSync(() => {
      this.#store.removeSpentLeases(now - this.#attemptTimeoutMs);
    });
    const keys = this.#store.listDueKeys(now);
    await Promise.all([
      this.#notify(),
      this.#releaseFinished(now),
      this.#renewLeases(now),
    ]);
    await Promise.all(
      keys
        .filter(({ key }) => !this.#requesting.has(key))
        .map(({ key }) => this.#request(key))
    );
  }

  /** Best effort: if this write fails too, the request deadline still applies. */
  async #retrySoon(key: string, queued: number): Promise<void> {
    await this.#engine
      .transaction(() => {
        const current = this.#store.getKey(key);
        this.#store.upsertKey({
          key,
          queued: current?.queued ?? queued,
          next_request_at: Date.now() + this.#retryDelay(1),
        });
      })
      .catch(() => undefined);
  }

  /** Asks the holder for permits covering this key's queued items. */
  async #request(key: string): Promise<void> {
    this.#requesting.add(key);
    try {
      const store = this.#store;
      const queued = store.listItems(key, 'queued', demandScanLimit);
      const grants = store.listGrants(key);
      const leases = store.listLeases(key);
      if (queued.length === 0) {
        await this.#engine.transaction(() => {
          this.#refreshKey(key);
        });
        return;
      }

      const demand = new Map<string, { count: number; oldestAt: number }>();
      for (const item of queued) {
        const entry = demand.get(item.grp) ?? {
          count: 0,
          oldestAt: item.created_at,
        };
        entry.count += 1;
        entry.oldestAt = Math.min(entry.oldestAt, item.created_at);
        demand.set(item.grp, entry);
      }
      const message: PermitRequest = {
        type: 'request',
        v: 1,
        clientId: this.#clientId,
        demand: [...demand].map(([group, entry]) => ({ group, ...entry })),
        grants: grants.map(grantReport),
        // Always present: it opts this client into leases when the holder offers them.
        leases: leases.map(leaseReport),
      };

      // While the holder holds the request for its round, the key must not
      // look due: the alarm would find it skipped and re-arm at once, spinning
      // for the whole wait. A crash mid-request leaves it due at the deadline.
      await this.#engine.transaction(() => {
        this.#store.upsertKey({
          key,
          queued: queued.length,
          next_request_at: Date.now() + this.#attemptTimeoutMs,
        });
      });

      let grant: PermitGrant;
      try {
        grant = await this.#deadline('request', () =>
          this.#server.request(key, message)
        );
      } catch (error) {
        reportFailure(
          'durability.semaphore_queue.request_failed',
          { key },
          error
        );
        await this.#retrySoon(key, queued.length);
        return;
      }

      try {
        await this.#engine.transaction(() => {
          const txStore = this.#store;
          for (const given of grant.grants) {
            txStore.insertGrant({
              grant_id: given.grantId,
              key,
              grp: given.group,
              permits: given.permits,
              claimed: 0,
              confirmed: 0,
              admitted: 0,
              released: 0,
              created_at: Date.now(),
            });
          }
          this.#applyLeaseGrants(key, grant.leases ?? []);
          this.#claimLocally(key);
          this.#applyResults(key, grant.grantResults);
          if (grant.contended) {
            this.#returnIdleLeases(key);
          }
          const remaining = this.#refreshKey(key, grant.nextRequestAt);
          for (const group of new Set(remaining.map((item) => item.grp))) {
            this.#blocked.delete(pairKey(key, group));
          }
          for (const { group, reason } of grant.blocked) {
            this.#blocked.set(pairKey(key, group), reason);
          }
        });
      } catch (error) {
        // The grant is lost with the transaction; ask again soon rather than
        // at the request deadline, which only covers a crash.
        await this.#retrySoon(key, queued.length);
        throw error;
      }

      const counts = new Map<string, number>();
      for (const item of store.listItems(key, 'queued', demandScanLimit)) {
        counts.set(item.grp, (counts.get(item.grp) ?? 0) + 1);
      }
      for (const { group, reason } of grant.blocked) {
        const count = counts.get(group) ?? 0;
        if (count > 0) {
          this.#emit({
            entityKind: 'semaphore_item',
            type: 'blocked',
            timestamp: Date.now(),
            key,
            group,
            reason,
            count,
          });
        }
      }
    } finally {
      this.#requesting.delete(key);
    }
  }

  /**
   * Counts queued items against grants with unclaimed permits, oldest first,
   * and stages the new claim counts for the holder.
   */
  #claimLocally(key: string): void {
    const store = this.#store;
    const grants = store
      .listGrants(key)
      .filter((grant) => grant.claimed < grant.permits);
    if (grants.length === 0) {
      this.#drawLeases(key);
      return;
    }
    const queued = store.listItems(key, 'queued', demandScanLimit);
    const touched = new Map<string, QueueGrantRow>();
    for (const item of queued) {
      const grant = grants.find(
        (candidate) =>
          candidate.grp === item.grp && candidate.claimed < candidate.permits
      );
      if (!grant) {
        continue;
      }
      grant.claimed += 1;
      touched.set(grant.grant_id, grant);
      store.updateItem({
        ...item,
        status: 'claiming',
        grant_id: grant.grant_id,
      });
    }
    for (const grant of touched.values()) {
      store.updateGrant(grant);
      this.#stageReport(grant);
    }
    this.#drawLeases(key);
  }

  /**
   * Admits queued items against leases with undrawn permits, oldest first,
   * with no round trip. A drawn permit is one-shot: releasing the item frees
   * footprint at the holder but never makes the permit drawable again.
   */
  #drawLeases(key: string): void {
    const store = this.#store;
    const now = Date.now();
    const leases = store
      .listLeases(key)
      .filter((lease) => drawable(lease, now));
    if (leases.length === 0) {
      return;
    }
    const queued = store.listItems(key, 'queued', demandScanLimit);
    const touched = new Map<string, QueueLeaseRow>();
    for (const item of queued) {
      const lease = leases.find(
        (candidate) => candidate.grp === item.grp && drawable(candidate, now)
      );
      if (!lease) {
        continue;
      }
      lease.drawn += 1;
      touched.set(lease.lease_id, lease);
      store.updateItem({
        ...item,
        status: 'admitted',
        lease_id: lease.lease_id,
        admitted_at: now,
        notified: 0,
        attempt: 0,
        next_attempt_at: now,
      });
    }
    for (const lease of touched.values()) {
      store.updateLease(lease);
      this.#stageLeaseReport(lease);
    }
  }

  /**
   * Returns the undrawn permits of leases in groups with nothing queued, so a
   * contended holder can lease them to waiting clients. Draws stop before the
   * report is staged, so the holder never frees a permit this client can use.
   */
  #returnIdleLeases(key: string): void {
    const store = this.#store;
    const now = Date.now();
    const waiting = new Set(
      store.listItems(key, 'queued', demandScanLimit).map((item) => item.grp)
    );
    for (const lease of store.listLeases(key)) {
      if (
        retiredLocally(lease, now) ||
        lease.drawn >= lease.permits ||
        waiting.has(lease.grp)
      ) {
        continue;
      }
      const returned = { ...lease, permits: lease.drawn, expires_at: now };
      store.updateLease(returned);
      this.#stageLeaseReport(returned);
    }
  }

  /**
   * Records leases the holder granted or refreshed; `expiresAt <= now`
   * retires a lease, so it shrinks to what was drawn and is dropped once
   * those items release.
   */
  #applyLeaseGrants(key: string, grants: LeaseGrant[]): void {
    const store = this.#store;
    const now = Date.now();
    for (const grant of grants) {
      const lease = store.getLease(grant.leaseId);
      if (grant.expiresAt <= now) {
        if (!lease) {
          continue;
        }
        if (retiredLocally(lease, now)) {
          // The holder settles a stopped lease by echoing it with nothing left
          // counted; until then this client keeps reporting it.
          if (grant.permits <= lease.released && !lease.confirmed) {
            store.updateLease({ ...lease, confirmed: 1 });
          }
          continue;
        }
        // The holder keeps counting the whole lease until this report says
        // how much was drawn by the time drawing stopped.
        const retired = { ...lease, permits: lease.drawn, expires_at: now };
        store.updateLease(retired);
        this.#stageLeaseReport(retired);
        continue;
      }
      if (lease) {
        // A refresh sent before this client retired the lease must not revive it.
        if (!retiredLocally(lease, now)) {
          store.updateLease({
            ...lease,
            expires_at: grant.expiresAt,
            ...renewal(now, grant.expiresAt),
          });
        }
        continue;
      }
      store.insertLease({
        lease_id: grant.leaseId,
        key,
        grp: grant.group,
        permits: grant.permits,
        drawn: 0,
        released: 0,
        created_at: now,
        expires_at: grant.expiresAt,
        ...renewal(now, grant.expiresAt),
        confirmed: 0,
      });
    }
  }

  /**
   * Reports leases with permits in use before the holder retires them, and
   * stopped leases until the holder settles them.
   */
  async #renewLeases(now: number): Promise<void> {
    // An idle run must not write: every transaction reconciles the alarm.
    if (this.#store.listRenewalsDue(now, 1).length === 0) {
      return;
    }
    await this.#engine.transaction(() => {
      for (const lease of this.#store.listRenewalsDue(now, 100)) {
        this.#store.updateLease({ ...lease, renew_at: now + lease.renew_ms });
        this.#stageLeaseReport(lease);
      }
    });
  }

  /**
   * Applies the holder's confirmations: newly confirmed claims admit the
   * oldest claiming items; clamped or forgotten grants return their
   * unconfirmed items to the queue. Progress is tracked on the grant row, so
   * released (deleted) items never shift which claims count as confirmed.
   */
  #applyResults(key: string, results: GrantResult[]): void {
    const store = this.#store;
    const now = Date.now();
    for (const result of results) {
      const grant = store.getGrant(result.grantId);
      if (!grant || grant.key !== key) {
        continue;
      }
      const claiming = store
        .listItemsByGrant(grant.grant_id)
        .filter((item) => item.status === 'claiming');

      const confirmed =
        result.status === 'not_found'
          ? grant.admitted
          : Math.max(grant.confirmed, result.claimed);
      const admitNow = claiming.slice(
        0,
        Math.max(0, confirmed - grant.admitted)
      );
      for (const item of admitNow) {
        store.updateItem({
          ...item,
          status: 'admitted',
          admitted_at: now,
          notified: 0,
          attempt: 0,
          next_attempt_at: now,
        });
      }
      let updated: QueueGrantRow = {
        ...grant,
        confirmed,
        admitted: grant.admitted + admitNow.length,
      };
      if (result.status !== 'ok') {
        // The holder reclaimed (or forgot) what was not confirmed: those items
        // queue again, and the grant shrinks to what was actually admitted.
        for (const item of claiming.slice(admitNow.length)) {
          store.updateItem({ ...item, status: 'queued', grant_id: null });
        }
        updated = {
          ...updated,
          permits: updated.admitted,
          claimed: updated.admitted,
          confirmed: updated.admitted,
        };
      }
      if (
        updated.released >= updated.permits &&
        updated.confirmed >= updated.permits
      ) {
        store.removeGrant(grant.grant_id);
      } else {
        store.updateGrant(updated);
      }
    }
  }

  /**
   * Recomputes the key's queued count and remembers the holder's pacing even
   * while nothing is queued, so requeued items wait for `nextRequestAt`.
   */
  #refreshKey(key: string, nextRequestAt?: number): QueueItemRow[] {
    const store = this.#store;
    const queued = store.listItems(key, 'queued', demandScanLimit);
    const current = store.getKey(key);
    if (queued.length === 0 && !current && nextRequestAt === undefined) {
      return queued;
    }
    store.upsertKey({
      key,
      queued: queued.length,
      next_request_at: nextRequestAt ?? current?.next_request_at ?? Date.now(),
    });
    return queued;
  }

  #stageReport(grant: QueueGrantRow): void {
    stageWithin(
      this.#outbox,
      this.#engine.sql,
      pairKey(grant.key, `grant:${grant.grant_id}`),
      { kind: 'grant', claimed: grant.claimed, released: grant.released }
    );
  }

  #stageLeaseReport(lease: QueueLeaseRow): void {
    stageWithin(
      this.#outbox,
      this.#engine.sql,
      pairKey(lease.key, `lease:${lease.lease_id}`),
      {
        kind: 'lease',
        drawn: lease.drawn,
        released: lease.released,
        ...(retiredLocally(lease, Date.now()) ? { retired: true } : {}),
      }
    );
  }

  /** Outbox sink: one `sync` per key; a failed key keeps its entries pending. */
  async #publishReports(entries: OutboxEntry<Report>[]): Promise<void> {
    const byKey = new Map<string, OutboxEntry<Report>[]>();
    for (const entry of entries) {
      const [key] = parsePairKey(entry.key);
      byKey.set(key, [...(byKey.get(key) ?? []), entry]);
    }
    await Promise.all(
      [...byKey].map(async ([key, keyEntries]) => {
        const grants: GrantReport[] = [];
        const leases: LeaseReport[] = [];
        for (const entry of keyEntries) {
          const id = parsePairKey(entry.key)[1].slice(
            entry.value.kind.length + 1
          );
          if (entry.value.kind === 'grant') {
            grants.push({
              grantId: id,
              claimed: entry.value.claimed,
              released: entry.value.released,
            });
          } else {
            leases.push({
              leaseId: id,
              drawn: entry.value.drawn,
              released: entry.value.released,
              ...(entry.value.retired ? { retired: true } : {}),
            });
          }
        }
        let synced: PermitSyncResult;
        try {
          synced = await this.#deadline('sync', () =>
            this.#server.sync(key, {
              type: 'sync',
              v: 1,
              clientId: this.#clientId,
              grants,
              leases,
            })
          );
        } catch (error) {
          reportFailure(
            'durability.semaphore_queue.sync_failed',
            { key },
            error
          );
          for (const entry of keyEntries) {
            entry.retry();
          }
          return;
        }
        await this.#engine.transaction(() => {
          this.#applyResults(key, synced.grantResults);
          this.#applyLeaseGrants(key, synced.leases ?? []);
          if (synced.contended) {
            this.#returnIdleLeases(key);
          }
          this.#refreshKey(key);
        });
      })
    );
    const onError = (error: unknown) =>
      reportFailure('durability.semaphore_queue.notify_failed', {}, error);
    this.#engine.waitUntil(this.#notify().catch(onError), onError);
  }

  /** Releases admitted items `finished` reports done, one check at a time. */
  #releaseFinished(now: number): Promise<void> {
    this.#checking ??= this.#checkFinished(now).finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  async #checkFinished(now: number): Promise<void> {
    const finished = this.#finished;
    // An idle run must not write: every transaction reconciles the alarm.
    if (!finished || this.#store.listCheckDue(now, 1).length === 0) {
      return;
    }
    // Schedule the next check before asking, as admit() claims its batch: rows
    // left due while finished() runs would re-arm the alarm at once.
    const later = now + this.#finishedCheckMs;
    const due = await this.#engine.transaction(() => {
      const rows = this.#store.listCheckDue(now, this.#maxAdmitBatch);
      for (const row of rows) {
        this.#store.updateItem({ ...row, next_attempt_at: later });
      }
      return rows;
    });
    if (due.length === 0) {
      return;
    }
    let done: string[] = [];
    try {
      done = await this.#deadline('finished', () =>
        finished(due.map((row) => row.id))
      );
    } catch (error) {
      reportFailure(
        'durability.semaphore_queue.finished_failed',
        { count: due.length },
        error
      );
    }
    const asked = new Set(due.map((row) => row.id));
    for (const id of new Set(done)) {
      if (asked.has(id)) {
        // eslint-disable-next-line no-await-in-loop
        await this.release(id);
      }
    }
  }

  /** Hands admitted, unnotified items to `admit()`, one batch at a time. */
  #notify(): Promise<void> {
    this.#notifying ??= this.#notifyBatch().finally(() => {
      this.#notifying = undefined;
    });
    return this.#notifying;
  }

  async #notifyBatch(): Promise<void> {
    const store = this.#store;
    const due = store.listUnnotified(Date.now(), this.#maxAdmitBatch);
    if (due.length === 0) {
      return;
    }
    const release = await this.#engine.acquirePermit();
    try {
      const deadline = Date.now() + this.#attemptTimeoutMs;
      // Claim the batch so a concurrent alarm cannot notify the same items.
      const claimed = await this.#engine.transaction(() => {
        const rows: QueueItemRow[] = [];
        for (const item of due) {
          const current = this.#store.getItem(item.id);
          if (!current || current.status !== 'admitted' || current.notified) {
            continue;
          }
          const row = {
            ...current,
            attempt: current.attempt + 1,
            next_attempt_at: deadline,
          };
          this.#store.updateItem(row);
          rows.push(row);
        }
        return rows;
      });
      if (claimed.length === 0) {
        return;
      }

      const admitted = claimed.map(
        (row): AdmittedItem<Body> => ({
          id: row.id,
          key: row.key,
          group: row.grp,
          body: deserialize(row.payload) as Body,
          enqueuedAt: row.created_at,
          admittedAt: row.admitted_at ?? row.created_at,
          via: row.lease_id === null ? 'grant' : 'lease',
        })
      );
      let failure: unknown;
      try {
        await this.#deadline('admit', () => this.#admit(admitted));
      } catch (error) {
        failure = error;
      }

      await this.#engine.transaction(() => {
        for (const row of claimed) {
          const current = this.#store.getItem(row.id);
          if (!current || current.attempt !== row.attempt) {
            continue;
          }
          this.#store.updateItem(
            failure === undefined
              ? {
                  ...current,
                  notified: 1,
                  next_attempt_at: Date.now() + this.#finishedCheckMs,
                }
              : {
                  ...current,
                  next_attempt_at: Date.now() + this.#retryDelay(row.attempt),
                }
          );
        }
      });
      if (failure !== undefined) {
        reportFailure(
          'durability.semaphore_queue.admit_failed',
          { count: claimed.length, error: serializeError(failure).message },
          failure
        );
        return;
      }
      for (const item of admitted) {
        this.#emit({
          entityKind: 'semaphore_item',
          type: 'admitted',
          timestamp: item.admittedAt,
          id: item.id,
          key: item.key,
          group: item.group,
          waitMs: Math.max(0, item.admittedAt - item.enqueuedAt),
        });
      }
    } finally {
      release();
    }
  }

  #retryDelay(attempt: number): number {
    try {
      const delay = Math.round(this.#delay(attempt));
      if (Number.isSafeInteger(delay) && delay >= 0 && delay <= maxDelayMs) {
        return delay;
      }
    } catch (error) {
      reportFailure(
        'durability.semaphore_queue.retry_policy_failed',
        {},
        error
      );
    }
    return 60_000;
  }

  async #deadline<T>(what: string, run: () => T | Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Semaphore ${what} timed out after ${this.#attemptTimeoutMs}ms`
                )
              ),
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

traceMethods(DurabilitySemaphoreQueue.prototype, 'DurabilitySemaphoreQueue');
