import workerSource from '../../../examples/account-concurrency/worker.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture';

const accountBudget = sourceExcerpt(
  workerSource,
  'examples/account-concurrency/worker.ts',
  'account-budget',
  'Account semaphore with strict leases',
  '  private readonly workflowLimits = new Map<string, number>();',
  '  });'
);

const operationRun = sourceExcerpt(
  workerSource,
  'examples/account-concurrency/worker.ts',
  'job-operation-run',
  'Durable job operation calls the external API',
  '      run: async ({ id, payload, signal }: DurableCall<Job>) => {',
  '      },'
);

const lifecycleRelease = sourceExcerpt(
  workerSource,
  'examples/account-concurrency/worker.ts',
  'job-lifecycle-release',
  'Best-effort lifecycle release fast path',
  '    retries: { maxAttempts: 3 },',
  '  });'
);

const queue = sourceExcerpt(
  workerSource,
  'examples/account-concurrency/worker.ts',
  'semaphore-queue',
  'Admission callback and durable completion check',
  '  private readonly permits = new DurabilitySemaphoreQueue<Job>({',
  '  });'
);

const submit = sourceExcerpt(
  workerSource,
  'examples/account-concurrency/worker.ts',
  'queue-submit',
  'Stable queue item identity, key, and group',
  '  submit(jobs: Job[]) {',
  '  }'
);

const routing = sourceExcerpt(
  workerSource,
  'examples/account-concurrency/worker.ts',
  'shard-routing',
  'Deterministic account shard routing',
  'const shardFor = (accountId: string, width = 4): string => {',
  '    return Response.json(results, { status: 202 });'
);

