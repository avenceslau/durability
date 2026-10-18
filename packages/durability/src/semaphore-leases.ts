import { assertPositiveInteger } from './policy.js';
import type {
  LeaseGrant,
  LeaseReport,
  SemaphoreBlockedReason,
} from './semaphore-protocol.js';
import type { HolderStore, LeaseRow } from './semaphore-store.js';

/**
 * Where lease capacity comes from.
 *
 * - `over`: leases draw from a separate budget above the limit, so the
 *   ceiling is `limit + extra` (the original gatekeeper behaviour).
 * - `under`: a slice of the limit is reserved for leases; grants may use at
 *   most `limit - reserve`, and always at least one permit. Nothing ever
 *   exceeds the limit and leases have guaranteed headroom.
 * - `strict`: grants and live lease footprint share the limit, grants first.
 */
export type SemaphoreProvisioning =
  | { mode: 'strict' }
  | { mode: 'under'; reserve: number | { ratio: number } }
  | { mode: 'over'; extra: number | { ratio: number } };

export type SemaphoreLeaseOptions = {
  provisioning: SemaphoreProvisioning;
  /** Permits per lease. Defaults to 64. */
  permitsPerLease?: number;
  /** A lease not reported for this long is swept. Defaults to 30 minutes. */
  ttlMs?: number;
  /** Groups that may receive new leases in one round, oldest demand first. Defaults to 100. */
  maxGroups?: number;
  /** Clients per group that may receive new leases in one round. Defaults to 100. */
  maxClientsPerGroup?: number;
  /**
   * Groups with a `groupLimit`: `exclude` them from leases (exact steady
   * state only, as gatekeeper does) or lease `withinGroupLimit`. Defaults to
   * `exclude`.
   */
  limitedGroups?: 'exclude' | 'withinGroupLimit';
};

export type LeasePolicy = Required<SemaphoreLeaseOptions>;

export type LeaseEvent = {
  entityKind: 'semaphore';
  type: 'lease_granted' | 'lease_retired';
  timestamp: number;
  leaseId: string;
  clientId: string;
  group: string;
  permits: number;
};

type GroupPolicy = { limit?: number; blocked?: SemaphoreBlockedReason };

const maxDelayMs = 2 ** 31 - 1;

export const resolveLeasePolicy = (
  options: SemaphoreLeaseOptions
): LeasePolicy => {
  const policy: LeasePolicy = {
    provisioning: options.provisioning,
    permitsPerLease: options.permitsPerLease ?? 64,
    ttlMs: options.ttlMs ?? 30 * 60_000,
    maxGroups: options.maxGroups ?? 100,
    maxClientsPerGroup: options.maxClientsPerGroup ?? 100,
    limitedGroups: options.limitedGroups ?? 'exclude',
  };
  for (const name of [
    'permitsPerLease',
    'ttlMs',
    'maxGroups',
    'maxClientsPerGroup',
  ] as const) {
    assertPositiveInteger(`leases.${name}`, policy[name]);
  }
  if (policy.ttlMs > maxDelayMs) {
    throw new RangeError(`leases.ttlMs must be at most ${maxDelayMs}`);
  }
  const amount =
    policy.provisioning.mode === 'under'
      ? policy.provisioning.reserve
      : policy.provisioning.mode === 'over'
        ? policy.provisioning.extra
        : undefined;
  if (amount !== undefined) {
    const value = typeof amount === 'number' ? amount : amount.ratio;
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('lease provisioning amounts must be non-negative');
    }
  }
  return policy;
};

const scaled = (amount: number | { ratio: number }, limit: number): number =>
  typeof amount === 'number' ? amount : Math.floor(limit * amount.ratio);

/** Permits grants may use, and permits leases may hold, for one limit. */
export const budgets = (
  provisioning: SemaphoreProvisioning,
  limit: number
): { grants: number; leases: number; shared: boolean } => {
  if (provisioning.mode === 'over') {
    return {
      grants: limit,
      leases: scaled(provisioning.extra, limit),
      shared: false,
    };
  }
  if (provisioning.mode === 'under') {
    // The reserve never takes the last permit: groups excluded from leases and
    // clients without lease support would otherwise never be admitted.
    const reserve = Math.min(
      Math.max(0, limit - 1),
      scaled(provisioning.reserve, limit)
    );
    return { grants: limit - reserve, leases: reserve, shared: false };
  }
  return { grants: limit, leases: limit, shared: true };
};

export const leaseFootprint = (lease: LeaseRow): number =>
  Math.max(0, lease.permits - lease.released);

/** A retired lease is echoed as expired so the client stops drawing at once. */
const toLeaseGrant = (lease: LeaseRow, now: number): LeaseGrant => ({
  leaseId: lease.lease_id,
  group: lease.grp,
  permits: lease.permits,
  expiresAt: lease.retired ? now : lease.expires_at,
});

