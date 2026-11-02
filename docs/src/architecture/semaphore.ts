import example from '../../../examples/account-concurrency/worker.ts?raw';
import semaphore from '../../../packages/durability/src/semaphore.ts?raw';
import leases from '../../../packages/durability/src/semaphore-leases.ts?raw';
import server from '../../../packages/durability/src/semaphore-server.ts?raw';
import store from '../../../packages/durability/src/semaphore-store.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/account-concurrency/worker.ts';
const semaphoreFile = 'packages/durability/src/semaphore.ts';
const serverFile = 'packages/durability/src/semaphore-server.ts';
const storeFile = 'packages/durability/src/semaphore-store.ts';
const leasesFile = 'packages/durability/src/semaphore-leases.ts';

const accountLimit = sourceExcerpt(
  example,
  exampleFile,
  'account-limit',
  'AccountLimit Durable Object',
  'export class AccountLimit extends DurableObject<Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const route = sourceExcerpt(
  semaphore,
  semaphoreFile,
  'route',
  'Route a message to the holder by key',
  '    const client = new SemaphoreClient({',
  '        return config.invoke(stub, message);'
);
const outstanding = sourceExcerpt(
  server,
  serverFile,
  'outstanding',
  'Permits a grant still holds',
  '/** Unclaimed permits are reclaimed once the claim window passes. */',
  '  Math.max(0, effectivePermits(grant, now) - grant.released);'
);
const construct = sourceExcerpt(
  server,
  serverFile,
  'construct',
  'Attach to the object storage',
  '    this.#engine = engineFor(config);',
  '      nextPendingAt: () => this.#store.nextPendingAt(),\n    });'
);
const handle = sourceExcerpt(
  server,
  serverFile,
  'handle',
  'Accept a request or a sync',
  '   * The single entry point the application exposes over RPC. A `request` is',
  '      this.#scheduleRound();\n    });\n  }'
);
const scheduleRound = sourceExcerpt(
  server,
  serverFile,
  'schedule-round',
  'Wait for the round in memory',
  '  #scheduleRound(): void {',
  '    }, delay);\n  }'
);
const runRound = sourceExcerpt(
  server,
  serverFile,
  'run-round',
  'Run a round and answer every request',
  '  async #runRound(): Promise<void> {',
  '          : { leases, ...(round.contended ? { contended: true } : {}) }),\n      });\n    }'
);
const allocate = sourceExcerpt(
  server,
  serverFile,
  'allocate',
  'Allocate grants and leases',
  '  #allocate(',
  '      leaseEvents = outcome.events;'
);
const applyReports = sourceExcerpt(
  server,
  serverFile,
  'apply-reports',
  'Apply cumulative reports',
  '  #applyReports(',
  '    return results;\n  }'
);
const reclaim = sourceExcerpt(
  server,
  serverFile,
  'reclaim',
  'Reclaim unclaimed permits',
  '  #reclaim(',
  '      this.#emit(event);\n    }\n  }'
);
const nextPendingAt = sourceExcerpt(
  store,
  storeFile,
  'next-pending',
  'The alarm follows unclaimed grants',
  '  nextPendingAt(): number | undefined {',
  '      )?.expires_at;\n  }'
);
const leaseReports = sourceExcerpt(
  leases,
  leasesFile,
  'lease-reports',
  'Heartbeat and settle leases',
  'export const applyLeaseReports = (',
  '  return outcome;\n};'
);
const allocateLeases = sourceExcerpt(
  leases,
  leasesFile,
  'allocate-leases',
  'Retire and issue leases',
  'export const allocateLeases = (',
  '  return { grants, footprint, events, unserved: issued < eligible };\n};'
);