export const concurrencyWalkthrough: ArchitectureWalkthrough =
  validateWalkthrough({
    id: 'concurrency',
    title: 'Account-wide durable admission',
    summary:
      'A JobShard persists queued admission and reports it through the semaphore queue’s internal outbox. AccountLimit is the shared account-keyed budget; an admitted item starts one durable operation with the same stable job ID.',
    width: 900,
    height: 540,
    nodes: [
      {
        id: 'request',
        title: 'POST job array',
        kind: 'external',
        description:
          'External caller submits jobs that the worker groups by deterministic shard name.',
        href: '/primitives/routing/',
        x: 150,
        y: 80,
      },
      {
        id: 'job-shard',
        title: 'JobShard',
        kind: 'compute',
        description:
          'Compute boundary that owns one scheduler, queue, and durable job operations.',
        href: '/primitives/scheduler/',
        x: 450,
        y: 80,
      },
      {
        id: 'queue',
        title: 'Semaphore queue + outbox',
        kind: 'durable',
        description:
          'Persistent admission items and cumulative claim/release reports; retryable admit and finished checks.',
        href: '/primitives/semaphore-queue/',
        x: 750,
        y: 80,
      },
      {
        id: 'account-limit',
        title: 'AccountLimit',
        kind: 'durable',
        description:
          'Shared account-keyed semaphore authority. workflowLimits is an in-memory Map and is lost on eviction.',
        href: '/primitives/semaphore/',
        x: 750,
        y: 300,
      },
      {
        id: 'operation',
        title: 'run operation',
        kind: 'durable',
        description:
          'Retained/retried operation record using the admitted item ID.',
        href: '/primitives/operations/',
        x: 450,
        y: 300,
      },
      {
        id: 'lifecycle-hook',
        title: 'Lifecycle release hook',
        kind: 'memory',
        description:
          'Ephemeral fast path that asks the queue to release on a completed or terminal event.',
        href: '/reference/lifecycle/',
        x: 150,
        y: 300,
      },
      {
        id: 'job-api',
        title: 'JOB_API',
        kind: 'external',
        description:
          'External process must honor the stable HTTP idempotency key.',
        href: '/primitives/operations/',
        x: 450,
        y: 480,
      },
    ],
    edges: [
      {
        id: 'routes',
        from: 'request',
        to: 'job-shard',
        label: 'shardFor(accountId)',
      },
      {
        id: 'enqueues',
        from: 'job-shard',
        to: 'queue',
        label: 'stable id, account key, workflow group',
      },
      {
        id: 'requests-budget',
        from: 'queue',
        to: 'account-limit',
        label: 'rounds and cumulative reports',
      },
      {
        id: 'admits',
        from: 'queue',
        to: 'operation',
        label: 'admit callback starts item.id',
      },
      {
        id: 'calls-api',
        from: 'operation',
        to: 'job-api',
        label: 'Idempotency-Key: id',
      },
      {
        id: 'fast-release',
        from: 'operation',
        to: 'lifecycle-hook',
        label: 'completed or terminal lifecycle',
      },
      {
        id: 'releases',
        from: 'lifecycle-hook',
        to: 'queue',
        label: 'release(id) fast path',
      },
      {
        id: 'checks-finished',
        from: 'queue',
        to: 'operation',
        label: 'finished() getResult(id)',
      },
    ],
    excerpts: [
      accountBudget,
      operationRun,
      lifecycleRelease,
      queue,
      submit,
      routing,
    ],
    scenarios: [
      {
        id: 'admission',
        title: 'Admission with one stable job identity',
        description:
          'The account budget controls admission across queues; it does not turn the remote API into a universally bounded process.',
        steps: [
          {
            id: 'stable-shard',
            title: 'Route each account consistently',
            description:
              'The demo’s shardFor(accountId, 4) chooses one stable shard name for an account; it does not spread that account’s jobs across four shards.',
            nodes: ['request', 'job-shard'],
            edges: ['routes'],
            source: sourceFocus(
              routing,
              '      const shard = shardFor(job.accountId);',
              '      byShard.set(shard, [...(byShard.get(shard) ?? []), job]);'
            ),
            durable: 'No admission state changes during grouping.',
            volatile:
              'The request-local byShard Map exists only while this fetch runs.',
            status: 'normal',
          },
          {
            id: 'queue-item',
            title: 'Persist demand with account and workflow dimensions',
            description:
              'Each queue item carries the stable job ID, account key, workflow group, and job body.',
            nodes: ['job-shard', 'queue'],
            edges: ['enqueues', 'requests-budget'],
            source: sourceFocus(
              submit,
              '      jobs.map((job) => ({',
              '      }))'
            ),
            durable:
              'The semaphore queue persists admission state and its internal outbox makes cumulative reports durable.',
            volatile:
              'Blocked diagnostics and request-in-flight details are advisory runtime state.',
            status: 'commit',
          },
          {
            id: 'account-round',
            title: 'Allocate from the shared account budget',
            description:
              'AccountLimit uses ACCOUNT_CONCURRENCY with strict lease provisioning and optional workflow group limits. ttlMs is reporting lifetime, not permission to erase a running footprint; strict accounting keeps grants plus lease footprint under the limit.',
            nodes: ['queue', 'account-limit'],
            edges: ['requests-budget'],
            source: sourceFocus(
              accountBudget,
              '    limit: () => Number(this.env.ACCOUNT_CONCURRENCY),',
              '    },'
            ),
            durable:
              'The semaphore is the durable, shared authority for an account key.',
            volatile:
              'workflowLimits is a local Map, so administrative workflow limits vanish on AccountLimit eviction unless an application persists them.',
            status: 'commit',
          },
          {
            id: 'start-same-operation',
            title: 'Admit without creating another job',
            description:
              'The retryable admit callback invokes jobs.run with item.id. If the callback is retried, it targets the same durable operation rather than a new job.',
            nodes: ['queue', 'operation'],
            edges: ['admits'],
            source: sourceFocus(
              queue,
              '        items.map((item) => this.jobs.run({ id: item.id, payload: item.body }))'
            ),
            durable:
              'The queue item ID and operation ID are the same stable logical job identity.',
            volatile:
              'The callback invocation can be repeated after an interruption.',
            status: 'commit',
          },
          {
            id: 'idempotent-external-call',
            title: 'Call the API, then release quickly',
            description:
              'The operation passes its ID as the JOB_API idempotency key. A completed or terminal lifecycle event releases the permit on the fast path; this admission limit is not a universal bound on an external process that ignores cancellation.',
            nodes: ['operation', 'job-api', 'lifecycle-hook', 'queue'],
            edges: ['calls-api', 'fast-release', 'releases'],
            source: sourceFocus(
              operationRun,
              "          headers: { 'Idempotency-Key': id },",
              '          signal,'
            ),
            durable:
              'The operation record retains retries and its terminal outcome; the API must separately honor its idempotency contract.',
            volatile:
              'The abort signal and lifecycle callback do not prove that an abort-ignoring external process stopped.',
            status: 'normal',
          },
        ],
      },
      {
        id: 'lost-release',
        title: 'Recover a lost release',
        description:
          'The lifecycle hook is a low-latency release path, while finished() is the queue’s completion probe for a missed hook.',
        steps: [
          {
            id: 'hook-interrupted',
            title: 'A terminal event reaches the fast path',
            description:
              'The source attempts release for a terminal event or a completed attempt. An eviction before that release commits can lose this particular hook invocation.',
            nodes: ['operation', 'lifecycle-hook', 'queue'],
            edges: ['fast-release', 'releases'],
            source: sourceFocus(
              lifecycleRelease,
              "      if (finished && 'id' in event) {",
              '      }'
            ),
            durable:
              'The operation outcome and admitted queue item remain durable.',
            volatile:
              'The lifecycle callback and an uncommitted release call are best-effort.',
            status: 'failure',
          },
          {
            id: 'admission-remains-charged',
            title: 'Keep the running footprint visible',
            description:
              'Missing the fast release does not imply that TTL or object eviction erases the admitted item’s footprint. The queue still has a durable item to examine.',
            nodes: ['queue', 'account-limit'],
            edges: ['requests-budget'],
            source: sourceFocus(
              queue,
              '    // The lifecycle hook above is best-effort; this returns any permit it missed.',
              '    finished: async (ids) => {'
            ),
            durable:
              'Queue admission/outbox state remains available for the primitive’s recovery protocol.',
            volatile:
              'A lifecycle notification can be absent even though the operation has finished.',
            status: 'gap',
          },
          {
            id: 'inspect-authoritative-result',
            title: 'Check the retained operation result',
            description:
              'finished() reads jobs.run.getResult(id) for admitted IDs and reports only results whose status is not pending. This is the source-provided recovery signal for a missed release.',
            nodes: ['queue', 'operation'],
            edges: ['checks-finished'],
            source: sourceFocus(
              queue,
              '      const results = await Promise.all(',
              "      return ids.filter((_, index) => results[index]?.status !== 'pending');"
            ),
            durable:
              'The retained operation outcome is the evidence used by queue recovery.',
            volatile:
              'The predicate also treats not_found as finished. Purging before reconciliation can therefore cause a false completion decision; retain authoritative evidence deliberately.',
            status: 'recovery',
          },
          {
            id: 'queue-reclaims',
            title: 'Let the queue recover the permit',
            description:
              'The example supplies the non-pending IDs to DurabilitySemaphoreQueue; its documented completion protocol reclaims the permit. No extra application reconciliation is implemented in this worker.',
            nodes: ['queue', 'account-limit'],
            edges: ['requests-budget'],
            source: sourceFocus(
              queue,
              "      return ids.filter((_, index) => results[index]?.status !== 'pending');"
            ),
            durable:
              'Cumulative queue reports communicate recovered release accounting to the holder.',
            volatile:
              'Recovery timing is scheduler-driven and is not an immediate external-process stop signal.',
            status: 'recovery',
          },
        ],
      },
    ],
  } satisfies ArchitectureWalkthrough);
