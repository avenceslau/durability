import { SemaphoreProtocolError, reportFailure } from './errors.js';
import {
  durabilitySemaphoreMigrations,
  migrate,
  type DurabilityMigrationResult,
} from './migrations.js';
import { assertPositiveInteger } from './policy.js';
import {
  engineFor,
  type Engine,
  type SchedulerAttachment,
} from './scheduler.js';
import {
  semaphoreRequestSchema,
  type GrantReport,
  type GrantResult,
  type PermitGrant,
  type PermitRequest,
  type PermitSync,
  type PermitSyncResult,
  type SemaphoreBlockedReason,
  type SemaphoreRequest,
  type SemaphoreResponse,
} from './semaphore-protocol.js';
import type { DurableTable } from './storage.js';
import { z } from 'zod';

const grantsTable: DurableTable = {
  name: 'durability_semaphore_grants',
  key: 'grant_id',
};

const grantRowSchema = z.object({
  grant_id: z.string(),
  client_id: z.string(),
  grp: z.string(),
  permits: z.number().int().nonnegative(),
  claimed: z.number().int().nonnegative(),
  released: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  /** Unclaimed permits are reclaimed once this passes. */
  expires_at: z.number().int().nonnegative(),
});

type GrantRow = z.infer<typeof grantRowSchema>;

const grantColumns = grantRowSchema.keyof().options;

/** Grants are small and bounded by live clients, so aggregates are computed from `list`. */
const grants = {
  list: (sql: SqlStorage): GrantRow[] =>
    grantRowSchema
      .array()
      .parse(
        sql
          .exec('SELECT * FROM durability_semaphore_grants ORDER BY created_at')
          .toArray()
      ),
  get: (sql: SqlStorage, grantId: string): GrantRow | undefined =>
    grantRowSchema
      .optional()
      .parse(
        sql
          .exec(
            'SELECT * FROM durability_semaphore_grants WHERE grant_id = ? LIMIT 1',
            grantId
          )
          .toArray()[0]
      ),
  nextPendingAt: (sql: SqlStorage): number | undefined =>
    grantRowSchema
      .pick({ expires_at: true })
      .optional()
      .parse(
        sql
          .exec(
            `SELECT expires_at FROM durability_semaphore_grants
             WHERE claimed < permits
             ORDER BY expires_at ASC
             LIMIT 1`
          )
          .toArray()[0]
      )?.expires_at,
  insert: (sql: SqlStorage, row: GrantRow): boolean =>
    sql
      .exec(
        `INSERT INTO durability_semaphore_grants (${grantColumns.join(', ')})
         VALUES (${grantColumns.map(() => '?').join(', ')})
         ON CONFLICT(grant_id) DO NOTHING
         RETURNING grant_id`,
        ...grantColumns.map((column) => row[column])
      )
      .toArray().length > 0,
  update: (sql: SqlStorage, row: GrantRow): void => {
    sql.exec(
      `UPDATE durability_semaphore_grants
       SET permits = ?, claimed = ?, released = ?, expires_at = ?
       WHERE grant_id = ?`,
      row.permits,
      row.claimed,
      row.released,
      row.expires_at,
      row.grant_id
    );
  },
  remove: (sql: SqlStorage, grantId: string): void => {
    sql.exec(
      'DELETE FROM durability_semaphore_grants WHERE grant_id = ?',
      grantId
    );
  },
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
  onLifecycleEvent?: (event: DurabilitySemaphoreEvent) => void | Promise<void>;
};

export type SemaphoreUsage = {
  limit: number;
  /** Permits granted and not yet released, including unclaimed grants. */
  granted: number;
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
};

