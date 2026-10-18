import { SemaphoreProtocolError, reportFailure } from './errors.js';
import {
  durabilitySemaphoreMigrations,
  migrate,
  type DurabilityMigrationResult,
} from './migrations.js';
import { assertPositiveInteger } from './policy.js';
import {
  allocateLeases,
  applyLeaseReports,
  budgets,
  leaseFootprint,
  resolveLeasePolicy,
  type LeaseCandidate,
  type LeaseEvent,
  type LeasePolicy,
  type SemaphoreLeaseOptions,
} from './semaphore-leases.js';
import {
  engineFor,
  type Engine,
  type SchedulerAttachment,
} from './scheduler.js';
import {
  semaphoreRequestSchema,
  type GrantReport,
  type GrantResult,
  type LeaseGrant,
  type PermitGrant,
  type PermitRequest,
  type PermitSync,
  type PermitSyncResult,
  type SemaphoreBlockedReason,
  type SemaphoreRequest,
  type SemaphoreResponse,
} from './semaphore-protocol.js';
import { HolderStore, type GrantRow } from './semaphore-store.js';
import type { DurableTable } from './storage.js';

const grantsTable: DurableTable = {
  name: 'durability_semaphore_grants',
  key: 'grant_id',
};

export type DurabilitySemaphoreEvent =
  | {
      entityKind: 'semaphore';
      type: 'round';
      timestamp: number;
      /** Permits asked for and handed out in this round. */
      requested: number;
      granted: number;
      usage: SemaphoreUsage;
    }
  | {
      entityKind: 'semaphore';
      type: 'blocked';
      timestamp: number;
      group: string;
      reason: SemaphoreBlockedReason;
      /** Permits that stayed queued behind the limit. */
      count: number;
    }
  | LeaseEvent
  | {
      entityKind: 'semaphore';
      type: 'grant_reclaimed';
      timestamp: number;
      grantId: string;
      clientId: string;
      group: string;
      /** Unclaimed permits returned to the pool. */
      permits: number;
    };

export type DurabilitySemaphoreConfig = SchedulerAttachment & {
  /** Evaluated once per round. Lowering it never evicts running work. */
  limit: number | (() => number | Promise<number>);
  /**
   * Per-group ceiling; `undefined` means the group only shares the limit.
   * Throwing fails closed for that group with `limit_resolution_error`.
   */
  groupLimit?: (
    group: string
  ) => number | undefined | Promise<number | undefined>;
  /** Entitlement gate; `false` blocks the group with `not_permitted`. */
  canGrant?: (group: string) => boolean | Promise<boolean>;
  /** How long a round waits to coalesce requests. Defaults to 1 second. */
  roundWaitMs?: number;
  /** Minimum time between rounds. Defaults to 2 seconds. */
  roundPeriodMs?: number;
  /** Granted permits a client never claims are reclaimed after this. Defaults to 10 seconds. */
  grantTimeoutMs?: number;
  /** Omit to disable leases: clients then admit only through confirmed grants. */
  leases?: SemaphoreLeaseOptions;
  onLifecycleEvent?: (event: DurabilitySemaphoreEvent) => void | Promise<void>;
};

export type SemaphoreUsage = {
  limit: number;
  /**
   * Permits granted and not yet released, including unclaimed grants. May
   * exceed `limit` after it was lowered: running work is never evicted.
   */
  granted: number;
  /** Live lease footprint: lease permits not yet released. */
  leased: number;
  /** Permits grants may still receive, under the provisioning mode. */
  available: number;
  groups: ReadonlyMap<string, { granted: number; limit?: number }>;
};

type Pending = {
  request: PermitRequest;
  resolve: (grant: PermitGrant) => void;
  reject: (error: unknown) => void;
};

type GroupPolicy = { limit?: number; blocked?: SemaphoreBlockedReason };

type Allocation = {
  grants: PermitGrant['grants'];
  blocked: PermitGrant['blocked'];
  grantResults: GrantResult[];
  leases: LeaseGrant[];
};