export const leaseEligible = (
  policy: LeasePolicy,
  group: GroupPolicy
): boolean =>
  group.blocked === undefined &&
  (group.limit === undefined || policy.limitedGroups === 'withinGroupLimit');

export type LeaseReportOutcome = {
  /** Echoed grants: refreshed live leases and retired (`expiresAt = now`) ones. */
  echoes: LeaseGrant[];
  /** Live footprint of leases the holder no longer knows, charged this round. */
  unknownDebt: number;
  /** Reported `drawn` per lease, so undrawn headroom can be seen. */
  drawn: Map<string, number>;
};

/**
 * Applies one client's lease reports: heartbeats live leases, advances the
 * release high-water mark, retires leases the holder forgot or that expired,
 * and charges their reported live footprint so a forgotten lease cannot
 * over-admit for the rest of this round.
 */
export const applyLeaseReports = (
  store: HolderStore,
  policy: LeasePolicy,
  clientId: string,
  reports: LeaseReport[],
  now: number
): LeaseReportOutcome => {
  const outcome: LeaseReportOutcome = {
    echoes: [],
    unknownDebt: 0,
    drawn: new Map(),
  };
  for (const report of reports) {
    const lease = store.getLease(report.leaseId);
    if (!lease || lease.client_id !== clientId) {
      outcome.echoes.push({
        leaseId: report.leaseId,
        group: lease?.grp ?? '',
        permits: lease?.permits ?? 0,
        expiresAt: now,
      });
      // Client-reported usage is untrusted: clamp before it can affect budget.
      const live = Math.max(0, report.drawn - Math.max(0, report.released));
      outcome.unknownDebt += Math.min(live, policy.permitsPerLease);
      continue;
    }

    const drawn = Math.min(Math.max(0, report.drawn), lease.permits);
    outcome.drawn.set(lease.lease_id, drawn);
    const released = Math.max(
      lease.released,
      Math.min(Math.max(0, report.released), drawn)
    );
    // An expired lease is retired, not forgotten: its permits may be running.
    // Only the client's own retired report shrinks a lease to what it drew:
    // until then it may still be drawing, whoever asked it to stop.
    const retired =
      lease.retired === 1 || report.retired === true || lease.expires_at <= now;
    const permits =
      report.retired === true ? Math.max(released, drawn) : lease.permits;
    if (released >= permits) {
      store.removeLease(lease.lease_id);
      // Echoed as settled (permits = released) so the client can drop the lease.
      outcome.echoes.push({
        ...toLeaseGrant(lease, now),
        permits: released,
        expiresAt: now,
      });
      continue;
    }
    const refreshed: LeaseRow = {
      ...lease,
      permits,
      released,
      retired: retired ? 1 : 0,
      expires_at: retired ? lease.expires_at : now + policy.ttlMs,
    };
    store.updateLease(refreshed);
    outcome.echoes.push(toLeaseGrant(refreshed, now));
  }
  return outcome;
};

export type LeaseCandidate = {
  clientId: string;
  group: string;
  oldestAt: number;
};

export type LeaseAllocation = {
  /** New and retired leases per client. */
  grants: Map<string, LeaseGrant[]>;
  footprint: number;
  events: LeaseEvent[];
  /** Some eligible candidate received no lease this round. */
  unserved: boolean;
};

/**
 * One round's lease pass: sweeps expired leases, retires leases of groups no
 * longer eligible, computes the live footprint, and shares the lease budget
 * equally among candidates that do not already hold usable headroom.
 */