type RoundResult = {
  allocations: Map<Pending, Allocation>;
  usage: SemaphoreUsage;
  requested: number;
  granted: number;
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
  readonly #limit: () => number | Promise<number>;
  readonly #groupLimit: DurabilitySemaphoreConfig['groupLimit'];
  readonly #canGrant: DurabilitySemaphoreConfig['canGrant'];
  readonly #roundWaitMs: number;
  readonly #roundPeriodMs: number;
  readonly #grantTimeoutMs: number;
  readonly #emit: (event: DurabilitySemaphoreEvent) => void;
  #pending: Pending[] = [];
  #roundTimer: ReturnType<typeof setTimeout> | undefined;
  #lastRoundAt = -Infinity;

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
    this.#engine.register({
      table: grantsTable,
      runDue: () => this.#reclaimExpired(),
      nextPendingAt: grants.nextPendingAt,
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

  /** The single entry point the application exposes over RPC. */
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
    const groups = new Map<string, { granted: number; limit?: number }>();
    let granted = 0;
    for (const grant of grants.list(this.#engine.sql)) {
      const count = outstanding(grant, now);
      granted += count;
      const group = groups.get(grant.grp) ?? { granted: 0 };
      group.granted += count;
      groups.set(grant.grp, group);
    }
    await Promise.all(
      [...groups.entries()].map(async ([name, group]) => {
        const policy = await this.#groupPolicy(name);
        if (policy.limit !== undefined) {
          group.limit = policy.limit;
        }
      })
    );
    return { limit, granted, available: Math.max(0, limit - granted), groups };
  }

  #scheduleRound(): void {
    if (this.#roundTimer !== undefined) {
      return;
    }
    const earliest = this.#lastRoundAt + this.#roundPeriodMs;
    const delay = Math.max(this.#roundWaitMs, earliest - Date.now());
    this.#roundTimer = setTimeout(() => {
      this.#roundTimer = undefined;
      const onError = (error: unknown) =>
        reportFailure('durability.semaphore.round_failed', {}, error);
      const round = this.#runRound().catch(onError);
      this.#engine.waitUntil(round, onError);
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
      const groups = new Set(
        pending.flatMap(({ request }) => request.demand.map((d) => d.group))
      );
      const policies = new Map(
        await Promise.all(
          [...groups].map(
            async (group) => [group, await this.#groupPolicy(group)] as const
          )
        )
      );
      round = await this.#engine.transaction((sql) =>
        this.#allocate(sql, pending, limit, policies, now)
      );
    } catch (error) {
      for (const entry of pending) {
        entry.reject(error);
      }
      throw error;
    }

    const nextRequestAt = now + this.#roundPeriodMs;
    for (const [entry, allocation] of round.allocations) {
      entry.resolve({ type: 'grant', v: 1, ...allocation, nextRequestAt });
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
    sql: SqlStorage,
    pending: Pending[],
    limit: number,
    policies: ReadonlyMap<string, GroupPolicy>,
    now: number
  ): RoundResult {
    const allocations = new Map<Pending, Allocation>();
    for (const entry of pending) {
      allocations.set(entry, {
        grants: [],
        blocked: [],
        grantResults: this.#applyReports(
          sql,
          entry.request.clientId,
          entry.request.grants,
          now
        ),
      });
    }

    const used = new Map<string, number>();
    let total = 0;
    for (const grant of this.#reclaim(sql, now)) {
      const count = outstanding(grant, now);
      total += count;
      used.set(grant.grp, (used.get(grant.grp) ?? 0) + count);
    }
    let remaining = limit - total;

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
        grants.insert(sql, grant);
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
      usage: {
        limit,
        granted: total + granted,
        available: Math.max(0, remaining),
        groups,
      },
    };
  }

  async #sync(message: PermitSync): Promise<PermitSyncResult> {
    const grantResults = await this.#engine.transaction((sql) =>
      this.#applyReports(sql, message.clientId, message.grants, Date.now())
    );
    return { type: 'synced', v: 1, grantResults };
  }

  /**
   * Applies cumulative claim/release reports. Counts only move forward and
   * are clamped to what the grant can honor, so replays are harmless.
   */
  #applyReports(
    sql: SqlStorage,
    clientId: string,
    reports: GrantReport[],
    now: number
  ): GrantResult[] {
    const results: GrantResult[] = [];
    for (const report of reports) {
      const grant = grants.get(sql, report.grantId);
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
        grants.remove(sql, grant.grant_id);
      } else {
        grants.update(sql, updated);
      }
      results.push({
        grantId: grant.grant_id,
        claimed,
        status: expired && report.claimed > claimed ? 'expired' : 'ok',
      });
    }
    return results;
  }

  /** Returns every grant after reclaiming unclaimed permits past their window. */
  #reclaim(sql: SqlStorage, now: number): GrantRow[] {
    const kept: GrantRow[] = [];
    for (const grant of grants.list(sql)) {
      if (now < grant.expires_at || grant.claimed >= grant.permits) {
        kept.push(grant);
        continue;
      }

      const reclaimed = grant.permits - grant.claimed;
      const updated: GrantRow = { ...grant, permits: grant.claimed };
      if (updated.released >= updated.permits) {
        grants.remove(sql, grant.grant_id);
      } else {
        grants.update(sql, updated);
        kept.push(updated);
      }
      this.#emit({
        entityKind: 'semaphore',
        type: 'grant_reclaimed',
        timestamp: now,
        grantId: grant.grant_id,
        clientId: grant.client_id,
        group: grant.grp,
        permits: reclaimed,
      });
    }
    return kept;
  }

  async #reclaimExpired(): Promise<void> {
    await this.#engine.transaction((sql) => {
      this.#reclaim(sql, Date.now());
    });
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