type RoundResult = {
  allocations: Map<Pending, Allocation>;
  usage: SemaphoreUsage;
  requested: number;
  granted: number;
  reclaimed: DurabilitySemaphoreEvent[];
  leaseEvents: LeaseEvent[];
  /** Lease demand went unserved, or grants were blocked by lease footprint. */
  contended: boolean;
};

// setTimeout overflows past 2^31 - 1 ms.
const maxDelayMs = 2 ** 31 - 1;

/** Unclaimed permits are reclaimed once the claim window passes. */
const effectivePermits = (grant: GrantRow, now: number): number =>
  now >= grant.expires_at ? grant.claimed : grant.permits;

const outstanding = (grant: GrantRow, now: number): number =>
  Math.max(0, effectivePermits(grant, now) - grant.released);

/** Permits left queued per (group, reason) across one round's allocations. */
const blockedCounts = (
  allocations: ReadonlyMap<Pending, Allocation>
): Array<[string, SemaphoreBlockedReason, number]> => {
  const counts = new Map<string, number>();
  for (const [entry, allocation] of allocations) {
    const given = new Map<string, number>();
    for (const grant of allocation.grants) {
      given.set(grant.group, (given.get(grant.group) ?? 0) + grant.permits);
    }
    for (const { group, reason } of allocation.blocked) {
      const demanded = entry.request.demand.find((d) => d.group === group);
      const count = (demanded?.count ?? 0) - (given.get(group) ?? 0);
      const key = JSON.stringify([group, reason]);
      counts.set(key, (counts.get(key) ?? 0) + count);
    }
  }
  return [...counts].map(([key, count]) => {
    const [group, reason] = JSON.parse(key) as [string, SemaphoreBlockedReason];
    return [group, reason, count];
  });
};

/**
 * The holder half of {@link DurabilitySemaphore}, free of Workers-only imports
 * so it can be tested outside workerd.
 *
 * A composable DO capability holding one concurrency limit for many client
 * Durable Objects. Requests arriving within a round are allocated together in
 * arrival order; clients report claimed and released permits as cumulative
 * counts, so lost or repeated reports can never free capacity twice.
 */
export class DurabilitySemaphoreServer {
  readonly #engine: Engine;
  readonly #store: HolderStore;
  readonly #limit: () => number | Promise<number>;
  readonly #groupLimit: DurabilitySemaphoreConfig['groupLimit'];
  readonly #canGrant: DurabilitySemaphoreConfig['canGrant'];
  readonly #roundWaitMs: number;
  readonly #roundPeriodMs: number;
  readonly #grantTimeoutMs: number;
  readonly #leases: LeasePolicy | undefined;
  readonly #emit: (event: DurabilitySemaphoreEvent) => void;
  #pending: Pending[] = [];
  #roundTimer: ReturnType<typeof setTimeout> | undefined;
  #round: Promise<void> | undefined;
  #lastRoundAt = -Infinity;
  // From the last round; tells clients in later syncs to return idle lease headroom.
  #contended = false;

  constructor(config: DurabilitySemaphoreConfig) {
    const limit = config.limit;
    this.#limit = typeof limit === 'function' ? limit : () => limit;
    if (
      typeof limit === 'number' &&
      (!Number.isSafeInteger(limit) || limit < 0)
    ) {
      throw new RangeError('limit must be a non-negative safe integer');
    }
    this.#groupLimit = config.groupLimit;
    this.#canGrant = config.canGrant;
    this.#roundWaitMs = config.roundWaitMs ?? 1_000;
    this.#roundPeriodMs = config.roundPeriodMs ?? 2_000;
    this.#grantTimeoutMs = config.grantTimeoutMs ?? 10_000;
    this.#leases = config.leases && resolveLeasePolicy(config.leases);
    for (const [name, value] of [
      ['roundWaitMs', this.#roundWaitMs],
      ['roundPeriodMs', this.#roundPeriodMs],
      ['grantTimeoutMs', this.#grantTimeoutMs],
    ] as const) {
      assertPositiveInteger(name, value);
      if (value > maxDelayMs) {
        throw new RangeError(`${name} must be at most ${maxDelayMs}`);
      }
    }

    this.#engine = engineFor(config);
    this.#emit = this.#engine.emitter<DurabilitySemaphoreEvent>(
      config.onLifecycleEvent
    );
    this.#engine.migrateSchema('semaphore', durabilitySemaphoreMigrations);
    this.#store = new HolderStore(this.#engine.sql);
    this.#engine.register({
      table: grantsTable,
      runDue: () => this.#reclaimExpired(),
      nextPendingAt: () => this.#store.nextPendingAt(),
    });
  }

