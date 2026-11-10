import example from '../../../examples/account-concurrency/worker.ts?raw';
import queue from '../../../packages/durability/src/semaphore/queue.ts?raw';
import queueStore from '../../../packages/durability/src/semaphore/queue-store.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/account-concurrency/worker.ts';
const queueFile = 'packages/durability/src/semaphore/queue.ts';
const storeFile = 'packages/durability/src/semaphore/queue-store.ts';

const jobShard = sourceExcerpt(
  example,
  exampleFile,
  'job-shard',
  'JobShard Durable Object',
  'export class JobShard extends DurableObject<Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const routing = sourceExcerpt(
  example,
  exampleFile,
  'routing',
  'Route jobs to shards',
  'const shardFor = (accountId: string, width = 4): string => {',
  '    return Response.json(results, { status: 202 });'
);
const finishedOption = sourceExcerpt(
  queue,
  queueFile,
  'finished-option',
  'The finished() check',
  '   * Returns which of these admitted items are done. The queue asks on its own',
  '  finished?(ids: string[]): string[] | Promise<string[]>;'
);
const construct = sourceExcerpt(
  queue,
  queueFile,
  'construct',
  'Attach to the object storage',
  '    const scheduler = config.scheduler ?? new DurabilityScheduler(config);',
  '        this.#store.nextPendingAt(this.#finished !== undefined),\n    });'
);
const enqueue = sourceExcerpt(
  queue,
  queueFile,
  'enqueue',
  'Insert items',
  '  async enqueue(',
  '    return { queued: queued.map((row) => row.id), duplicates };\n  }'
);
const release = sourceExcerpt(
  queue,
  queueFile,
  'release',
  'Release a permit',
  '  async release(id: string): Promise<boolean> {',
  '    return true;\n  }'
);
const runDue = sourceExcerpt(
  queue,
  queueFile,
  'run-due',
  'Run due work from the alarm',
  '  async #runDue(now: number): Promise<void> {',
  '        .map(({ key }) => this.#request(key))\n    );\n  }'
);
const request = sourceExcerpt(
  queue,
  queueFile,
  'request',
  'Ask the holder for permits',
  '  async #request(key: string): Promise<void> {',
  '        throw error;\n      }'
);
const claimLocally = sourceExcerpt(
  queue,
  queueFile,
  'claim-locally',
  'Claim items against grants',
  '  #claimLocally(key: string): void {',
  '    this.#drawLeases(key);\n  }'
);
const drawLeases = sourceExcerpt(
  queue,
  queueFile,
  'draw-leases',
  'Draw from a lease',
  '  #drawLeases(key: string): void {',
  '      this.#stageLeaseReport(lease);\n    }\n  }'
);
const returnIdleLeases = sourceExcerpt(
  queue,
  queueFile,
  'return-idle-leases',
  'Return idle lease permits',
  '  #returnIdleLeases(key: string): void {',
  '      this.#stageLeaseReport(returned);\n    }\n  }'
);
const applyLeaseGrants = sourceExcerpt(
  queue,
  queueFile,
  'apply-lease-grants',
  'Store leases from the holder',
  '  #applyLeaseGrants(key: string, grants: LeaseGrant[]): void {',
  '        confirmed: 0,\n      });\n    }\n  }'
);
const renewLeases = sourceExcerpt(
  queue,
  queueFile,
  'renew-leases',
  'Report leases in use',
  '  async #renewLeases(now: number): Promise<void> {',
  '        this.#stageLeaseReport(lease);\n      }\n    });\n  }'
);
const applyResults = sourceExcerpt(
  queue,
  queueFile,
  'apply-results',
  'Admit confirmed claims',
  '  #applyResults(key: string, results: GrantResult[]): void {',
  '        store.updateGrant(updated);\n      }\n    }\n  }'
);
const publishReports = sourceExcerpt(
  queue,
  queueFile,
  'publish-reports',
  'Sync reports to the holder',
  '  async #publishReports(entries: OutboxEntry<Report>[]): Promise<void> {',
  '    this.#engine.waitUntil(this.#notify().catch(onError), onError);\n  }'
);
const checkFinished = sourceExcerpt(
  queue,
  queueFile,
  'check-finished',
  'Release what finished() reports done',
  '  async #checkFinished(now: number): Promise<void> {',
  '        await this.release(id);\n      }\n    }\n  }'
);
const notifyBatch = sourceExcerpt(
  queue,
  queueFile,
  'notify-batch',
  'Hand admitted items to admit()',
  '  async #notifyBatch(): Promise<void> {',
  '    } finally {\n      release();\n    }\n  }'
);
const nextPendingAt = sourceExcerpt(
  queueStore,
  storeFile,
  'next-pending',
  'When the queue next needs the alarm',
  '  nextPendingAt(checksFinished: boolean): number | undefined {',
  "    return typeof at === 'number' ? at : undefined;\n  }"
);

