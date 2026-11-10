import example from '../../../examples/account-concurrency/worker.ts?raw';
import queueSource from '../../../packages/durability/src/semaphore/queue.ts?raw';
import serverSource from '../../../packages/durability/src/semaphore/server.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/account-concurrency/worker.ts';
const queueFile = 'packages/durability/src/semaphore/queue.ts';
const serverFile = 'packages/durability/src/semaphore/server.ts';

const accountLimit = sourceExcerpt(
  example,
  exampleFile,
  'account-limit',
  'AccountLimit Durable Object',
  'export class AccountLimit extends DurableObject<Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const limitsClient = sourceExcerpt(
  example,
  exampleFile,
  'limits-client',
  'Reach AccountLimit by account ID',
  'export const limits = DurabilitySemaphore.client({',
  '});'
);
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
  'Route each account to one shard',
  'const shardFor = (accountId: string, width = 4): string => {',
  '    return Response.json(results, { status: 202 });'
);
const enqueue = sourceExcerpt(
  queueSource,
  queueFile,
  'enqueue',
  'Insert queued items',
  '  async enqueue(',
  '    return { queued: queued.map((row) => row.id), duplicates };\n  }'
);
const request = sourceExcerpt(
  queueSource,
  queueFile,
  'request',
  'Ask AccountLimit for permits',
  '  async #request(key: string): Promise<void> {',
  '      this.#requesting.delete(key);\n    }\n  }'
);
const claim = sourceExcerpt(
  queueSource,
  queueFile,
  'claim',
  'Claim grants and draw leases',
  '  #claimLocally(key: string): void {',
  '      this.#stageLeaseReport(lease);\n    }\n  }'
);
const notify = sourceExcerpt(
  queueSource,
  queueFile,
  'notify',
  'Hand admitted items to admit()',
  '  async #notifyBatch(): Promise<void> {',
  '    } finally {\n      release();\n    }\n  }'
);
const release = sourceExcerpt(
  queueSource,
  queueFile,
  'release',
  'Release one item',
  '  async release(id: string): Promise<boolean> {',
  '    return true;\n  }'
);
const checkFinished = sourceExcerpt(
  queueSource,
  queueFile,
  'check-finished',
  'Ask finished() about admitted items',
  '  async #checkFinished(now: number): Promise<void> {',
  '        await this.release(id);\n      }\n    }\n  }'
);
const publish = sourceExcerpt(
  queueSource,
  queueFile,
  'publish',
  'Send outbox reports to AccountLimit',
  '  async #publishReports(entries: OutboxEntry<Report>[]): Promise<void> {',
  '    this.#engine.waitUntil(this.#notify().catch(onError), onError);\n  }'
);
const handle = sourceExcerpt(
  serverSource,
  serverFile,
  'handle',
  'Hold a request for the next round',
  '  handle(message: SemaphoreRequest): Promise<SemaphoreResponse> {',
  '      this.#scheduleRound();\n    });\n  }'
);
const runRound = sourceExcerpt(
  serverSource,
  serverFile,
  'run-round',
  'Allocate one round in a transaction',
  '  async #runRound(): Promise<void> {',
  '    const nextRequestAt = now + this.#roundPeriodMs;'
);
const reclaim = sourceExcerpt(
  serverSource,
  serverFile,
  'reclaim',
  'Reclaim unclaimed grants',
  '  #reclaim(\n',
  '    return { grants: kept, events };\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'concurrency',
  title: 'How account concurrency uses two Durable Objects',
  summary:
    'Each JobShard keeps its queue, outbox, and operations in its own SQLite storage behind one alarm. Every shard asks the one AccountLimit object named by the account ID for permits. Step through an admission, the naive design it replaces, a lost release, and an evicted AccountLimit.',
  diagram: {
    canvas: { width: 1000, height: 900 },
    direction: 'down',
    routing: 'auto',
    flows: {
      submit: { label: 'submit jobs', color: 'blue' },
      admit: { label: 'admit and run a job', color: 'orange' },
      release: { label: 'release a permit', color: 'purple' },
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
        label: 'Shard alarm',
        sublabel: 'one scheduler',
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
        label: 'permits',
        sublabel: 'semaphore queue',
        size: [230, 72],
        icon: 'shield',
      },
      hook: {
        rank: 1,
        row: 2,
        label: 'Lifecycle hook',
        sublabel: 'best effort',
        icon: 'shield',
      },
      'shard-sql': {
        rank: 3,
        row: 1,
        label: 'queue + calls',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      jobs: {
        rank: 3,
        row: 2,
        label: 'jobs.run',
        sublabel: 'Durability',
        icon: 'workers',
      },
      limit: {
        rank: 4,
        row: 0,
        label: 'AccountLimit',
        sublabel: 'semaphore holder',
        size: [240, 72],
        icon: 'durable-objects',
      },
      grants: {
        rank: 4,
        row: 1,
        label: 'grants + leases',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      api: {
        rank: 4,
        row: 2,
        label: 'JOB_API',
        sublabel: 'external service',
        icon: 'browser',
        tone: 'external',
      },
    },
    edges: [
      { from: 'worker', to: 'shard', label: 'submit(jobs)', flow: 'submit' },
      { from: 'shard', to: 'queue', label: 'enqueue()', flow: 'submit' },
      { from: 'queue', to: 'shard-sql', label: 'rows', flow: 'submit' },
      { from: 'queue', to: 'alarm', label: 'setAlarm', flow: 'submit' },
      {
        from: 'queue',
        to: 'limit',
        label: 'request · sync',
        flow: 'admit',
      },
      { from: 'limit', to: 'grants', label: 'rows', flow: 'admit' },
      { from: 'queue', to: 'jobs', label: 'run(item.id)', flow: 'admit' },
      { from: 'jobs', to: 'shard-sql', label: 'rows', flow: 'admit' },
      {
        from: 'jobs',
        to: 'api',
        label: 'Idempotency-Key',
        flow: 'admit',
      },
      { from: 'jobs', to: 'hook', label: 'event', flow: 'release' },
      { from: 'hook', to: 'queue', label: 'release(id)', flow: 'release' },
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
        id: 'shard-object',
        label: 'JobShard · one per shard name',
        contains: ['alarm', 'shard', 'queue', 'hook', 'shard-sql', 'jobs'],
      },
      {
        id: 'limit-object',
        label: 'AccountLimit · one per account',
        contains: ['limit', 'grants'],
      },
    ],
  },
  details: {
    worker: {
      description:
        'Groups the posted jobs by shardFor(accountId) and calls submit() on env.JOB_SHARDS.getByName(shard). Every job for an account reaches the same JobShard.',
      href: '/primitives/routing/',
      source: 'routing',
    },
    alarm: {
      description:
        'The JobShard has one alarm. The queue, its internal outbox, and the jobs operations all attach to one DurabilityScheduler, which sets that alarm to the earliest work any of them has.',
      href: '/primitives/scheduler/',
      source: 'job-shard',
    },
    shard: {
      description:
        'Your class. Its scheduler, queue, and jobs helper are fields, so they are rebuilt whenever the runtime creates a new instance. Its alarm() delegates to the scheduler.',
      href: '/primitives/scheduler/',
      source: 'job-shard',
    },
    queue: {
      description:
        'DurabilitySemaphoreQueue. In memory it keeps only the keys it is requesting, the last blocked reasons, and the passes in progress; items, grants, leases, and reports are rows in this object’s storage.',
      href: '/primitives/semaphore-queue/',
      source: 'enqueue',
    },
    hook: {
      description:
        'onLifecycleEvent runs after an attempt settles and its promise is passed to ctx.waitUntil. It releases on a completed attempt or a terminal event. Eviction can drop it.',
      href: '/reference/lifecycle/',
      source: 'job-shard',
    },
    'shard-sql': {
      description:
        'The JobShard’s own SQLite: durability_semaphore_queue_items, _grants, _leases, and _keys for admission; durability_outbox for reports to AccountLimit; durability_calls for the jobs operations.',
      href: '/reference/storage/',
      source: 'claim',
    },
    jobs: {
      description:
        'A Durability helper with one handler, run. Its operation ID is the queue item ID, so a repeated admit() registers nothing new.',
      href: '/primitives/operations/',
      source: 'job-shard',
    },
    limit: {
      description:
        'One object per account: the semaphore key is its name. It has its own scheduler and alarm, which reclaims unclaimed grants. Pending requests and the workflowLimits Map are in memory only.',
      href: '/primitives/semaphore/',
      source: 'account-limit',
    },
    grants: {
      description:
        'durability_semaphore_grants and durability_semaphore_leases in AccountLimit’s storage: permits handed to each shard and how many each shard reported claimed and released.',
      href: '/reference/storage/',
      source: 'run-round',
    },
    api: {
      description:
        'A separate service. Retries send the same Idempotency-Key; only the service can deduplicate them, and the abort signal does not prove the service stopped.',
      href: '/reference/guarantees/',
      source: 'job-shard',
    },
  },
  excerpts: [
    jobShard,
    accountLimit,
    limitsClient,
    routing,
    enqueue,
    request,
    claim,
    notify,
    release,
    checkFinished,
    publish,
    handle,
    runRound,
    reclaim,
  ],
  scenarios: [
    {
      id: 'admission',
      title: 'Admit a job against the account budget',
      description:
        'Follow one job from the POST to a released permit. The account budget controls admission across shards; it does not bound an external process that ignores cancellation.',
      steps: [
        {
          id: 'route',
          title: 'Route each account to one shard',
          description:
            'The demo’s shardFor(accountId, 4) returns one stable name per account; it does not spread an account across four shards. getByName(shard) reaches the JobShard with that name.',
          stage: ['worker', 'shard', 'shard-object', 'focus:worker'],
          source: sourceFocus(
            routing,
            '      const shard = shardFor(job.accountId);',
            'env.JOB_SHARDS.getByName(shard).submit(shardJobs)'
          ),
          durable: 'No admission state changes during grouping.',
          volatile:
            'The request-local byShard Map exists only while this fetch runs.',
          status: 'normal',
        },
        {
          id: 'submit',
          title: 'Give each job a stable identity',
          description:
            'submit() turns each job into a queue item: the job ID as item ID, the account ID as semaphore key, and the workflow ID as group.',
          stage: ['queue', 'flow:submit'],
          source: sourceFocus(
            jobShard,
            '      jobs.map((job) => ({',
            '      }))'
          ),
          durable: 'Nothing is written until the queue’s transaction commits.',
          volatile: 'The RPC call is waiting on enqueue().',
          status: 'normal',
        },
        {
          id: 'insert',
          title: 'Insert queued rows in the shard’s SQLite',
          description:
            'One storage transaction inserts each item and updates its key’s row. An item ID that already exists is reported as a duplicate and not inserted again.',
          stage: ['shard-sql', 'focus:shard-sql'],
          source: sourceFocus(
            enqueue,
            'const { queued, duplicates } = await this.#engine.transaction(() => {',
            'return { queued: inserted, duplicates: existing };'
          ),
          durable:
            'Queued rows in durability_semaphore_queue_items and the key in durability_semaphore_queue_keys.',
          volatile: 'Nothing; the rows are the queue.',
          status: 'commit',
        },
        {
          id: 'alarm',
          title: 'One scheduler, one alarm',
          description:
            'The queue, its outbox, and jobs share this scheduler, so they share the JobShard’s single alarm. The enqueue transaction sets it for the new key before it commits; work due sooner runs from an in-memory timer.',
          stage: ['alarm', '-alarm->shard', 'focus:alarm'],
          source: sourceFocus(
            jobShard,
            'private readonly scheduler = new DurabilityScheduler({ context: this.ctx });'
          ),
          durable: 'The alarm is stored with the rows it serves.',
          volatile: 'The in-memory timer belongs to this instance only.',
          status: 'commit',
        },
        {
          id: 'address',
          title: 'Reach the account’s AccountLimit',
          description:
            'The queue’s server is the generated limits client. It calls getByName(accountId) on the AccountLimit namespace, which the Vite plugin resolves from the Worker export, and invokes permits() over RPC.',
          stage: ['limit', 'limit-object', 'focus:limit'],
          source: sourceFocus(
            limitsClient,
            'target: AccountLimit,',
            'invoke: (stub, message) => stub.permits(message),'
          ),
          durable:
            'The name is the account ID, so there is one holder per account.',
          volatile: 'The client remembers each key’s nextRequestAt in memory.',
          status: 'normal',
        },
        {
          id: 'request',
          title: 'Ask for permits from the scheduler pass',
          description:
            'A timer or alarm pass finds the key due and sends its demand per workflow group with cumulative counts for the grants and leases it holds. It first moves the key’s next request 60 seconds out, so a crash mid-request makes the key due again then.',
          stage: ['focus:queue'],
          source: sourceFocus(
            request,
            'next_request_at: Date.now() + this.#attemptTimeoutMs,',
            'this.#server.request(key, message)'
          ),
          durable: 'The key’s request deadline commits before the RPC call.',
          volatile: 'The RPC call is in flight.',
          status: 'commit',
        },
        {
          id: 'round',
          title: 'AccountLimit allocates in one transaction',
          description:
            'AccountLimit answers requests in rounds. Each round reads ACCOUNT_CONCURRENCY and writes grants and leases in one storage transaction; strict provisioning keeps grants plus live lease footprint under that limit.',
          stage: ['grants', 'focus:grants'],
          source: sourceFocus(
            accountLimit,
            'limit: () => Number(this.env.ACCOUNT_CONCURRENCY),',
            'ttlMs: 10 * 60_000,'
          ),
          durable:
            'durability_semaphore_grants and durability_semaphore_leases in AccountLimit’s storage.',
          volatile:
            'The waiting requests and the workflowLimits Map exist only in this AccountLimit instance.',
          status: 'commit',
        },
        {
          id: 'claim',
          title: 'Draw leases and claim grants',
          description:
            'Back in the shard, one transaction stores the reply. Items drawn from a lease are admitted at once; items claimed against a grant wait for AccountLimit to confirm the claim. Each change stages a cumulative report in the outbox.',
          stage: ['focus:shard-sql'],
          source: sourceFocus(
            claim,
            "status: 'admitted',",
            'this.#stageLeaseReport(lease);'
          ),
          durable:
            'Admitted or claiming items and their outbox reports commit together.',
          volatile: 'The reply itself.',
          status: 'commit',
        },
        {
          id: 'hand-off',
          title: 'Mark the batch before admit() runs',
          description:
            'A scheduler pass picks admitted items that admit() has not seen. It first increments each row’s attempt and sets a deadline, so a concurrent pass skips them and a crash makes them due again.',
          stage: ['jobs', 'focus:shard-sql'],
          source: sourceFocus(
            notify,
            'const claimed = await this.#engine.transaction(() => {',
            "await this.#deadline('admit', () => this.#admit(admitted));"
          ),
          durable:
            'Each row’s attempt and deadline commit before admit() is called.',
          volatile: 'The batch handed to admit().',
          status: 'commit',
        },
        {
          id: 'admit',
          title: 'Admit without creating another job',
          description:
            'The scheduler hands admitted items to admit(), which calls jobs.run with the item ID. Registration inserts a pending row in durability_calls; if admit() runs again for the same item, it targets the same operation.',
          stage: ['flow:admit'],
          source: sourceFocus(
            jobShard,
            'admit: (items: AdmittedItem<Job>[]): Promise<void> =>',
            ').then(() => undefined),'
          ),
          durable:
            'The queue item ID and operation ID are the same stable job identity.',
          volatile: 'The admit() call can repeat after an interruption.',
          status: 'commit',
        },
        {
          id: 'call',
          title: 'Call the API with the job ID',
          description:
            'The handler posts to JOB_API with the operation ID as Idempotency-Key and passes the attempt’s abort signal. The operation allows three attempts.',
          stage: ['api', 'focus:api'],
          source: sourceFocus(
            jobShard,
            "headers: { 'Idempotency-Key': id },",
            'signal,'
          ),
          durable: 'The operation row stays pending while the request runs.',
          volatile:
            'The abort signal does not prove that an external process stopped.',
          status: 'normal',
        },
        {
          id: 'release',
          title: 'Release the permit through the hook',
          description:
            'After the completed attempt commits, the lifecycle hook calls permits.release(id). One transaction deletes the item, counts the release on its lease or grant, and stages a report; the outbox sends it to AccountLimit with sync().',
          stage: ['hook', 'flow:release'],
          source: sourceFocus(
            release,
            'const released = await this.#engine.transaction(() => {',
            'this.#stageReport(updated);'
          ),
          durable:
            'The release and its outbox report commit in the shard; AccountLimit learns of it when sync succeeds.',
          volatile: 'The hook promise, kept alive only by ctx.waitUntil.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'naive',
      title: 'Per-shard counters versus one account semaphore',
      description:
        'A naive design keeps a running counter in each shard. Each step shows where that design breaks and the source line that closes the gap here; there is no naive source.',
      steps: [
        {
          id: 'local-ceiling',
          title: 'Naive: each shard enforces the limit alone',
          description:
            'With a limit of 100, shard A and shard B each admit 100 jobs under their own counters, and the account runs 200. Here no shard decides: every item carries key: job.accountId, and the queue asks the holder of that key.',
          stage: ['*', 'focus:queue'],
          source: sourceFocus(jobShard, 'key: job.accountId,'),
          durable: 'The key is stored on each queued row.',
          volatile:
            'A naive counter lives in one shard’s memory or storage and is invisible to the others.',
          status: 'failure',
        },
        {
          id: 'one-holder',
          title: 'One object holds the account’s count',
          description:
            'Every shard’s queue reaches AccountLimit through getByName(accountId), so all grants for the account are rows in one object’s storage, whichever shard asked.',
          stage: ['focus:limit'],
          source: sourceFocus(
            limitsClient,
            'export const limits = DurabilitySemaphore.client({',
            'invoke: (stub, message) => stub.permits(message),'
          ),
          durable: 'Grants for the account live in one object.',
          volatile: 'Nothing is counted in the shards’ memory.',
          status: 'recovery',
        },
        {
          id: 'strict',
          title: 'Prefetched capacity still counts',
          description:
            'A naive shard that reserves a batch ahead hides it from the others. Strict leases count each lease’s unreleased permits against the same limit as grants, so a lease held by shard A reduces what shard B can get.',
          stage: ['focus:grants'],
          source: sourceFocus(
            accountLimit,
            "provisioning: { mode: 'strict' },",
            'permitsPerLease: 16,'
          ),
          durable: 'Lease footprint is stored with the grants.',
          volatile: 'Nothing.',
          status: 'recovery',
        },
        {
          id: 'crash-leak',
          title: 'Naive: a crash before the decrement leaks capacity',
          description:
            'A naive shard decrements after the job ends; a crash in between leaks one unit forever. Here the hook is also only a fast path, but the admitted item stays in the queue table until something releases it.',
          stage: ['flow:release'],
          source: sourceFocus(
            jobShard,
            'const finished =',
            "(event.type === 'attempt_settled' && event.outcome === 'completed');"
          ),
          durable: 'The admitted row and the operation’s outcome.',
          volatile: 'The hook call can be lost.',
          status: 'failure',
        },
        {
          id: 'finished',
          title: 'The queue asks the operation instead',
          description:
            'The shard’s alarm keeps a check due for every admitted item. finished() reads the operation result and returns IDs that are no longer pending, and the queue releases them.',
          stage: ['flow:recover'],
          source: sourceFocus(
            jobShard,
            'finished: async (ids) => {',
            "return ids.filter((_, index) => results[index]?.status !== 'pending');"
          ),
          durable: 'Recovery reads only committed rows.',
          volatile: 'Nothing from the lost hook is needed.',
          status: 'recovery',
        },
        {
          id: 'duplicate',
          title: 'Naive: a retried start runs a second job',
          description:
            'Restarting a naive job after a crash creates a new one. Here admit() passes the item ID as the operation ID, so a repeated admit() registers nothing new, and JOB_API sees the same Idempotency-Key on every retry.',
          stage: ['focus:jobs'],
          source: sourceFocus(
            jobShard,
            'items.map((item) => this.jobs.run({ id: item.id, payload: item.body }))'
          ),
          durable: 'One operation row per job ID.',
          volatile: 'The repeated admit() call.',
          status: 'recovery',
        },
      ],
    },
    {
      id: 'lost-release',
      title: 'Recover a lost release',
      description:
        'The lifecycle hook is a low-latency release path; finished() is the queue’s completion check for a release the hook missed.',
      steps: [
        {
          id: 'admitted',
          title: 'A permit is granted and the job runs',
          description:
            'AccountLimit granted the permit, the item was admitted, and jobs.run registered the operation under the item’s ID.',
          stage: ['*', 'flow:admit'],
          source: sourceFocus(
            jobShard,
            'items.map((item) => this.jobs.run({ id: item.id, payload: item.body }))'
          ),
          durable:
            'An admitted queue row and a pending operation row with the same ID.',
          volatile: 'The running attempt.',
          status: 'normal',
        },
        {
          id: 'hook-lost',
          title: 'The release is lost',
          description:
            'The attempt completes and its result commits. Assume the shard is evicted before the hook’s release transaction commits: the hook promise is gone.',
          stage: ['flow:release'],
          source: sourceFocus(
            jobShard,
            "if (finished && 'id' in event) {",
            'return this.permits.release(event.id).then(() => undefined);'
          ),
          durable:
            'The operation row is completed; the queue row is still admitted.',
          volatile: 'The hook call and its uncommitted release.',
          status: 'failure',
        },
        {
          id: 'failed-attempt',
          title: 'A final failed attempt never matches the hook',
          description:
            'When the third attempt throws, the operation settles with an attempt_settled event whose outcome is failed. This hook matches only completed attempts and terminal events, so that permit also waits for finished().',
          stage: ['focus:hook'],
          source: sourceFocus(
            jobShard,
            "event.type === 'terminal' ||",
            "(event.type === 'attempt_settled' && event.outcome === 'completed');"
          ),
          durable:
            'The operation row is failed; the queue row is still admitted.',
          volatile: 'No release was attempted.',
          status: 'gap',
        },
        {
          id: 'charged',
          title: 'AccountLimit keeps counting the permit',
          description:
            'AccountLimit still counts the permit as claimed and unreleased. A lease that is not reported within its ten-minute ttlMs is retired, not forgotten, so its footprint stays while work may still run.',
          stage: ['focus:grants'],
          source: sourceFocus(accountLimit, 'ttlMs: 10 * 60_000,'),
          durable:
            'The account’s budget stays charged until a release is reported.',
          volatile: 'Nothing frees the permit by timing out.',
          status: 'gap',
        },
        {
          id: 'wake',
          title: 'The shard alarm runs the check',
          description:
            'After admit() succeeded, the item’s check was set finishedCheckMs (60 seconds) later. That time is part of the shard alarm’s target, so a new instance created by the alarm runs the check.',
          stage: ['flow:recover'],
          source: sourceFocus(
            checkFinished,
            'const later = now + this.#finishedCheckMs;',
            'done = await this.#deadline('
          ),
          durable: 'The next check time is written before finished() runs.',
          volatile: 'A fresh queue helper with nothing in memory.',
          status: 'recovery',
        },
        {
          id: 'inspect',
          title: 'Read the stored operation result',
          description:
            'finished() calls jobs.run.getResult(id) for the due IDs and returns those whose status is not pending. not_found also counts as finished, so purging operation results before this check would release on missing evidence.',
          stage: ['focus:shard-sql'],
          source: sourceFocus(
            jobShard,
            'const results = await Promise.all(',
            "return ids.filter((_, index) => results[index]?.status !== 'pending');"
          ),
          durable: 'The operation row is the evidence.',
          volatile: 'The list of finished IDs.',
          status: 'recovery',
        },
        {
          id: 'release',
          title: 'Release and report to AccountLimit',
          description:
            'The queue calls release(id) for each returned ID: the same transaction as the hook would have run. The outbox then sends cumulative counts with sync(); counts only move forward, so a repeated report frees nothing twice.',
          stage: ['focus:limit'],
          source: sourceFocus(
            publish,
            "synced = await this.#deadline('sync', () =>",
            'this.#server.sync(key, {'
          ),
          durable:
            'The release in the shard, then the updated counts in AccountLimit.',
          volatile: 'A failed sync leaves the outbox report pending for retry.',
          status: 'recovery',
        },
      ],
    },
    {
      id: 'holder-eviction',
      title: 'Evict AccountLimit during a round',
      description:
        'What AccountLimit keeps in memory, and what each shard does when it is lost.',
      steps: [
        {
          id: 'pending',
          title: 'Requests wait in memory for a round',
          description:
            'permits() forwards to semaphore.handle(). A request is kept in an in-memory list and answered when the next round runs, at least a second later.',
          stage: ['*', 'focus:limit'],
          source: sourceFocus(
            handle,
            'return new Promise<PermitGrant>((resolve, reject) => {',
            'this.#scheduleRound();'
          ),
          durable: 'Grants and leases from earlier rounds.',
          volatile: 'The pending requests and the round timer.',
          status: 'normal',
        },
        {
          id: 'evicted',
          title: 'Eviction fails the call',
          description:
            'If AccountLimit is evicted before the round, the shard’s RPC call fails. The queue records the failure and makes the key due again after a short backoff.',
          stage: ['focus:queue'],
          source: sourceFocus(
            request,
            "'durability.semaphore_queue.request_failed',",
            'await this.#retrySoon(key, queued.length);'
          ),
          durable: 'The shard’s queued rows are unchanged.',
          volatile: 'The pending request in AccountLimit is gone.',
          status: 'failure',
        },
        {
          id: 'round-lost',
          title: 'A committed round whose reply is lost',
          description:
            'A round writes grants before it replies. If the reply never arrives, the shard does not know those grants. AccountLimit’s own alarm fires when the earliest unclaimed grant expires (10 seconds by default) and returns the unclaimed permits to the pool.',
          stage: ['flow:recover'],
          source: sourceFocus(
            reclaim,
            'if (now < grant.expires_at || grant.claimed >= grant.permits) {',
            'const updated: GrantRow = { ...grant, permits: grant.claimed };'
          ),
          durable: 'The grant rows shrink to what was claimed.',
          volatile: 'The lost reply.',
          status: 'recovery',
        },
        {
          id: 'allocate',
          title: 'The retried request joins a new round',
          description:
            'The shard asks again with the same demand and cumulative counts. The new instance allocates in one transaction from the grants and leases already stored.',
          stage: ['focus:grants'],
          source: sourceFocus(
            runRound,
            'round = await this.#engine.transaction(() =>',
            'this.#allocate(pending, limit, policies, now)'
          ),
          durable: 'The new grants commit before the reply is sent.',
          volatile: 'The round’s pending list.',
          status: 'commit',
        },
        {
          id: 'workflow-limits',
          title: 'Workflow limits are not stored',
          description:
            'limitWorkflow() writes only to an in-memory Map. A new AccountLimit instance has no workflow caps until the application sets them again; persist them if they matter.',
          stage: ['focus:limit'],
          source: sourceFocus(
            accountLimit,
            'limitWorkflow(workflowId: string, limit: number) {',
            'this.workflowLimits.set(workflowId, limit);'
          ),
          durable: 'Nothing; the Map is not written to storage.',
          volatile: 'Every workflow cap set since the instance started.',
          status: 'gap',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