  static migrate(
    context: Pick<DurableObjectState, 'storage'>,
    target?: string | null
  ): DurabilityMigrationResult {
    return migrate(
      context.storage,
      'semaphore',
      durabilitySemaphoreMigrations,
      target
    );
  }

  alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#engine.alarm(info);
  }

  /**
   * The single entry point the application exposes over RPC. A `request` is
   * answered when its round runs; the caller must keep awaiting it. Pending
   * requests live in memory only: if the object is evicted first, the call
   * fails and the client asks again.
   */
  handle(message: SemaphoreRequest): Promise<SemaphoreResponse> {
    const parsed = semaphoreRequestSchema.safeParse(message);
    if (!parsed.success) {
      return Promise.reject(
        new SemaphoreProtocolError('Malformed semaphore message')
      );
    }
    if (parsed.data.type === 'sync') {
      return this.#sync(parsed.data);
    }

    const request = parsed.data;
    return new Promise<PermitGrant>((resolve, reject) => {
      this.#pending.push({ request, resolve, reject });
      this.#scheduleRound();
    });
  }

  async usage(): Promise<SemaphoreUsage> {
    const now = Date.now();
    const limit = await this.#resolveLimit();
    const grants = this.#store.list();
    const leases = this.#store.listLeases();
    const groups = new Map<string, { granted: number; limit?: number }>();
    let granted = 0;
    for (const grant of grants) {
      const count = outstanding(grant, now);
      granted += count;
      const group = groups.get(grant.grp) ?? { granted: 0 };
      group.granted += count;
      groups.set(grant.grp, group);
    }
    let leased = 0;
    for (const lease of leases) {
      if (lease.expires_at > now) {
        leased += leaseFootprint(lease);
      }
    }
    await Promise.all(
      [...groups.entries()].map(async ([name, group]) => {
        const policy = await this.#groupPolicy(name);
        if (policy.limit !== undefined) {
          group.limit = policy.limit;
        }
      })
    );
    return {
      limit,
      granted,
      leased,
      available: this.#grantRoom(limit, granted, leased),
      groups,
    };
  }

  /** Permits grants may still receive, given the provisioning mode. */
  #grantRoom(limit: number, granted: number, leased: number): number {
    if (!this.#leases) {
      return Math.max(0, limit - granted);
    }
    const budget = budgets(this.#leases.provisioning, limit);
    return Math.max(0, budget.grants - granted - (budget.shared ? leased : 0));
  }

  // Rounds never overlap: a request arriving mid-round joins the next one,
  // which is scheduled once the current round settles.
  #scheduleRound(): void {
    if (this.#roundTimer !== undefined || this.#round !== undefined) {
      return;
    }
    const earliest = this.#lastRoundAt + this.#roundPeriodMs;
    const delay = Math.max(this.#roundWaitMs, earliest - Date.now());
    this.#roundTimer = setTimeout(() => {
      this.#roundTimer = undefined;
      const onError = (error: unknown) =>
        reportFailure('durability.semaphore.round_failed', {}, error);
      this.#round = this.#runRound()
        .catch(onError)
        .finally(() => {
          this.#round = undefined;
          if (this.#pending.length > 0) {
            this.#scheduleRound();
          }
        });
      this.#engine.waitUntil(this.#round, onError);
    }, delay);
  }

  async #runRound(): Promise<void> {
    const pending = this.#pending;
    this.#pending = [];
    const now = Date.now();
    this.#lastRoundAt = now;

    let round: RoundResult;
    try {
      const limit = await this.#resolveLimit();
      // Held leases are re-checked every round, not only when their group is
      // requested, so a group that became limited or blocked is retired.
      const leaseGroups = this.#leases
        ? this.#store.listLeases().map((lease) => lease.grp)
        : [];
      const groups = new Set([
        ...pending.flatMap(({ request }) => request.demand.map((d) => d.group)),
        ...leaseGroups,
      ]);
      const policies = new Map(
        await Promise.all(
          [...groups].map(
            async (group) => [group, await this.#groupPolicy(group)] as const
          )
        )
      );
      round = await this.#engine.transaction(() =>
        this.#allocate(pending, limit, policies, now)
      );
    } catch (error) {
      for (const entry of pending) {
        entry.reject(error);
      }
      throw error;
    }

    const nextRequestAt = now + this.#roundPeriodMs;
    this.#contended = round.contended;
    for (const [entry, allocation] of round.allocations) {
      const { leases, ...rest } = allocation;
      entry.resolve({
        type: 'grant',
        v: 1,
        ...rest,
        nextRequestAt,
        ...(entry.request.leases === undefined
          ? {}
          : { leases, ...(round.contended ? { contended: true } : {}) }),
      });
    }
    for (const event of [...round.reclaimed, ...round.leaseEvents]) {
      this.#emit(event);
    }
    this.#emit({
      entityKind: 'semaphore',
      type: 'round',
      timestamp: Date.now(),
      requested: round.requested,
      granted: round.granted,
      usage: round.usage,
    });
    for (const [group, reason, count] of blockedCounts(round.allocations)) {
      this.#emit({
        entityKind: 'semaphore',
        type: 'blocked',
        timestamp: Date.now(),
        group,
        reason,
        count,
      });
    }
  }

  /** One round: apply reports, reclaim, then hand out permits in arrival order. */
  #allocate(
    pending: Pending[],
    limit: number,
    policies: ReadonlyMap<string, GroupPolicy>,
    now: number
  ): RoundResult {
    const store = this.#store;
    const allocations = new Map<Pending, Allocation>();
    let unknownDebt = 0;
    const drawn = new Map<string, number>();
    for (const entry of pending) {
      const { clientId } = entry.request;
      const grantResults = this.#applyReports(
        store,
        clientId,
        entry.request.grants,
        now
      );
      const leases: LeaseGrant[] = [];
      if (this.#leases && entry.request.leases) {
        const outcome = applyLeaseReports(
          store,
          this.#leases,
          clientId,
          entry.request.leases,
          now
        );
        leases.push(...outcome.echoes);
        unknownDebt += outcome.unknownDebt;
        for (const [leaseId, count] of outcome.drawn) {
          drawn.set(leaseId, count);
        }
      }
      allocations.set(entry, { grants: [], blocked: [], grantResults, leases });
    }

    const used = new Map<string, number>();
    let total = 0;
    const reclaimed = this.#reclaim(store, now);
    for (const grant of reclaimed.grants) {
      const count = outstanding(grant, now);
      total += count;
      used.set(grant.grp, (used.get(grant.grp) ?? 0) + count);
    }
    // In strict mode live lease footprint is reserved from the same pool as grants.
    const budget = this.#leases
      ? budgets(this.#leases.provisioning, limit)
      : { grants: limit, leases: 0, shared: false };
    let leased = 0;
    if (this.#leases && budget.shared) {
      for (const lease of store.listLeases()) {
        if (lease.expires_at > now) {
          leased += leaseFootprint(lease);
        }
      }
    }
    let remaining = budget.grants - total - (budget.shared ? leased : 0);

    const demands = pending
      .flatMap((entry) =>
        entry.request.demand.map((demand) => ({ entry, ...demand }))
      )
      .sort(
        (left, right) =>
          left.oldestAt - right.oldestAt ||
          left.entry.request.clientId.localeCompare(
            right.entry.request.clientId
          )
      );
    let requested = 0;
    let granted = 0;
    for (const demand of demands) {
      requested += demand.count;
      const allocation = allocations.get(demand.entry)!;
      const policy = policies.get(demand.group) ?? {};
      if (policy.blocked) {
        allocation.blocked.push({
          group: demand.group,
          reason: policy.blocked,
        });
        continue;
      }

      const groupUsed = used.get(demand.group) ?? 0;
      const groupRemaining =
        policy.limit === undefined ? Infinity : policy.limit - groupUsed;
      const give = Math.max(
        0,
        Math.min(demand.count, groupRemaining, remaining)
      );
      if (give > 0) {
        const grant: GrantRow = {
          grant_id: crypto.randomUUID(),
          client_id: demand.entry.request.clientId,
          grp: demand.group,
          permits: give,
          claimed: 0,
          released: 0,
          created_at: now,
          expires_at: now + this.#grantTimeoutMs,
        };
        store.insert(grant);
        allocation.grants.push({
          grantId: grant.grant_id,
          group: demand.group,
          permits: give,
        });
        remaining -= give;
        used.set(demand.group, groupUsed + give);
        granted += give;
      }
      if (give < demand.count) {
        // The group gate is checked first so attribution names the tighter one.
        allocation.blocked.push({
          group: demand.group,
          reason: groupRemaining - give <= 0 ? 'group_limit' : 'limit',
        });
      }
    }
    let leaseEvents: LeaseEvent[] = [];
    let contended = false;
    if (this.#leases) {
      const candidates: LeaseCandidate[] = pending.flatMap((entry) =>
        entry.request.leases === undefined
          ? []
          : entry.request.demand.map((demand) => ({
              clientId: entry.request.clientId,
              group: demand.group,
              oldestAt: demand.oldestAt,
            }))
      );
      // The allocator nets out live footprint itself; hand it gross capacity.
      const leaseBudget = budget.shared
        ? Math.max(0, limit - total - granted)
        : budget.leases;
      const outcome = allocateLeases(store, this.#leases, {
        budget: leaseBudget,
        unknownDebt,
        drawn,
        candidates,
        policies,
        groupUsed: used,
        now,
      });
      leased = outcome.footprint;
      leaseEvents = outcome.events;
      // Returned headroom helps grants only when they share the limit with leases.
      contended =
        outcome.unserved ||
        (budget.shared &&
          [...allocations.values()].some((allocation) =>
            allocation.blocked.some(({ reason }) => reason === 'limit')
          ));
      for (const [entry, allocation] of allocations) {
        // One echo per lease; the allocator's view (e.g. retired) supersedes the report's.
        const byLease = new Map(
          [
            ...allocation.leases,
            ...(outcome.grants.get(entry.request.clientId) ?? []),
          ].map((lease) => [lease.leaseId, lease] as const)
        );
        allocation.leases = [...byLease.values()];
      }
      if (budget.shared) {
        remaining = limit - total - granted - leased;
      }
    }

    const groups = new Map(
      [...used].map(([group, count]) => {
        const policy = policies.get(group);
        return [
          group,
          policy?.limit === undefined
            ? { granted: count }
            : { granted: count, limit: policy.limit },
        ];
      })
    );
    return {
      allocations,
      requested,
      granted,
      reclaimed: reclaimed.events,
      leaseEvents,
      contended,
      usage: {
        limit,
        granted: total + granted,
        leased,
        available: Math.max(0, remaining),
        groups,
      },
    };
  }

  async #sync(message: PermitSync): Promise<PermitSyncResult> {
    const now = Date.now();
    const result = await this.#engine.transaction(() => {
      const store = this.#store;
      const grantResults = this.#applyReports(
        store,
        message.clientId,
        message.grants,
        now
      );
      const leaseOutcome =
        this.#leases && message.leases
          ? applyLeaseReports(
              store,
              this.#leases,
              message.clientId,
              message.leases,
              now
            )
          : undefined;
      return { grantResults, leaseEchoes: leaseOutcome?.echoes };
    });
    return {
      type: 'synced',
      v: 1,
      grantResults: result.grantResults,
      ...(result.leaseEchoes === undefined
        ? {}
        : {
            leases: result.leaseEchoes,
            ...(this.#contended ? { contended: true } : {}),
          }),
    };
  }

  /**
   * Applies cumulative claim/release reports. Counts only move forward and
   * are clamped to what the grant can honor, so replays are harmless.
   */
  #applyReports(
    store: HolderStore,
    clientId: string,
    reports: GrantReport[],
    now: number
  ): GrantResult[] {
    const results: GrantResult[] = [];
    for (const report of reports) {
      const grant = store.get(report.grantId);
      if (!grant || grant.client_id !== clientId) {
        results.push({
          grantId: report.grantId,
          claimed: 0,
          status: 'not_found',
        });
        continue;
      }

      const expired = now >= grant.expires_at;
      const permits = effectivePermits(grant, now);
      const claimed = Math.max(
        grant.claimed,
        Math.min(report.claimed, permits)
      );
      const released = Math.max(
        grant.released,
        Math.min(report.released, claimed)
      );
      const updated: GrantRow = { ...grant, permits, claimed, released };
      if (released >= permits) {
        store.remove(grant.grant_id);
      } else {
        store.update(updated);
      }
      results.push({
        grantId: grant.grant_id,
        claimed,
        status: expired && report.claimed > claimed ? 'expired' : 'ok',
      });
    }
    return results;
  }

  /**
   * Returns every grant after reclaiming unclaimed permits past their window.
   * Events are returned, not emitted: the caller emits them after commit.
   */
  #reclaim(
    store: HolderStore,
    now: number
  ): { grants: GrantRow[]; events: DurabilitySemaphoreEvent[] } {
    const kept: GrantRow[] = [];
    const events: DurabilitySemaphoreEvent[] = [];
    for (const grant of store.list()) {
      if (now < grant.expires_at || grant.claimed >= grant.permits) {
        kept.push(grant);
        continue;
      }

      const updated: GrantRow = { ...grant, permits: grant.claimed };
      if (updated.released >= updated.permits) {
        store.remove(grant.grant_id);
      } else {
        store.update(updated);
        kept.push(updated);
      }
      events.push({
        entityKind: 'semaphore',
        type: 'grant_reclaimed',
        timestamp: now,
        grantId: grant.grant_id,
        clientId: grant.client_id,
        group: grant.grp,
        permits: grant.permits - grant.claimed,
      });
    }
    return { grants: kept, events };
  }

  async #reclaimExpired(): Promise<void> {
    const events = await this.#engine.transaction(
      () => this.#reclaim(this.#store, Date.now()).events
    );
    for (const event of events) {
      this.#emit(event);
    }
  }

  async #resolveLimit(): Promise<number> {
    const limit = await this.#limit();
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError('limit must resolve to a non-negative safe integer');
    }
    return limit;
  }

  // Resolution failures block the group rather than granting unlimited permits.
  async #groupPolicy(group: string): Promise<GroupPolicy> {
    try {
      if (this.#canGrant && !(await this.#canGrant(group))) {
        return { blocked: 'not_permitted' };
      }
      const limit = await this.#groupLimit?.(group);
      if (limit === undefined) {
        return {};
      }
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError(
          `groupLimit for "${group}" must be a non-negative safe integer`
        );
      }
      return { limit };
    } catch (error) {
      reportFailure(
        'durability.semaphore.limit_resolution_failed',
        { group },
        error
      );
      return { blocked: 'limit_resolution_error' };
    }
  }
}