export const walkthrough = validateWalkthrough({
  id: 'semaphore-queue',
  title: 'How DurabilitySemaphoreQueue uses your Durable Object',
  summary:
    'The queue keeps items, grants, leases, and pending reports in its object’s SQLite storage, asks the holder object for permits over RPC, and drives requests, reports, and checks from the object’s single alarm. Step through an admission, a release, and an eviction.',
  diagram: {
    canvas: { width: 1080, height: 1100 },
    direction: 'down',
    routing: 'auto',
    flows: {
      enqueue: { label: 'enqueue items', color: 'blue' },
      permits: { label: 'request and report permits', color: 'purple' },
      admit: { label: 'admit items', color: 'orange' },
      release: { label: 'release a permit', color: 'red' },
      recover: { label: 'recover from the alarm', color: 'green' },
    },
    nodes: {
      worker: {
        rank: 0,
        row: 1,
        label: 'Worker',
        sublabel: 'fetch handler',
        icon: 'workers',
        tone: 'external',
      },
      alarm: {
        rank: 1,
        row: 0,
        label: 'Object alarm',
        sublabel: 'ctx.storage.setAlarm',
        icon: 'clock',
      },
      shard: {
        rank: 1,
        row: 1,
        label: 'JobShard',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      queue: {
        rank: 2,
        row: 1,
        label: 'Queue',
        sublabel: 'in memory',
        icon: 'queues',
      },
      jobs: {
        rank: 2,
        row: 2,
        label: 'jobs.run',
        sublabel: 'durable operation',
        icon: 'shield',
      },
      items: {
        rank: 3,
        row: 0,
        label: 'Queue tables',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      outbox: {
        rank: 3,
        row: 2,
        label: 'Outbox rows',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      holder: {
        rank: 4,
        row: 0,
        label: 'AccountLimit',
        sublabel: 'semaphore holder',
        icon: 'durable-objects',
      },
    },
    edges: [
      { from: 'worker', to: 'shard', label: 'submit(jobs)', flow: 'enqueue' },
      {
        from: 'shard',
        to: 'queue',
        label: 'enqueue / release',
        flow: 'enqueue',
      },
      { from: 'queue', to: 'items', label: 'rows', flow: 'enqueue' },
      { from: 'queue', to: 'alarm', label: 'setAlarm', flow: 'enqueue' },
      { from: 'queue', to: 'holder', label: 'request()', flow: 'permits' },
      { from: 'queue', to: 'outbox', label: 'reports', flow: 'permits' },
      { from: 'outbox', to: 'holder', label: 'sync()', flow: 'permits' },
      { from: 'queue', to: 'jobs', label: 'admit()', flow: 'admit' },
      {
        from: 'jobs',
        to: 'shard',
        label: 'lifecycle event',
        flow: 'release',
        back: true,
      },
      {
        from: 'alarm',
        to: 'shard',
        label: 'alarm()',
        flow: 'recover',
        back: true,
      },
    ],
    groups: [
      {
        id: 'client-object',
        label: 'Client Durable Object',
        contains: ['alarm', 'shard', 'queue', 'jobs', 'items', 'outbox'],
      },
      {
        id: 'holder-object',
        label: 'Holder Durable Object',
        contains: ['holder'],
      },
    ],
  },
  details: {
    worker: {
      description:
        'Spreads each account’s jobs to one shard, named from a hash of the account ID, with getByName() and calls submit() over RPC.',
      href: '/primitives/routing/',
      source: 'routing',
    },
    shard: {
      description:
        'Your class. The queue and the jobs helper share its one scheduler. Its alarm() must delegate to that scheduler, and its lifecycle hook calls release().',
      href: '/primitives/semaphore-queue/',
      source: 'job-shard',
    },
    alarm: {
      description:
        'The object’s one alarm. Through the scheduler it follows the earliest due key request, admit() retry, finished() check, or lease report.',
      href: '/primitives/scheduler/',
      source: 'next-pending',
    },
    queue: {
      description:
        'The helper is rebuilt with each instance. In memory it keeps only the keys with a request in flight, the holder’s last blocked reasons, and the running admit() and finished() calls.',
      href: '/primitives/semaphore-queue/',
      source: 'construct',
    },
    jobs: {
      description:
        'The admit() target in the example: a Durability operation registered with the item ID, so a repeated admit() is a no-op.',
      href: '/primitives/operations/',
      source: 'job-shard',
    },
    items: {
      description:
        'durability_semaphore_queue_items, _grants, _keys, and _leases: items and their state, this object’s copy of each grant and lease, and per-key request pacing.',
      href: '/reference/storage/',
      source: 'enqueue',
    },
    outbox: {
      description:
        'Rows of the durability.semaphore-queue outbox channel in durability_outbox: the newest cumulative claimed, released, or drawn counts per grant or lease, kept until a sync succeeds.',
      href: '/primitives/outbox/',
      source: 'publish-reports',
    },
    holder: {
      description:
        'Another Durable Object running DurabilitySemaphore. It answers requests in rounds and applies syncs at once; it never calls the queue.',
      href: '/primitives/semaphore/',
      source: 'request',
    },
  },
  excerpts: [
    jobShard,
    routing,
    finishedOption,
    construct,
    enqueue,
    release,
    runDue,
    request,
    claimLocally,
    drawLeases,
    returnIdleLeases,
    applyLeaseGrants,
    renewLeases,
    applyResults,
    publishReports,
    checkFinished,
    notifyBatch,
    nextPendingAt,
  ],
  scenarios: [
    {
      id: 'admit',
      title: 'Queue and admit an item',
      description:
        'Follow one job from submit() to admit() through the queue’s tables and the holder object.',
      steps: [
        {
          id: 'field',
          title: 'The queue shares the object’s scheduler',
          description:
            'The queue attaches to the same DurabilityScheduler as the jobs helper, so both use this object’s storage and alarm. clientId is the object’s own ID, the name the holder knows this client by; server is the client from DurabilitySemaphore.client().',
          stage: ['shard', 'queue', 'client-object', 'focus:queue'],
          source: sourceFocus(
            jobShard,
            'private readonly permits = new DurabilitySemaphoreQueue<Job>({',
            'server: limits.with(timeout, 5_000),'
          ),
          durable: 'Nothing is written yet.',
          volatile:
            'The helper, the keys with a request in flight, and the holder’s blocked reasons.',
          status: 'normal',
        },
        {
          id: 'migrate',
          title: 'Create queue tables and an outbox channel',
          description:
            'The constructor applies the queue migrations through ctx.storage.sql and opens the durability.semaphore-queue outbox channel on the same scheduler. Report retries are capped at 5 seconds, half the holder’s default claim window.',
          stage: ['items', 'outbox'],
          source: sourceFocus(
            construct,
            'this.#engine.migrateSchema(',
            'nextPendingAt: () =>'
          ),
          durable: 'The queue tables and durability_outbox exist.',
          volatile:
            'The registrations with the engine repeat on each construction.',
          status: 'commit',
        },
        {
          id: 'submit',
          title: 'A Worker submits jobs',
          description:
            'The Worker groups jobs by shard name and calls submit() on each shard. There each job becomes an item with a stable ID, the account as the semaphore key, and the workflow as its group.',
          stage: ['worker', 'flow:enqueue'],
          source: sourceFocus(
            routing,
            'const shard = shardFor(job.accountId);',
            'env.JOB_SHARDS.getByName(shard).submit(shardJobs)'
          ),
          durable: 'Nothing is written until the transaction commits.',
          volatile: 'The RPC call is waiting on enqueue().',
          status: 'normal',
        },
        {
          id: 'insert',
          title: 'Insert items in one transaction',
          description:
            'A known item ID is reported as a duplicate, not inserted twice. Items whose key already holds unclaimed permits or a drawable lease are claimed or drawn at once; the rest are counted on the key’s row with its next request time.',
          stage: ['focus:items'],
          source: sourceFocus(
            enqueue,
            'if (store.insertItem(row)) {',
            'this.#refreshKey(key);'
          ),
          durable: 'Queued item rows and the key row.',
          volatile: 'Nothing; the RPC resolves after the commit.',
          status: 'commit',
        },
        {
          id: 'arm',
          title: 'Set the alarm for the next request',
          description:
            'Before the transaction commits, the scheduler sets the object’s one alarm from the queue’s earliest due time: a key with queued items, an admitted item to notify or check, or a lease to report. Never sooner than alarmMinDelayMs; an in-memory timer covers sooner work.',
          stage: ['alarm', '-alarm->shard', 'focus:alarm'],
          source: sourceFocus(
            nextPendingAt,
            'SELECT next_request_at FROM durability_semaphore_queue_keys',
            'FROM durability_semaphore_queue_leases WHERE confirmed = 0'
          ),
          durable: 'The alarm commits with the item rows.',
          volatile: 'The in-memory timer for work due before the alarm.',
          status: 'commit',
        },
        {
          id: 'request',
          title: 'Ask the holder for permits',
          description:
            'When the key is due, the queue builds demand per group from its oldest queued items and attaches cumulative reports. It first moves the key’s next request time to a deadline attemptTimeoutMs away, then calls the holder, which answers when its round runs.',
          stage: ['holder', 'holder-object', 'focus:holder'],
          source: sourceFocus(
            request,
            'next_request_at: Date.now() + this.#attemptTimeoutMs,',
            'this.#server.request(key, message)'
          ),
          durable: 'The key row holds the request deadline.',
          volatile: 'The open RPC and the key’s entry in the in-flight set.',
          status: 'normal',
        },
        {
          id: 'claim',
          title: 'Store the grant and claim items',
          description:
            'One transaction stores the returned grants and leases, marks queued items claiming against the grants, stages the new cumulative claimed count in the outbox, and records the holder’s nextRequestAt.',
          stage: ['focus:items'],
          source: sourceFocus(
            claimLocally,
            'grant.claimed += 1;',
            'this.#stageReport(grant);'
          ),
          durable:
            'This object’s grant rows, claiming items, and an outbox row, together.',
          volatile: 'The blocked reasons from the reply.',
          status: 'commit',
        },
        {
          id: 'confirm',
          title: 'The holder confirms the claim',
          description:
            'The outbox sends one sync per key with the cumulative counts. The holder clamps the claim to the grant and replies; the queue then admits as many claiming items as the holder confirmed.',
          stage: ['flow:permits'],
          source: sourceFocus(
            applyResults,
            'const confirmed =',
            "status: 'admitted',"
          ),
          durable:
            'Items become admitted; the outbox row is removed once the publish is acknowledged.',
          volatile: 'The sync in flight. A failed sync is retried.',
          status: 'commit',
        },
        {
          id: 'admit',
          title: 'Hand admitted items to admit()',
          description:
            'Admitted items are claimed for one attempt in a transaction, then passed to admit(), which here registers jobs.run with the item ID. When it returns, each item is marked notified and its first finished() check is scheduled finishedCheckMs later.',
          stage: ['jobs', 'flow:admit'],
          source: sourceFocus(
            notifyBatch,
            'const claimed = await this.#engine.transaction(() => {',
            "await this.#deadline('admit', () => this.#admit(admitted));"
          ),
          durable: 'The attempt count, then notified = 1.',
          volatile: 'The admit() call and a scheduler permit.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'release',
      title: 'Return a permit',
      description:
        'How a permit goes back to the holder, and what happens when the release call is lost.',
      steps: [
        {
          id: 'hook',
          title: 'The operation ends and the hook releases',
          description:
            'When jobs.run completes, or emits terminal after its attempts are exhausted, the example’s lifecycle hook calls release(id). It does not handle attempt_settled with outcome failed, which an exhausted or non-retryable attempt emits; finished() recovers those releases. The hook is best effort: a crash between the end of the operation and this call loses it.',
          stage: ['*', 'flow:release'],
          source: sourceFocus(
            jobShard,
            'onLifecycleEvent: (event): Promise<void> | undefined => {',
            'return this.permits.release(event.id).then(() => undefined);'
          ),
          durable: 'The operation’s result is already stored.',
          volatile: 'The lifecycle event and the release() call.',
          status: 'normal',
        },
        {
          id: 'delete',
          title: 'Delete the item and stage the release',
          description:
            'In one transaction the admitted item is deleted, its grant’s released count goes up by one, and the new cumulative count is staged in the outbox. Releasing an item that is not admitted does nothing.',
          stage: ['focus:items'],
          source: sourceFocus(
            release,
            'store.removeItem(id);',
            'this.#stageReport(updated);'
          ),
          durable: 'The item is gone and the report is an outbox row.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'sync',
          title: 'A sync returns the permit',
          description:
            'The outbox keeps only the newest counts per grant, so several releases travel as one report. The holder advances its released count, clamped to what was claimed, and deletes a grant once all of it is released.',
          stage: ['flow:permits'],
          source: sourceFocus(
            publishReports,
            'const grants: GrantReport[] = [];',
            'released: entry.value.released,'
          ),
          durable: 'The outbox row stays until the sync succeeds.',
          volatile: 'The sync in flight.',
          status: 'commit',
        },
        {
          id: 'finished',
          title: 'finished() finds a lost release',
          description:
            'On a timer or alarm pass, admitted items whose check is due get their next check time first, then finished() is asked about them. The example treats any result that is no longer pending as done, and each one is released.',
          stage: ['focus:jobs'],
          source: sourceFocus(
            checkFinished,
            'const later = now + this.#finishedCheckMs;',
            'await this.release(id);'
          ),
          durable: 'The next check time, then the release.',
          volatile: 'The finished() call.',
          status: 'recovery',
        },
        {
          id: 'no-check',
          title: 'Without finished(), the permit stays charged',
          description:
            'If finished is not configured, release() is the only way a permit comes back. A lost call keeps the permit counted at the holder until something releases the item.',
          stage: ['focus:holder'],
          source: sourceFocus(
            finishedOption,
            'best-effort lifecycle hook, a crash) still comes back. Without it,',
            '`release()` is the only way a permit returns.'
          ),
          durable: 'The holder’s grant keeps the claimed permit.',
          volatile: 'Nothing can recover the lost call.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Evict the shard',
      description:
        'Illustrative evictions during a holder request and during admit(), not execution of the example code.',
      steps: [
        {
          id: 'evicted',
          title: 'Evicted while the holder holds the request',
          description:
            'The open RPC is lost with the instance. If the holder’s round already committed grants for it, this object never learns them; the holder reclaims their unclaimed permits after its claim window.',
          stage: ['*', 'focus:holder'],
          source: sourceFocus(
            request,
            '// While the holder holds the request for its round, the key must not',
            '// for the whole wait. A crash mid-request leaves it due at the deadline.'
          ),
          durable: 'Queued items, and the key row due at the request deadline.',
          volatile: 'The RPC and the in-flight set.',
          status: 'failure',
        },
        {
          id: 'wake',
          title: 'The alarm brings the shard back',
          description:
            'The runtime creates a new instance, which rebuilds the scheduler, the jobs helper, and the queue, and calls alarm(). The class must delegate it to the shared scheduler.',
          stage: ['flow:recover'],
          source: sourceFocus(
            jobShard,
            'override alarm(info?: AlarmInvocationInfo) {',
            'return this.scheduler.alarm(info);'
          ),
          durable: 'The alarm and every queue row.',
          volatile: 'A fresh helper with nothing in flight.',
          status: 'recovery',
        },
        {
          id: 'due',
          title: 'Due keys ask again',
          description:
            'The alarm pass drops settled leases, hands out pending admit() calls, runs finished() checks, reports leases in use, and then requests permits for every due key that has no request in flight.',
          stage: ['focus:queue'],
          source: sourceFocus(
            runDue,
            'const keys = this.#store.listDueKeys(now);',
            '.map(({ key }) => this.#request(key))'
          ),
          durable: 'Rows are read; requests write as before.',
          volatile: 'The new requests.',
          status: 'recovery',
        },
        {
          id: 'admit-crash',
          title: 'Evicted during admit()',
          description:
            'Before admit() runs, each item’s attempt is counted and its next attempt time set to a deadline. If the object is evicted mid-call, the item stays admitted with notified = 0 and is handed out again after that deadline.',
          stage: ['focus:jobs'],
          source: sourceFocus(
            notifyBatch,
            'attempt: current.attempt + 1,',
            'next_attempt_at: deadline,'
          ),
          durable: 'The admitted item and its attempt count.',
          volatile: 'The admit() call and its progress.',
          status: 'failure',
        },
        {
          id: 'idempotent',
          title: 'admit() must be idempotent',
          description:
            'The queue cannot know whether the lost call registered the work. The example passes the item ID as the operation ID, so registering it again with the same payload is a no-op in Durability.',
          stage: ['focus:jobs'],
          source: sourceFocus(
            jobShard,
            '// Operation IDs equal item IDs, so a repeated admit() is a no-op.',
            'items.map((item) => this.jobs.run({ id: item.id, payload: item.body }))'
          ),
          durable: 'One operation row per item ID.',
          volatile: 'Nothing from the first call.',
          status: 'gap',
        },
        {
          id: 'outbox',
          title: 'Reports wait in the outbox',
          description:
            'Staged reports are rows, so they survive and publish again. Only the retry backoff is capped at 5 seconds: a sync can take up to attemptTimeoutMs to time out, and a retry no in-memory timer runs waits for the physical alarm, at least 15 seconds out by default. Delivery within the claim window is not guaranteed; a claim the holder hears about after it comes back expired, and the queue returns those items to queued.',
          stage: ['focus:outbox'],
          source: sourceFocus(
            construct,
            '// A claim the holder has not heard about within its grant window is',
            'Math.min(this.#retryDelay(attempt), maxReportRetryMs),'
          ),
          durable: 'The newest counts per grant and lease.',
          volatile: 'The failed sync.',
          status: 'recovery',
        },
      ],
    },
    {
      id: 'lease',
      title: 'Admit from a lease',
      description:
        'How the queue admits items locally from a lease and keeps the holder informed.',
      steps: [
        {
          id: 'store',
          title: 'Store a lease from the holder',
          description:
            'A reply can carry a lease: permits this object may draw without asking. The queue stores it with the holder’s expiry and a renewal time at half the remaining lifetime.',
          stage: ['*', 'focus:holder'],
          source: sourceFocus(
            applyLeaseGrants,
            'store.insertLease({',
            'confirmed: 0,'
          ),
          durable: 'This object’s lease row.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'draw',
          title: 'Draw without a round trip',
          description:
            'Queued items in the lease’s group are admitted at once, and the drawn count and its report commit with them. Draws stop 30 seconds before the lease expires, and a drawn permit is never drawable again.',
          stage: ['focus:items'],
          source: sourceFocus(
            drawLeases,
            'lease.drawn += 1;',
            'this.#stageLeaseReport(lease);'
          ),
          durable: 'Admitted items, the drawn count, and an outbox row.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'renew',
          title: 'Report leases in use',
          description:
            'A lease with permits in use, or a stopped lease the holder has not settled, is reported again at its renewal time, so the holder keeps counting it instead of retiring it.',
          stage: ['focus:outbox'],
          source: sourceFocus(
            renewLeases,
            'for (const lease of this.#store.listRenewalsDue(now, 100)) {',
            'this.#stageLeaseReport(lease);'
          ),
          durable: 'The next renewal time and a staged report.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'contended',
          title: 'Return idle permits when contended',
          description:
            'When the holder marks a reply contended, leases in groups with nothing queued stop drawing and shrink to what was drawn. The report says retired, so the holder can lease the undrawn permits to waiting clients.',
          stage: ['flow:permits'],
          source: sourceFocus(
            returnIdleLeases,
            'const returned = { ...lease, permits: lease.drawn, expires_at: now };',
            'this.#stageLeaseReport(returned);'
          ),
          durable: 'The shrunken lease and its report.',
          volatile: 'Nothing.',
          status: 'commit',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