export const walkthrough = validateWalkthrough({
  id: 'semaphore',
  title: 'How DurabilitySemaphore uses your Durable Object',
  summary:
    'The holder keeps grants and leases in its object’s SQLite storage, waits for rounds in memory, and uses the object’s single alarm to reclaim permits nobody claimed. Step through a round, then lose the object and the reply.',
  diagram: {
    canvas: { width: 1080, height: 1000 },
    direction: 'down',
    routing: 'auto',
    flows: {
      request: { label: 'request permits', color: 'blue' },
      round: { label: 'run a round', color: 'orange' },
      recover: { label: 'reclaim from the alarm', color: 'green' },
    },
    nodes: {
      client: {
        rank: 0,
        row: 2,
        label: 'JobShard',
        sublabel: 'client object',
        icon: 'durable-objects',
      },
      holder: {
        rank: 1,
        row: 1,
        label: 'AccountLimit',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      semaphore: {
        rank: 2,
        row: 1,
        label: 'Semaphore',
        sublabel: 'in memory',
        size: [204, 72],
        icon: 'shield',
      },
      pending: {
        rank: 2,
        row: 2,
        label: 'Requests',
        sublabel: 'waiting in memory',
        icon: 'queues',
      },
      alarm: {
        rank: 2,
        row: 0,
        label: 'Object alarm',
        sublabel: 'ctx.storage.setAlarm',
        icon: 'clock',
      },
      grants: {
        rank: 3,
        row: 1,
        label: 'Grants table',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      leases: {
        rank: 3,
        row: 2,
        label: 'Leases table',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
    },
    edges: [
      {
        from: 'client',
        to: 'holder',
        label: 'permits(message)',
        flow: 'request',
      },
      { from: 'holder', to: 'semaphore', label: 'handle()', flow: 'request' },
      { from: 'semaphore', to: 'pending', flow: 'request' },
      { from: 'semaphore', to: 'grants', label: 'grants', flow: 'round' },
      { from: 'semaphore', to: 'leases', label: 'leases', flow: 'round' },
      { from: 'semaphore', to: 'alarm', label: 'setAlarm', flow: 'round' },
      {
        from: 'pending',
        to: 'client',
        label: 'PermitGrant',
        flow: 'round',
        back: true,
      },
      {
        from: 'alarm',
        to: 'holder',
        label: 'alarm()',
        flow: 'recover',
        back: true,
      },
    ],
    groups: [
      {
        id: 'client-object',
        label: 'Client Durable Object',
        contains: ['client'],
      },
      {
        id: 'holder-object',
        label: 'Holder Durable Object',
        contains: [
          'holder',
          'semaphore',
          'pending',
          'alarm',
          'grants',
          'leases',
        ],
      },
    ],
  },
  details: {
    client: {
      description:
        'Another Durable Object, usually running DurabilitySemaphoreQueue. It reaches the holder by the semaphore key and keeps its own copy of every grant and lease in its own storage.',
      href: '/primitives/semaphore-queue/',
      source: 'route',
    },
    holder: {
      description:
        'Your class. One instance per semaphore key, here per account. It exposes handle() through an RPC method of its own and delegates alarm() to the scheduler the semaphore is attached to.',
      href: '/primitives/semaphore/',
      source: 'account-limit',
    },
    semaphore: {
      description:
        'The helper is rebuilt with each instance of the object. It owns the round timer, the time of the last round, and whether that round was contended; none of these are stored.',
      href: '/primitives/semaphore/',
      source: 'construct',
    },
    pending: {
      description:
        'Requests waiting for the next round, held as unresolved promises. They are not a persisted work queue: eviction fails the waiting RPC calls and clients must ask again.',
      href: '/primitives/semaphore/',
      source: 'schedule-round',
    },
    alarm: {
      description:
        'The object’s one alarm. Through the scheduler it follows the earliest expiry of a grant with unclaimed permits, so unclaimed capacity comes back even if nobody sends another request.',
      href: '/primitives/scheduler/',
      source: 'next-pending',
    },
    grants: {
      description:
        'durability_semaphore_grants: one row per grant with client ID, group, permits, cumulative claimed and released counts, and the claim deadline.',
      href: '/reference/storage/',
      source: 'allocate',
    },
    leases: {
      description:
        'durability_semaphore_leases: blocks of permits a client may draw locally, with the released count, an expiry refreshed by reports, and a retired flag.',
      href: '/reference/storage/',
      source: 'allocate-leases',
    },
  },
  excerpts: [
    accountLimit,
    route,
    outstanding,
    construct,
    handle,
    scheduleRound,
    runRound,
    allocate,
    applyReports,
    reclaim,
    nextPendingAt,
    leaseReports,
    allocateLeases,
  ],
  scenarios: [
    {
      id: 'round',
      title: 'Allocate a round',
      description:
        'Follow one permit request from a client object to stored grants and leases in the holder’s storage.',
      steps: [
        {
          id: 'field',
          title: 'The limit lives in an object you own',
          description:
            'The semaphore attaches to a DurabilityScheduler built on this.ctx, so it uses this object’s storage and alarm. limit() and groupLimit() are your callbacks; the semaphore evaluates them once per round.',
          stage: ['holder', 'semaphore', 'holder-object', 'focus:semaphore'],
          source: sourceFocus(
            accountLimit,
            'private readonly scheduler = new DurabilityScheduler({ context: this.ctx });',
            'ttlMs: 10 * 60_000,'
          ),
          durable: 'Nothing is written yet.',
          volatile:
            'The helper, its round timer, and the example’s workflowLimits map exist only in this instance.',
          status: 'normal',
        },
        {
          id: 'migrate',
          title: 'Create grant and lease tables',
          description:
            'The constructor applies the semaphore migrations through ctx.storage.sql, then registers with the engine. Only the grants table takes part in alarm passes: due work there is reclaiming unclaimed permits.',
          stage: ['grants', 'leases'],
          source: sourceFocus(
            construct,
            "this.#engine.migrateSchema('semaphore', durabilitySemaphoreMigrations);",
            'nextPendingAt: () => this.#store.nextPendingAt(),'
          ),
          durable:
            'durability_semaphore_grants and durability_semaphore_leases exist in this object’s storage.',
          volatile:
            'The registration with the engine is repeated on each construction.',
          status: 'commit',
        },
        {
          id: 'rpc',
          title: 'A client object asks for permits',
          description:
            'DurabilitySemaphore.client() gets the holder with getByName(key) and calls your permits() method, which forwards the message to handle(). The message carries the client’s demand per group and cumulative reports for the grants and leases it holds.',
          stage: ['client', 'client-object', 'flow:request'],
          source: sourceFocus(
            route,
            'const stub = namespace.getByName(',
            'return config.invoke(stub, message);'
          ),
          durable: 'Nothing is written until the round runs.',
          volatile: 'The client’s RPC call stays open until its round.',
          status: 'normal',
        },
        {
          id: 'wait',
          title: 'The request waits in memory for its round',
          description:
            'handle() pushes the request onto an in-memory list and sets a timer. A round waits at least roundWaitMs (1 second) to collect concurrent requests and starts no sooner than roundPeriodMs (2 seconds) after the last one. Rounds never overlap.',
          stage: ['pending', 'focus:pending'],
          source: sourceFocus(
            scheduleRound,
            'const earliest = this.#lastRoundAt + this.#roundPeriodMs;',
            'this.#engine.waitUntil(this.#round, onError);'
          ),
          durable: 'Nothing is written for a waiting request.',
          volatile:
            'The request, its resolve callback, and the round timer. The round promise is passed to ctx.waitUntil.',
          status: 'normal',
        },
        {
          id: 'reports',
          title: 'Apply cumulative reports first',
          description:
            'The round runs in one storage transaction. Claimed and released counts only move forward and are clamped to what the grant can honour, so a repeated or reordered report cannot free capacity twice. A fully released grant is deleted.',
          stage: ['focus:grants'],
          source: sourceFocus(
            applyReports,
            'const claimed = Math.max(',
            'store.update(updated);'
          ),
          durable: 'Grant rows advance to the reported counts.',
          volatile: 'Nothing; reports are applied inside the transaction.',
          status: 'commit',
        },
        {
          id: 'allocate',
          title: 'Grant the oldest demand first',
          description:
            'After reclaiming expired unclaimed permits, the round sorts all demand by its oldest queued time and grants up to the group limit and what remains of the limit. Each grant row gets a claim deadline grantTimeoutMs (10 seconds) away.',
          stage: ['focus:grants'],
          source: sourceFocus(
            allocate,
            'const demands = pending',
            'store.insert(grant);'
          ),
          durable: 'New grant rows with claimed = 0 count against the limit.',
          volatile: 'The per-request allocations, until the reply.',
          status: 'commit',
        },
        {
          id: 'leases',
          title: 'Lease what is left',
          description:
            'In strict mode leases share the limit with grants: the lease budget is what grants left, and a live lease’s unreleased permits stay reserved from the same pool. Only clients that sent a leases array are candidates.',
          stage: ['focus:leases'],
          source: sourceFocus(
            allocate,
            'const leaseBudget = budget.shared',
            'leaseEvents = outcome.events;'
          ),
          durable: 'New lease rows with an expiry ttlMs away.',
          volatile: 'Nothing beyond the reply being built.',
          status: 'commit',
        },
        {
          id: 'arm',
          title: 'Set the alarm for the claim deadline',
          description:
            'Before the transaction commits, the scheduler sets the object’s one alarm from the earliest deadline of a grant with unclaimed permits, never sooner than alarmMinDelayMs (15 seconds). A sooner deadline is covered by an in-memory timer. Lease expiry does not set the alarm.',
          stage: ['alarm', '-alarm->holder', 'focus:alarm'],
          source: sourceFocus(
            nextPendingAt,
            'WHERE claimed < permits',
            'ORDER BY expires_at ASC'
          ),
          durable: 'The alarm commits with the grant rows it serves.',
          volatile: 'The in-memory timer for a deadline before the alarm.',
          status: 'commit',
        },
        {
          id: 'reply',
          title: 'Resolve the waiting RPC',
          description:
            'Only after the commit does each waiting promise resolve, with its grants, blocked groups, clamped claim results, leases, and nextRequestAt: when the client may ask again.',
          stage: ['flow:round'],
          source: sourceFocus(
            runRound,
            'const nextRequestAt = now + this.#roundPeriodMs;',
            'nextRequestAt,'
          ),
          durable: 'Grants and leases are committed before the reply leaves.',
          volatile:
            'The reply in flight. If it is lost, the capacity stays reserved.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Lose the object and the reply',
      description:
        'An illustrative eviction before a round and a reply lost after one, not execution of the example code.',
      steps: [
        {
          id: 'evicted',
          title: 'Evicted before the round runs',
          description:
            'Waiting requests are promises in memory. If the holder is evicted before its round, every waiting RPC call fails and nothing was allocated; each client must ask again.',
          stage: ['*', 'focus:pending'],
          source: sourceFocus(
            handle,
            'answered when its round runs; the caller must keep awaiting it. Pending',
            'fails and the client asks again.'
          ),
          durable: 'Grant and lease rows from earlier rounds are untouched.',
          volatile:
            'The waiting requests, the round timer, and the contended flag are lost.',
          status: 'failure',
        },
        {
          id: 'lost-reply',
          title: 'The round commits but the reply is lost',
          description:
            'If the RPC breaks after the round’s transaction commits, the grants and any leases exist but the client never learns their IDs. Unclaimed grant permits are reclaimed after the deadline. An expired lease is only retired and keeps its footprint until its client settles it, which a client that never stored it cannot do. The example has no reconciliation for unknown leases, so their capacity stays stranded.',
          stage: ['flow:round'],
          source: sourceFocus(
            runRound,
            'round = await this.#engine.transaction(() =>',
            'this.#allocate(pending, limit, policies, now)'
          ),
          durable:
            'Unclaimed grant rows count until reclaim; unknown lease rows count indefinitely.',
          volatile:
            'The reply. It is not stored, so a retried request gets new grants and leases.',
          status: 'gap',
        },
        {
          id: 'wake',
          title: 'The alarm brings the holder back',
          description:
            'After the claim deadline, the physical alarm provides recovery. It is set at least the scheduler’s minimum alarm delay out (15 seconds by default, longer than the 10-second claim window) and may fire late; a live instance’s in-memory timer may reclaim earlier. The runtime creates a new instance, which builds a new scheduler and semaphore, and calls alarm(). Without this delegation, unclaimed permits left by an evicted instance wait for the next round.',
          stage: ['flow:recover'],
          source: sourceFocus(
            accountLimit,
            'override alarm(info?: AlarmInvocationInfo) {',
            'return this.scheduler.alarm(info);'
          ),
          durable: 'The alarm and the grant rows.',
          volatile: 'A fresh helper with no waiting requests.',
          status: 'recovery',
        },
        {
          id: 'callbacks',
          title: 'Your limit callbacks start over',
          description:
            'In the example, groupLimit() reads workflowLimits, a Map on the instance. Caps set with limitWorkflow() are gone after eviction until set again; persist them if they must survive.',
          stage: ['focus:holder'],
          source: sourceFocus(
            accountLimit,
            'groupLimit: (workflowId) => this.workflowLimits.get(workflowId),'
          ),
          durable: 'Grant and lease rows are unaffected.',
          volatile: 'Workflow caps held in the Map.',
          status: 'gap',
        },
        {
          id: 'reclaim',
          title: 'Reclaim unclaimed permits',
          description:
            'The alarm pass shrinks each grant past its deadline to what was claimed, deletes it if that is all released, and emits grant_reclaimed after the commit. Rounds run the same reclaim first.',
          stage: ['focus:grants'],
          source: sourceFocus(
            reclaim,
            'const updated: GrantRow = { ...grant, permits: grant.claimed };',
            'kept.push(updated);'
          ),
          durable: 'The grant keeps only its claimed permits.',
          volatile: 'The reclaim events until they are emitted.',
          status: 'recovery',
        },
        {
          id: 'clamp',
          title: 'A late claim is clamped',
          description:
            'A client that claims after the deadline gets its claim clamped to what the grant still holds and status expired, so it requeues the items it could not admit. If reclaim already ran on a grant with nothing claimed, the grant was deleted and the claim gets not_found instead.',
          stage: ['flow:request'],
          source: sourceFocus(
            applyReports,
            'if (!grant || grant.client_id !== clientId) {',
            "status: expired && report.claimed > claimed ? 'expired' : 'ok',"
          ),
          durable: 'The claimed count never exceeds the grant.',
          volatile: 'The result travels in the reply.',
          status: 'recovery',
        },
        {
          id: 'charged',
          title: 'Claimed permits stay charged',
          description:
            'A claimed permit counts until the client reports it released. The holder cannot stop external work; a client that never reports keeps that capacity in use, and a lowered limit only stops new admissions.',
          stage: ['focus:grants'],
          source: sourceFocus(
            outstanding,
            'const outstanding = (grant: GrantRow, now: number): number =>',
            'Math.max(0, effectivePermits(grant, now) - grant.released);'
          ),
          durable: 'Claimed, unreleased permits stay in the grant row.',
          volatile: 'Nothing can reclaim them without a report.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'lease-expiry',
      title: 'Retire a lease nobody reports',
      description:
        'How the holder keeps a lease’s capacity counted when its client goes quiet.',
      steps: [
        {
          id: 'issued',
          title: 'A lease is a row with an expiry',
          description:
            'A round inserts a lease row with its client, group, and permits, and an expiry ttlMs away, then returns the lease in the reply. The client draws from it locally, so the holder only learns what was drawn from reports.',
          stage: ['*', 'flow:round'],
          source: sourceFocus(
            allocateLeases,
            'const lease: LeaseRow = {',
            'store.insertLease(lease);'
          ),
          durable: 'The lease row and its full footprint.',
          volatile:
            'Nothing; what the client drew is unknown until it reports.',
          status: 'commit',
        },
        {
          id: 'heartbeat',
          title: 'Reports keep the lease alive',
          description:
            'Every request or sync that reports a live lease moves its expiry ttlMs forward and advances the released count, clamped to what was drawn.',
          stage: ['focus:leases'],
          source: sourceFocus(
            leaseReports,
            'const refreshed: LeaseRow = {',
            'store.updateLease(refreshed);'
          ),
          durable: 'The refreshed expiry and released count.',
          volatile: 'The echoed lease in the reply.',
          status: 'commit',
        },
        {
          id: 'retired',
          title: 'An unreported lease is retired, not swept',
          description:
            'The next round marks an expired lease retired: no more draws, but its whole footprint stays counted, because its client may be cut off with work still running. This happens in a round; the alarm does not watch lease expiry.',
          stage: ['focus:semaphore'],
          source: sourceFocus(
            allocateLeases,
            '// An unreported lease is retired, not swept: its client may be cut off',
            'store.updateLease(current);'
          ),
          durable: 'retired = 1; the footprint is unchanged.',
          volatile: 'The lease_retired event.',
          status: 'recovery',
        },
        {
          id: 'settle',
          title: 'The client’s final report settles it',
          description:
            'Only the client’s own retired report shrinks the lease to what it drew. Once every drawn permit is released, the row is deleted.',
          stage: ['focus:leases'],
          source: sourceFocus(
            leaseReports,
            'const permits =',
            'store.removeLease(lease.lease_id);'
          ),
          durable: 'The lease row shrinks, then disappears.',
          volatile: 'Nothing.',
          status: 'commit',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