export const allocateLeases = (
  store: HolderStore,
  policy: LeasePolicy,
  input: {
    budget: number;
    unknownDebt: number;
    drawn: ReadonlyMap<string, number>;
    candidates: LeaseCandidate[];
    policies: ReadonlyMap<string, GroupPolicy>;
    /** Group permits already used by grants, for `withinGroupLimit`. */
    groupUsed: ReadonlyMap<string, number>;
    now: number;
  }
): LeaseAllocation => {
  const { now } = input;
  const grants = new Map<string, LeaseGrant[]>();
  const events: LeaseEvent[] = [];
  const echo = (clientId: string, grant: LeaseGrant): void => {
    grants.set(clientId, [...(grants.get(clientId) ?? []), grant]);
  };

  let footprint = 0;
  const groupFootprint = new Map<string, number>();
  const usable = new Set<string>();
  for (const lease of store.listLeases()) {
    const group = input.policies.get(lease.grp) ?? {};
    let current = lease;
    // An unreported lease is retired, not swept: its client may be cut off
    // with work still running, so its footprint stays until it reports, as a
    // claimed grant permit stays until it is released.
    if (
      !lease.retired &&
      (lease.expires_at <= now || !leaseEligible(policy, group))
    ) {
      // Stop draws now; the full footprint stays until the client confirms.
      current = { ...lease, retired: 1 };
      store.updateLease(current);
      echo(lease.client_id, toLeaseGrant(current, now));
      events.push({
        entityKind: 'semaphore',
        type: 'lease_retired',
        timestamp: now,
        leaseId: lease.lease_id,
        clientId: lease.client_id,
        group: lease.grp,
        permits:
          lease.permits - (input.drawn.get(lease.lease_id) ?? lease.permits),
      });
    }

    const live = leaseFootprint(current);
    footprint += live;
    groupFootprint.set(lease.grp, (groupFootprint.get(lease.grp) ?? 0) + live);
    // An unreported lease is assumed fully drawn, as gatekeeper does.
    if (
      !current.retired &&
      (input.drawn.get(lease.lease_id) ?? lease.permits) < lease.permits
    ) {
      usable.add(JSON.stringify([lease.client_id, lease.grp]));
    }
  }

  const byGroup = new Map<string, LeaseCandidate[]>();
  for (const candidate of input.candidates) {
    if (
      !leaseEligible(policy, input.policies.get(candidate.group) ?? {}) ||
      usable.has(JSON.stringify([candidate.clientId, candidate.group]))
    ) {
      continue;
    }
    const existing = byGroup.get(candidate.group) ?? [];
    const prior = existing.find((c) => c.clientId === candidate.clientId);
    if (prior) {
      prior.oldestAt = Math.min(prior.oldestAt, candidate.oldestAt);
    } else {
      existing.push({ ...candidate });
    }
    byGroup.set(candidate.group, existing);
  }
  const chosen = [...byGroup.entries()]
    .map(([group, clients]) => ({
      group,
      clients: clients
        .sort(
          (a, b) =>
            a.oldestAt - b.oldestAt || a.clientId.localeCompare(b.clientId)
        )
        .slice(0, policy.maxClientsPerGroup),
      oldestAt: Math.min(...clients.map((c) => c.oldestAt)),
    }))
    .sort((a, b) => a.oldestAt - b.oldestAt || a.group.localeCompare(b.group))
    .slice(0, policy.maxGroups)
    .flatMap(({ clients }) => clients);

  // A lowered budget retires leases with undrawn headroom, newest first, until
  // the headroom their clients reported covers the excess. Their footprint
  // stays until each client confirms what it actually drew.
  let excess = footprint + input.unknownDebt - input.budget;
  if (excess > 0) {
    const live = store
      .listLeases()
      .filter((lease) => lease.expires_at > now && !lease.retired)
      .sort((a, b) => b.created_at - a.created_at);
    for (const lease of live) {
      if (excess <= 0) {
        break;
      }
      const drawn = input.drawn.get(lease.lease_id);
      if (drawn === undefined || drawn >= lease.permits) {
        continue;
      }
      const retired: LeaseRow = { ...lease, retired: 1 };
      store.updateLease(retired);
      excess -= lease.permits - drawn;
      echo(lease.client_id, toLeaseGrant(retired, now));
      events.push({
        entityKind: 'semaphore',
        type: 'lease_retired',
        timestamp: now,
        leaseId: lease.lease_id,
        clientId: lease.client_id,
        group: lease.grp,
        permits: lease.permits - drawn,
      });
    }
  }

  const eligible = [...byGroup.values()].reduce(
    (n, clients) => n + clients.length,
    0
  );
  let remaining = Math.max(0, input.budget - footprint - input.unknownDebt);
  // With fewer permits than candidates, the oldest demand gets one each
  // rather than everyone getting a rounded-down share of nothing.
  const share = Math.min(
    policy.permitsPerLease,
    Math.max(1, Math.floor(remaining / Math.max(1, chosen.length)))
  );

  let issued = 0;
  for (const candidate of chosen) {
    if (remaining <= 0) {
      break;
    }
    const group = input.policies.get(candidate.group) ?? {};
    const groupRoom =
      group.limit === undefined
        ? share
        : group.limit -
          (input.groupUsed.get(candidate.group) ?? 0) -
          (groupFootprint.get(candidate.group) ?? 0);
    const permits = Math.min(share, groupRoom, remaining);
    if (permits <= 0) {
      continue;
    }
    remaining -= permits;
    issued += 1;
    const lease: LeaseRow = {
      lease_id: crypto.randomUUID(),
      client_id: candidate.clientId,
      grp: candidate.group,
      permits,
      released: 0,
      created_at: now,
      expires_at: now + policy.ttlMs,
      retired: 0,
    };
    store.insertLease(lease);
    footprint += permits;
    groupFootprint.set(
      candidate.group,
      (groupFootprint.get(candidate.group) ?? 0) + permits
    );
    echo(candidate.clientId, toLeaseGrant(lease, now));
    events.push({
      entityKind: 'semaphore',
      type: 'lease_granted',
      timestamp: now,
      leaseId: lease.lease_id,
      clientId: lease.client_id,
      group: lease.grp,
      permits,
    });
  }
  return { grants, footprint, events, unserved: issued < eligible };
};
