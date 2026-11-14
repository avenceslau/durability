import indexSource from '../../../templates/fifo-queue/src/index.ts?raw';
import layoutSource from '../../../templates/fifo-queue/src/layout.ts?raw';
import limiterSource from '../../../templates/fifo-queue/src/limiter.ts?raw';
import orchestratorSource from '../../../templates/fifo-queue/src/orchestrator.ts?raw';
import partitionSource from '../../../templates/fifo-queue/src/partition.ts?raw';
import pullConsumerSource from '../../../templates/fifo-queue/src/pull-consumer.ts?raw';
import redriverSource from '../../../templates/fifo-queue/src/redriver.ts?raw';
import scalingSource from '../../../templates/fifo-queue/src/scaling.ts?raw';
import sendSource from '../../../templates/fifo-queue/src/send.ts?raw';
import targetsSource from '../../../templates/fifo-queue/src/targets.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const indexFile = 'templates/fifo-queue/src/index.ts';
const layoutFile = 'templates/fifo-queue/src/layout.ts';
const limiterFile = 'templates/fifo-queue/src/limiter.ts';
const orchestratorFile = 'templates/fifo-queue/src/orchestrator.ts';
const partitionFile = 'templates/fifo-queue/src/partition.ts';
const pullConsumerFile = 'templates/fifo-queue/src/pull-consumer.ts';
const redriverFile = 'templates/fifo-queue/src/redriver.ts';
const scalingFile = 'templates/fifo-queue/src/scaling.ts';
const sendFile = 'templates/fifo-queue/src/send.ts';
const targetsFile = 'templates/fifo-queue/src/targets.ts';

const accept = sourceExcerpt(
  indexSource,
  indexFile,
  'accept',
  'Answer a producer',
  'const accept = async (queue: string, request: Request): Promise<Response> => {',
  '  return Response.json(outcome, { status });\n};'
);
const layoutOf = sourceExcerpt(
  sendSource,
  sendFile,
  'layout-of',
  'Read the partition list',
  'const layoutOf = async (queue: string): Promise<Layout> => {',
  '  return published;\n};'
);
const groupByPartition = sourceExcerpt(
  sendSource,
  sendFile,
  'group-by-partition',
  'Hash keys to partitions',
  'const groupByPartition = (',
  '  return [...groups.values()];\n};'
);
const send = sourceExcerpt(
  sendSource,
  sendFile,
  'send',
  'Send, following a resize',
  'export const send = async (',
  '  return outcome;\n};'
);
const append = sourceExcerpt(
  partitionSource,
  partitionFile,
  'append',
  'Accept a share of a send',
  '  async append(input: AppendInput): Promise<AppendResult> {',
  '    await this.stageSample();\n    return result;\n  }'
);
const stopAccepting = sourceExcerpt(
  partitionSource,
  partitionFile,
  'stop-accepting',
  'Stop accepting for a resize',
  '  async stopAccepting(',
  '    return sample;\n  }'
);
const deliverNext = sourceExcerpt(
  partitionSource,
  partitionFile,
  'deliver-next',
  'Decide a target’s next batch',
  '  private async deliverNext(',
  "    await this.deliverLease(identity, name, target, lease);\n    return 'more';\n  }"
);
const deliverLease = sourceExcerpt(
  partitionSource,
  partitionFile,
  'deliver-lease',
  'Deliver one batch and settle it',
  '  private async deliverLease(',
  '    this.ctx.storage.kv.put(`retry:${name}`, Date.now() + delay);\n  }'
);
const deadLetter = sourceExcerpt(
  partitionSource,
  partitionFile,
  'dead-letter',
  'Write a dead letter',
  '  private async deadLetter(',
  '      lastError: error,\n    });\n  }'
);
const holdPermit = sourceExcerpt(
  partitionSource,
  partitionFile,
  'hold-permit',
  'Hold or ask for a permit',
  '  private async holdPermit(name: string, limiter: string): Promise<boolean> {',
  '    return false;\n  }'
);
const sample = sourceExcerpt(
  partitionSource,
  partitionFile,
  'sample',
  'Report positions',
  '  private async sample(identity: PartitionIdentity): Promise<PartitionSample> {',
  '    };\n  }'
);
const post = sourceExcerpt(
  targetsSource,
  targetsFile,
  'post',
  'POST a batch to a target',
  'const post = async (',
  '  };\n};'
);
const limiterFor = sourceExcerpt(
  layoutSource,
  layoutFile,
  'limiter-for',
  'Choose a limiter',
  'export const limiterFor = (',
  '  return chosen;\n};'
);
const limiter = sourceExcerpt(
  limiterSource,
  limiterFile,
  'limiter',
  'Limiter Durable Object',
  'export class Limiter extends DurableObject<Cloudflare.Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const startResize = sourceExcerpt(
  orchestratorSource,
  orchestratorFile,
  'start-resize',
  'Begin a resize',
  '  private async startResize(count: number): Promise<void> {',
  '    await this.finishResize();\n  }'
);
const finishResize = sourceExcerpt(
  orchestratorSource,
  orchestratorFile,
  'finish-resize',
  'Stop the old partitions, publish the new',
  '  private async finishResize(): Promise<void> {',
  '    await this.advanceEpochs();\n  }'
);
const drained = sourceExcerpt(
  orchestratorSource,
  orchestratorFile,
  'drained',
  'Has an epoch nothing left for a target?',
  '  private drained(target: string, layout: Layout): boolean {',
  '    );\n  }'
);
const advanceEpochs = sourceExcerpt(
  orchestratorSource,
  orchestratorFile,
  'advance-epochs',
  'Move targets to the next epoch',
  '  private async advanceEpochs(): Promise<void> {',
  "      `Epoch ${dropped.map((layout) => layout.epoch).join(', ')} drained`\n    );\n  }"
);
const report = sourceExcerpt(
  orchestratorSource,
  orchestratorFile,
  'report',
  'Receive a partition’s sample',
  '  async report(samples: PartitionSample[]): Promise<void> {',
  '      await this.alarms.tick(Date.now() + tickMs);\n    }\n  }'
);
const tick = sourceExcerpt(
  orchestratorSource,
  orchestratorFile,
  'tick',
  'One control-plane tick',
  '  private async tick(): Promise<void> {',
  '      await this.alarms.tick(Date.now() + tickMs);\n    }\n  }'
);
const balanceLimiters = sourceExcerpt(
  orchestratorSource,
  orchestratorFile,
  'balance-limiters',
  'Keep limiters and shares in line',
  '  private async balanceLimiters(): Promise<LimiterSample[]> {',
  '    return samples;\n  }'
);
const deadLetterWithoutTarget = sourceExcerpt(
  partitionSource,
  partitionFile,
  'dead-letter-without-target',
  'Dead-letter when there is no target',
  '  private async deadLetterWithoutTarget(): Promise<',
  "    return 'more';\n  }"
);
const expirePullLog = sourceExcerpt(
  partitionSource,
  partitionFile,
  'expire-pull-log',
  'Delete batches past their retention',
  '  private async expirePullLog(): Promise<number | undefined> {',
  '    return undefined;\n  }'
);
const syncPullTarget = sourceExcerpt(
  orchestratorSource,
  orchestratorFile,
  'sync-pull-target',
  'The queue’s own pull target',
  '  private syncPullTarget(): void {',
  '    });\n  }'
);
const writeToPullLog = sourceExcerpt(
  targetsSource,
  targetsFile,
  'write-to-pull-log',
  'Write a batch to the pull bucket',
  'const writeToPullLog = async (',
  '  return { ok: true };\n};'
);
const pull = sourceExcerpt(
  pullConsumerSource,
  pullConsumerFile,
  'pull',
  'Hand out the next messages',
  '  async pull(',
  '    return undefined;\n  }'
);
const acknowledge = sourceExcerpt(
  pullConsumerSource,
  pullConsumerFile,
  'acknowledge',
  'Move past acknowledged messages',
  '  ack(lease: string): boolean {',
  '    );\n  }'
);
const discover = sourceExcerpt(
  pullConsumerSource,
  pullConsumerFile,
  'discover',
  'Find the epoch and partitions to read',
  '  private async discover(queue: string): Promise<void> {',
  '        partition\n      );\n    }\n  }'
);
const readPartition = sourceExcerpt(
  pullConsumerSource,
  pullConsumerFile,
  'read-partition',
  'Read one partition’s next range',
  '  private async read(',
  '    return batch;\n  }'
);
const startRedrive = sourceExcerpt(
  redriverSource,
  redriverFile,
  'start-redrive',
  'Start a redrive',
  '  async start(queue: string, target?: string): Promise<RedriveStatus> {',
  '    return statusOf(job);\n  }'
);
const replayPage = sourceExcerpt(
  redriverSource,
  redriverFile,
  'replay-page',
  'Replay one page of dead letters',
  '  private async replayPage(job: Job): Promise<void> {',
  "    delete job.lastError;\n    this.ctx.storage.kv.put('job', job);\n  }"
);
const replayEntry = sourceExcerpt(
  redriverSource,
  redriverFile,
  'replay-entry',
  'Send one dead letter, then delete it',
  '  private async replayEntry(',
  '    return { redriven: entry.messages.length, left: 0 };\n  }'
);
const planPartitions = sourceExcerpt(
  scalingSource,
  scalingFile,
  'plan-partitions',
  'Decide the partition count',
  'export const planPartitions = (load: PartitionLoad): number | undefined => {',
  '  return undefined;\n};'
);
const planLimiters = sourceExcerpt(
  scalingSource,
  scalingFile,
  'plan-limiters',
  'Decide the limiter count',
  'export const planLimiters = (load: LimiterLoad): number => {',
  '  return load.current;\n};'
);
const planShares = sourceExcerpt(
  scalingSource,
  scalingFile,
  'plan-shares',
  'Split the limit between limiters',
  'export const planShares = (input: {',
  '    : { ...state, changed };\n};'
);

export const walkthrough = validateWalkthrough({
  id: 'fifo-queue',
  title: 'How the queue uses its Durable Objects',
  summary:
    'A Worker hashes each key to a Partition object, an ordered log that hands every target its batches in offset order. One Orchestrator per queue owns the partition list and the limiters and never sees a message. Step through a send, a delivery, a redrive, pull consumers, a resize that keeps order, a shared concurrency limit, and the metrics.',
  diagram: {
    canvas: { width: 1000, height: 900 },
    direction: 'down',
    routing: 'auto',
    flows: {
      send: { label: 'accept messages', color: 'blue' },
      deliver: { label: 'deliver batches', color: 'orange' },
      control: { label: 'configure and observe', color: 'purple' },
      redrive: { label: 'replay dead letters', color: 'green' },
      pull: { label: 'pull messages', color: 'blue' },
    },
    nodes: {
      producer: {
        rank: 0,
        row: 0,
        label: 'Producer',
        sublabel: 'POST messages',
        size: [225, 72],
        icon: 'user',
        tone: 'external',
      },
      dashboard: {
        rank: 0,
        row: 2,
        label: 'Dashboard',
        sublabel: 'WebSocket',
        size: [215, 72],
        icon: 'browser',
        tone: 'external',
      },
      worker: {
        rank: 1,
        row: 0,
        label: 'Worker',
        sublabel: 'send()',
        icon: 'workers',
      },
      kv: {
        rank: 1,
        row: 1,
        label: 'TOPOLOGY',
        sublabel: 'KV partition list',
        size: [245, 72],
        icon: 'kv',
        tone: 'external',
      },
      orchestrator: {
        rank: 1,
        row: 2,
        label: 'Orchestrator',
        sublabel: 'one per queue',
        size: [240, 72],
        icon: 'durable-objects',
      },
      log: {
        rank: 3,
        row: 1,
        label: 'Message log',
        sublabel: 'ctx.storage.sql',
        size: [230, 72],
        icon: 'database',
      },
      partition: {
        rank: 2,
        row: 1,
        label: 'Partition',
        sublabel: 'queue/epoch/index',
        size: [250, 72],
        icon: 'durable-objects',
      },
      limiter: {
        rank: 2,
        row: 2,
        label: 'Limiter',
        sublabel: 'share of the limit',
        size: [245, 72],
        icon: 'durable-objects',
      },
      storage: {
        rank: 3,
        row: 2,
        label: 'STORAGE',
        sublabel: 'R2 dead letters',
        size: [230, 72],
        icon: 'r2',
        tone: 'external',
      },
      redriver: {
        rank: 4,
        row: 2,
        label: 'Redriver',
        sublabel: 'one per queue',
        size: [230, 72],
        icon: 'durable-objects',
      },
      'pull-bucket': {
        rank: 3,
        row: 0,
        label: 'PULL',
        sublabel: 'R2 messages to pull',
        size: [250, 72],
        icon: 'r2',
        tone: 'external',
      },
      'pull-consumer': {
        rank: 4,
        row: 0,
        label: 'PullConsumer',
        sublabel: 'one per consumer',
        size: [250, 72],
        icon: 'durable-objects',
      },
      consumer: {
        rank: 4,
        row: 1,
        label: 'Pull consumer',
        sublabel: 'pull · ack',
        size: [230, 72],
        icon: 'user',
        tone: 'external',
      },
      target: {
        rank: 2,
        row: 0,
        label: 'Target',
        sublabel: 'webhook · service',
        size: [245, 72],
        icon: 'browser',
        tone: 'external',
      },
    },
    edges: [
      { from: 'producer', to: 'worker', label: 'POST', flow: 'send' },
      { from: 'worker', to: 'kv', label: 'read list', flow: 'send' },
      { from: 'worker', to: 'partition', label: 'append()', flow: 'send' },
      {
        from: 'partition',
        to: 'log',
        label: 'append · lease',
        flow: 'send',
      },
      { from: 'partition', to: 'limiter', label: 'permit', flow: 'deliver' },
      { from: 'partition', to: 'target', label: 'batch', flow: 'deliver' },
      {
        from: 'partition',
        to: 'storage',
        label: 'dead letter',
        flow: 'deliver',
      },
      {
        from: 'storage',
        to: 'redriver',
        label: 'read · delete',
        flow: 'redrive',
        both: true,
      },
      { from: 'redriver', to: 'partition', label: 'replay', flow: 'redrive' },
      {
        from: 'partition',
        to: 'pull-bucket',
        label: 'every batch',
        flow: 'pull',
      },
      {
        from: 'pull-consumer',
        to: 'pull-bucket',
        label: 'list · read',
        flow: 'pull',
      },
      {
        from: 'consumer',
        to: 'pull-consumer',
        label: 'pull · ack',
        flow: 'pull',
      },
      { from: 'orchestrator', to: 'kv', label: 'publish', flow: 'control' },
      {
        from: 'orchestrator',
        to: 'partition',
        label: 'config · samples',
        flow: 'control',
        both: true,
      },
      {
        from: 'orchestrator',
        to: 'limiter',
        label: 'shares',
        flow: 'control',
      },
      {
        from: 'dashboard',
        to: 'orchestrator',
        label: 'points',
        flow: 'control',
        both: true,
      },
    ],
    groups: [
      {
        id: 'partition-object',
        label: 'Partition · N per queue',
        contains: ['log', 'partition'],
      },
    ],
  },
  details: {
    producer: {
      description:
        'Anything that sends: an HTTP client with the producer token, or another Worker bound to the QueueBinding entrypoint. It gets 202 once every message is stored, 429 when a target is too far behind, and an uncertain 5xx otherwise.',
      href: '/primitives/routing/',
      source: 'accept',
    },
    dashboard: {
      description:
        'A browser connected to the Orchestrator over one WebSocket. It receives a point of cumulative counters every two seconds while the queue is busy and computes rates itself.',
      href: '/primitives/socket/',
      source: 'tick',
    },
    worker: {
      description:
        'Stateless. It reads the queue’s partition list, hashes each key, and calls one Partition per group of messages. It never calls the Orchestrator.',
      href: '/primitives/routing/',
      source: 'send',
    },
    kv: {
      description:
        'The published partition list, one entry per queue, with no expiry. Only the Orchestrator writes it, and only when the partitions change. Workers cache it in memory for about 30 seconds.',
      href: '/primitives/topology/',
      source: 'layout-of',
    },
    orchestrator: {
      description:
        'One object per queue. It stores the settings, the targets, the live epochs, each partition’s latest sample, and the points the dashboard draws. It pushes configuration to partitions and shares to limiters, and decides resizes. No message passes through it.',
      href: '/primitives/topology/',
      source: 'tick',
    },
    log: {
      description:
        'The partition’s SQLite: messages by offset, one position per target, and the range each target has in flight. Messages stay until retention removes them (4 days or 512 MB), whatever the positions are.',
      href: '/primitives/log/',
      source: 'deliver-next',
    },
    partition: {
      description:
        'One object per queue, epoch, and index. It accepts messages for the keys that hash to it and delivers them to every target in offset order, one batch per target at a time.',
      href: '/primitives/log/',
      source: 'append',
    },
    limiter: {
      description:
        'Holds a share of the queue’s concurrency limit and hands out permits. A queue without a limit has no limiters; a queue with one starts with a single limiter and gains more as permit requests grow.',
      href: '/primitives/semaphore/',
      source: 'limiter',
    },
    storage: {
      description:
        'The R2 bucket. A batch a target gave up on is written under dead-letters/<queue>/<target>/ and never overwritten; an archive target writes its batches under archive/.',
      href: '/reference/guarantees/',
      source: 'dead-letter',
    },
    'pull-bucket': {
      description:
        'A second R2 bucket. A queue with pull consumers enabled has a target of its own that writes every batch here, keyed by partition and offset. Each partition deletes its batches when their retention, up to 50 days, ends.',
      href: '/reference/guarantees/',
      source: 'write-to-pull-log',
    },
    'pull-consumer': {
      description:
        'One object per consumer of a queue. It reads batches from the pull bucket and stores how far the consumer got in each partition and which range it has been handed. Pulling never reaches a partition.',
      href: '/reference/guarantees/',
      source: 'pull',
    },
    consumer: {
      description:
        'Anything that asks for messages instead of being called: an HTTP client with the consumer token, or a Worker using the queue binding. It acknowledges each batch by its lease, or the batch is handed out again.',
      href: '/reference/guarantees/',
      source: 'pull',
    },
    redriver: {
      description:
        'One object per queue that replays its dead letters. A redrive is a job it works through one page per alarm run, so a large set takes nothing from the partitions’ delivery or from the Orchestrator. It sends through the same path as the Worker.',
      href: '/primitives/alarms/',
      source: 'start-redrive',
    },
    target: {
      description:
        'A destination that receives every message of the queue: a webhook, a service binding, another queue, or the R2 archive. A 2xx answer acknowledges the batch. Delivery is at least once, so the receiver deduplicates on the Idempotency-Key header.',
      href: '/reference/guarantees/',
      source: 'post',
    },
  },
  excerpts: [
    accept,
    layoutOf,
    groupByPartition,
    send,
    append,
    stopAccepting,
    deliverNext,
    deliverLease,
    deadLetter,
    holdPermit,
    sample,
    post,
    limiterFor,
    limiter,
    startResize,
    finishResize,
    drained,
    advanceEpochs,
    report,
    tick,
    balanceLimiters,
    deadLetterWithoutTarget,
    expirePullLog,
    syncPullTarget,
    writeToPullLog,
    pull,
    acknowledge,
    discover,
    readPartition,
    startRedrive,
    replayPage,
    replayEntry,
    planPartitions,
    planLimiters,
    planShares,
  ],
  scenarios: [
    {
      id: 'send',
      title: 'Accept a message',
      description:
        'Follow one POST from a producer into a partition’s log. Accepting is separate from delivering.',
      steps: [
        {
          id: 'list',
          title: 'Read the partition list',
          description:
            'The Worker needs to know how many partitions the queue has now. It reads the list the Orchestrator published to KV, through a client that caches it in the isolate.',
          stage: ['*', 'focus:kv'],
          source: sourceFocus(
            layoutOf,
            '({ members } = await topology.get(queue));'
          ),
          durable:
            'The list in KV. It has no expiry and changes only on a resize.',
          volatile: 'The isolate’s cached copy, refreshed about every 30 s.',
          status: 'normal',
        },
        {
          id: 'hash',
          title: 'Hash each key to a partition',
          description:
            'A key always hashes to the same partition of an epoch, which is what puts messages of one key into one ordered log. The Worker groups the messages by partition and keeps their order within each group.',
          stage: ['focus:worker'],
          source: sourceFocus(
            groupByPartition,
            'const identity = partitionFor(queue, layout, message.key);',
            'groups.set(identity.index, group);'
          ),
          durable: 'Nothing is written while grouping.',
          volatile: 'The groups exist only in this request.',
          status: 'normal',
        },
        {
          id: 'refuse',
          title: 'Refuse rather than drop',
          description:
            'Retention removes old messages whether or not a target has received them. So a partition refuses new messages once a running target is maxBacklog behind, and the producer sees 429 instead of a later silent loss.',
          stage: ['focus:partition'],
          source: sourceFocus(
            append,
            'if (await this.overBacklog()) {',
            "name: 'Backpressure',"
          ),
          durable: 'The count of rejected messages.',
          volatile: 'Nothing.',
          status: 'normal',
        },
        {
          id: 'append',
          title: 'Append the group in one transaction',
          description:
            'The partition appends its group to the log, which gives each message the next offset. The whole group commits or none of it does. A message id already in the log returns its first offset, so a retried send is stored once.',
          stage: ['focus:log'],
          source: sourceFocus(
            append,
            'const result = await this.log.append(',
            'deduplicationKey: message.id,'
          ),
          durable: 'The messages and their offsets.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'wake',
          title: 'Ask for a delivery run',
          description:
            'Accepting does not deliver. The partition schedules its delivery alarm, unless a run is already scheduled or in progress, and returns.',
          stage: ['focus:partition'],
          source: sourceFocus(append, 'await this.requestDelivery();'),
          durable: 'The scheduled delivery alarm.',
          volatile:
            'Whether a run is in progress, which decides if a new alarm is needed.',
          status: 'commit',
        },
        {
          id: 'answer',
          title: 'Answer for every partition',
          description:
            'Each partition accepted or rejected its group on its own, so one POST can be partly accepted; the response lists the ids either way. A rejection is definite. A thrown call is not: the group may have been stored, and a retry must reuse the ids.',
          stage: ['focus:producer'],
          source: sourceFocus(
            accept,
            'const status = outcome.rejected.length === 0 ? 202 : backpressure ? 429 : 503;'
          ),
          durable: 'Whatever each partition stored.',
          volatile: 'The outcome, known only to this request.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'deliver',
      title: 'Deliver to every target in order',
      description:
        'One delivery run of a partition. Each target is advanced on its own, one batch at a time, so a slow or failing target holds back only itself.',
      steps: [
        {
          id: 'gate',
          title: 'Check that the target may run',
          description:
            'A run advances every target concurrently. A target is skipped while it is paused, and while it is still working through an older epoch of the queue: that second rule is what keeps order across a resize.',
          stage: ['*', 'focus:partition'],
          source: sourceFocus(
            deliverNext,
            'target.paused ||',
            'target.deliverFromEpoch !== identity.epoch ||'
          ),
          durable: 'The configuration the Orchestrator last pushed.',
          volatile: 'Nothing.',
          status: 'normal',
        },
        {
          id: 'permit',
          title: 'Take a permit if the queue has a limit',
          description:
            'With maxConcurrency set, the target needs a permit from the partition’s limiter before it delivers. If none is free, the target stops here and the limiter’s answer starts a new run.',
          stage: ['focus:limiter'],
          source: sourceFocus(
            deliverNext,
            'const limiter = limiterFor(partitionName(identity), config.limiters);',
            '} else if (!(await this.holdPermit(name, limiter))) {'
          ),
          durable: 'The request for a permit, and the permit once granted.',
          volatile: 'How long the permit has been held.',
          status: 'normal',
        },
        {
          id: 'lease',
          title: 'Lease the next range of offsets',
          description:
            'The target takes the messages after its position, up to batchSize. A target holds one range at a time, so nothing after this batch is delivered to it until this batch is settled.',
          stage: ['focus:log'],
          source: sourceFocus(
            deliverNext,
            'lease = await this.log.lease(name, target.batchSize);'
          ),
          durable: 'The leased range and its attempt number.',
          volatile: 'The batch in this run’s memory.',
          status: 'commit',
        },
        {
          id: 'post',
          title: 'Hand the batch to the target',
          description:
            'The batch is POSTed as JSON with a key that is the same on every redelivery of this batch to this target, and a signature when the target has a secret.',
          stage: ['focus:target'],
          source: sourceFocus(
            post,
            "'Idempotency-Key': `${delivery.target}/${batchKey(delivery)}`,",
            'signal: AbortSignal.timeout(timeoutMs),'
          ),
          durable: 'Nothing changes in the partition while the call runs.',
          volatile: 'The call, bounded by the target’s timeout.',
          status: 'normal',
        },
        {
          id: 'ack',
          title: 'Move the target’s position',
          description:
            'A 2xx answer acknowledges the batch: the target’s position moves past it and the loop takes the next range. Other targets have their own positions and are not affected.',
          stage: ['focus:log'],
          source: sourceFocus(
            deliverLease,
            'if (outcome.ok) {',
            'await this.log.ack(name, lease.batchId);'
          ),
          durable: 'The target’s position.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'retry',
          title: 'A failed batch waits, and so does what follows it',
          description:
            'Any other answer returns the range and stores when to try again. The same batch is delivered next, with a higher attempt number: later messages of this partition wait behind it for this target, which is the price of order.',
          stage: ['focus:partition'],
          source: sourceFocus(
            deliverLease,
            'await this.log.nack(name, lease.batchId);',
            'this.ctx.storage.kv.put(`retry:${name}`, Date.now() + delay);'
          ),
          durable: 'The returned range and the time of the next attempt.',
          volatile: 'Nothing.',
          status: 'failure',
        },
        {
          id: 'dead-letter',
          title: 'Give up into R2, then move on',
          description:
            'After maxAttempts the batch is written to R2 and only then acknowledged, so the target moves on. Order no longer covers those messages; a redrive sends them through the queue again for this target only.',
          stage: ['focus:storage'],
          source: sourceFocus(
            deadLetter,
            'await env.STORAGE.put(',
            "{ onlyIf: { etagDoesNotMatch: '*' } }"
          ),
          durable: 'The dead letter, then the moved position.',
          volatile: 'Nothing.',
          status: 'recovery',
        },
        {
          id: 'no-target',
          title: 'A queue without targets dead-letters at once',
          description:
            'With no target there is nobody to deliver to, and messages left in the log would only wait for retention to remove them. The partition writes them straight to the dead letters; a redrive delivers them to every target once the queue has one.',
          stage: ['focus:storage'],
          source: sourceFocus(
            deadLetterWithoutTarget,
            'const lease = await this.log.lease(noTargetName, deadLetterBatchSize);',
            "'The queue has no targets'"
          ),
          durable: 'The dead letters, and the position past them.',
          volatile: 'Nothing.',
          status: 'normal',
        },
        {
          id: 'crash',
          title: 'A crash mid-batch delivers it again',
          description:
            'If the object is evicted while a call is in flight, the range stays leased until the lease expires, 60 seconds later, and is then delivered again. The target may already have processed it, so only the receiver can avoid a second effect.',
          stage: ['focus:target'],
          source: sourceFocus(
            deliverNext,
            '// A range leased before a restart is still held until it expires.',
            'return now + 1_000;'
          ),
          durable: 'The leased range; the position has not moved.',
          volatile: 'The interrupted call and its answer.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'redrive',
      title: 'Replay dead letters',
      description:
        'A redrive sends dead letters through the queue again. It runs in its own object, as a job, so its size costs the partitions and the Orchestrator nothing.',
      steps: [
        {
          id: 'start',
          title: 'A redrive is a job, not a request',
          description:
            'The call from the binding or the admin API reaches the queue’s Redriver, which stores the job, schedules its alarm, and answers at once. One redrive runs at a time; a call during a run reports that run.',
          stage: ['*', 'focus:redriver'],
          source: sourceFocus(
            startRedrive,
            "this.ctx.storage.kv.put('job', job);",
            'await this.alarms.replay(Date.now());'
          ),
          durable: 'The job: its targets, its counters, and the alarm.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'page',
          title: 'One page of dead letters per alarm run',
          description:
            'Each run lists up to 100 dead letters of one target, continuing after the last one it handled, and then schedules the next run. No single invocation has to hold the whole set, so the size of a redrive is not bound by one request’s limits.',
          stage: ['focus:storage'],
          source: sourceFocus(
            replayPage,
            'const page = await env.STORAGE.list({',
            '...(job.after === undefined ? {} : { startAfter: job.after }),'
          ),
          durable: 'The last dead letter handled.',
          volatile: 'The page being worked through.',
          status: 'normal',
        },
        {
          id: 'entry',
          title: 'Send through the queue, for one target',
          description:
            'The Redriver sends the batch’s messages the way the Worker does: each key is hashed to a partition of the current epoch. The messages are marked for the target that gave up on them, and every other target skips them.',
          stage: ['focus:partition'],
          source: sourceFocus(
            replayEntry,
            'const outcome = await send(',
            '[target]'
          ),
          durable: 'The messages, appended as new ones.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'delete',
          title: 'Delete only what was accepted',
          description:
            'A dead letter is deleted after the queue accepted its messages. If the queue refused them, for example under backpressure, it stays and is counted as left for the next redrive.',
          stage: ['focus:storage'],
          source: sourceFocus(
            replayEntry,
            'if (outcome.rejected.length > 0) {',
            'await env.STORAGE.delete(key);'
          ),
          durable: 'The dead letter is gone, or still there.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'later',
          title: 'Dead letters written during the run wait',
          description:
            'A redriven batch that fails again becomes a new dead letter. The run handles only those written before it started; otherwise a target that keeps failing would make it replay its own output without end.',
          stage: ['focus:redriver'],
          source: sourceFocus(
            replayPage,
            'if (object.uploaded.getTime() < job.startedAt) {'
          ),
          durable: 'When the job started.',
          volatile: 'Nothing.',
          status: 'normal',
        },
        {
          id: 'crash',
          title: 'A crash repeats at most one entry',
          description:
            'Progress is stored after every dead letter. An eviction between sending and deleting sends that one batch again, with the same message ids, which the partition that accepted them accepts once.',
          stage: ['focus:redriver'],
          source: sourceFocus(
            replayPage,
            'job.after = object.key;',
            "this.ctx.storage.kv.put('job', job);"
          ),
          durable: 'The job and how far it got.',
          volatile: 'The page in progress.',
          status: 'recovery',
        },
        {
          id: 'order',
          title: 'Redriven messages are new messages',
          description:
            'They get new offsets, after everything the target has received since they failed, and a fresh set of attempts. Order no longer covers them, and a receiver may see a message it already handled.',
          stage: ['focus:target'],
          source: sourceFocus(
            replayEntry,
            'id: `redrive/${key}/${message.offset}`,'
          ),
          durable: 'New offsets in the current epoch.',
          volatile: 'Nothing.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'pull',
      title: 'Pull instead of being called',
      description:
        'With pull consumers enabled, every message is also written to a second bucket. A consumer asks for messages through an object of its own, which reads that bucket and never a partition.',
      steps: [
        {
          id: 'enable',
          title: 'Pull consumers add one target',
          description:
            'Turning the setting on gives the queue a target of its own, stored like any other. Everything a target already has applies to it: its own position in every partition, retries, and order across a resize.',
          stage: ['*', 'focus:orchestrator'],
          source: sourceFocus(
            syncPullTarget,
            "destination: { type: 'pull' },",
            'deliverFromEpoch: epochs[epochs.length - 1]!.epoch,'
          ),
          durable: 'The target, pushed to every partition.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'write',
          title: 'Every batch is written to the pull bucket',
          description:
            'For that target, delivering means writing the batch to R2 under the partition’s name and the batch’s offsets. Listing a partition’s prefix therefore returns its messages in order. A repeated write leaves the first copy in place.',
          stage: ['focus:pull-bucket'],
          source: sourceFocus(
            writeToPullLog,
            'await env.PULL.put(',
            "{ onlyIf: { etagDoesNotMatch: '*' } }"
          ),
          durable: 'The batch in R2, and the target’s position past it.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'discover',
          title: 'A consumer finds its place by listing',
          description:
            'Each consumer of a queue has its own object. It learns which epochs and partitions exist from the bucket itself, every couple of seconds, so it needs neither the partition list nor the Orchestrator. A new consumer starts at the oldest batch still stored.',
          stage: ['focus:pull-consumer'],
          source: sourceFocus(
            discover,
            'const epochs = await numbersUnder(`${queue}/`);',
            'const later = epochs.find((candidate) => candidate > current);'
          ),
          durable: 'The epoch being read and its partitions.',
          volatile: 'When the bucket was last listed.',
          status: 'normal',
        },
        {
          id: 'read',
          title: 'One partition hands out one range',
          description:
            'A pull takes the partition that has waited longest and has no range out, and reads the batches after the consumer’s position there. Two pulls of the same consumer get different partitions, so keys are never handed out out of order.',
          stage: ['focus:pull-bucket'],
          source: sourceFocus(
            pull,
            '// Least recently checked first, so every partition gets its turn.',
            'AND checked_at <= ?'
          ),
          durable: 'The consumer’s position in the partition.',
          volatile: 'Which partitions are being read right now.',
          status: 'normal',
        },
        {
          id: 'lease',
          title: 'The messages are the consumer’s for a while',
          description:
            'The range is stored with a lease name and an expiry before the messages are returned. Until the consumer acknowledges or the lease runs out, 30 seconds by default, that partition hands out nothing else to this consumer.',
          stage: ['focus:consumer'],
          source: sourceFocus(
            readPartition,
            'lease: crypto.randomUUID(),',
            'expiresAt: Date.now() + (options.visibilityMs ?? defaultVisibilityMs),'
          ),
          durable: 'The lease: its name, its last batch, and its expiry.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'ack',
          title: 'Acknowledge to move on',
          description:
            'An acknowledgement moves the position to the end of the range. A lease that ran out is handed out again under a new name and a higher attempt, so a late acknowledgement of the old one changes nothing and is refused.',
          stage: ['focus:pull-consumer'],
          source: sourceFocus(acknowledge, 'SET position = lease_through,'),
          durable: 'The position.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'epoch',
          title: 'An epoch is read to its end before the next',
          description:
            'Partitions write to a new epoch only after the previous one is completely written, so a later epoch in the bucket means the current one gets nothing more. The consumer moves on once every partition was listed empty after that became known, which keeps keys in order across a resize.',
          stage: ['focus:pull-consumer'],
          source: sourceFocus(
            discover,
            'later !== undefined && this.finished(current) ? later : current;'
          ),
          durable: 'The epoch being read, and when it was found closed.',
          volatile: 'Nothing.',
          status: 'normal',
        },
        {
          id: 'expire',
          title: 'Partitions delete what is past retention',
          description:
            'Each partition deletes its own batches when their time in the bucket, a queue setting of up to 50 days, is over. It remembers when its oldest batch ends, so it lists the bucket only when something can have expired.',
          stage: ['focus:pull-bucket'],
          source: sourceFocus(
            expirePullLog,
            'const kept = page.objects.findIndex(',
            'await env.PULL.delete(expired.map((object) => object.key));'
          ),
          durable: 'When the oldest remaining batch ends.',
          volatile: 'Nothing.',
          status: 'normal',
        },
        {
          id: 'behind',
          title: 'A consumer slower than retention misses messages',
          description:
            'Retention does not wait for consumers, and nothing stops sends when a pull consumer falls behind. A consumer that returns after its batches expired continues with the oldest that remain.',
          stage: ['focus:consumer'],
          source: sourceFocus(
            readPartition,
            '// Retention removed the batches between the listing and the read.'
          ),
          durable: 'The position, now past batches that no longer exist.',
          volatile: 'Nothing.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'resize',
      title: 'Resize without losing order',
      description:
        'A new partition count sends keys to different partitions. The queue moves to a new epoch in an order that never lets a later message of a key overtake an earlier one.',
      steps: [
        {
          id: 'decide',
          title: 'Decide a new partition count',
          description:
            'Every tick the Orchestrator compares the accept rate with what one partition should carry, and checks whether a running target would need more than 30 seconds to deliver its backlog. Growing at least doubles, because every resize has a cost.',
          stage: ['*', 'focus:orchestrator'],
          source: sourceFocus(
            planPartitions,
            'const forRate = clamp(Math.ceil(load.acceptRate / load.targetRate));',
            'const needsDelivery = backlogged && !load.waitingForPermits;'
          ),
          durable: 'The points the rates are computed from.',
          volatile: 'The decision.',
          status: 'normal',
        },
        {
          id: 'intent',
          title: 'Store the intent first',
          description:
            'The next epoch and its count are stored before anything is called. Every later step can be repeated, so a crash at any point is finished by the next tick.',
          stage: ['focus:orchestrator'],
          source: sourceFocus(
            startResize,
            "this.kv.put('resize', { epoch: active.epoch + 1, count });"
          ),
          durable: 'The pending resize.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'stop',
          title: 'Old partitions stop accepting',
          description:
            'The Orchestrator calls every partition of the current epoch and waits for all of them. From then on each refuses sends and answers with the new layout. Nothing is published before this completes.',
          stage: ['focus:partition'],
          source: sourceFocus(
            stopAccepting,
            "this.ctx.storage.kv.put('replacedBy', next);"
          ),
          durable: 'The layout that replaced the partition, kept for good.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'publish',
          title: 'Publish the new partitions',
          description:
            'Only now does the list in KV change: the old partitions are marked draining and the new ones are added. The new partitions receive the queue’s configuration in the same change.',
          stage: ['focus:kv'],
          source: sourceFocus(
            finishResize,
            'await this.topology.update(queue, ({ members }) => ({',
            '...partitionsOf(queue, next).map(memberOf),'
          ),
          durable: 'The membership, and the KV entry once written.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'redirect',
          title: 'A Worker with the old list is redirected',
          description:
            'KV is eventually consistent and isolates cache, so some Workers still hash with the old count. Their partition refuses and names the new layout; the Worker hashes again and sends there. A message is therefore never accepted into the old epoch after one of its key went to the new.',
          stage: ['focus:worker'],
          source: sourceFocus(
            send,
            "'next' in result.error ? (result.error.next as Layout) : undefined;",
            'remaining.push(...messages);'
          ),
          durable: 'Nothing: the refusal stored nothing.',
          volatile: 'The layout this isolate learned from the refusal.',
          status: 'recovery',
        },
        {
          id: 'hold',
          title: 'New partitions accept but do not deliver yet',
          description:
            'Accepting scales at once. Delivery does not: each target carries the oldest epoch that still holds messages for it, and a partition of a later epoch skips that target.',
          stage: ['focus:partition'],
          source: sourceFocus(
            deliverNext,
            'target.deliverFromEpoch !== identity.epoch ||'
          ),
          durable: 'Messages accepted into the new epoch.',
          volatile: 'Nothing.',
          status: 'normal',
        },
        {
          id: 'drained',
          title: 'Wait until the old epoch has nothing left',
          description:
            'Partitions report their positions. An epoch has nothing left for a target once every one of its partitions has stopped accepting and the target’s position has reached the end of its log.',
          stage: ['focus:orchestrator'],
          source: sourceFocus(
            drained,
            '!sample.accepting &&',
            'sample.targets[target]?.settled === sample.accepted)'
          ),
          durable: 'The latest sample of every partition.',
          volatile: 'Nothing.',
          status: 'normal',
        },
        {
          id: 'advance',
          title: 'Move the target on, then drop the epoch',
          description:
            'The target’s epoch advances and the change is pushed to the partitions, which starts delivery from the new ones. Once no target reads an old epoch, its partitions leave the list; their counters are kept in the queue’s totals.',
          stage: ['focus:orchestrator'],
          source: sourceFocus(
            advanceEpochs,
            'target.deliverFromEpoch = epoch;',
            "this.kv.put('epochs', live);"
          ),
          durable: 'Each target’s epoch, the live epochs, and the KV entry.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'stuck',
          title: 'A target that cannot finish holds the epoch',
          description:
            'Only one resize runs at a time. A target that is paused, or whose batches keep failing, keeps the old epoch alive until it has worked through it or dead-lettered it, and no further resize starts before then.',
          stage: ['focus:orchestrator'],
          source: sourceFocus(
            startResize,
            "if (epochs.length > 1 || this.kv.get<Layout>('resize')) {",
            "throw new QueueError('The previous resize is still draining');"
          ),
          durable: 'Two live epochs.',
          volatile: 'Nothing.',
          status: 'gap',
        },
        {
          id: 'resume',
          title: 'A crash mid-resize is finished by the next tick',
          description:
            'If the Orchestrator is evicted between stopping the old partitions and publishing the new, producers are already redirected to partitions that have no configuration and so deliver nothing. The stored intent makes the next tick repeat the steps.',
          stage: ['focus:orchestrator'],
          source: sourceFocus(tick, 'await this.finishResize();'),
          durable: 'The pending resize.',
          volatile: 'Nothing survived the eviction.',
          status: 'recovery',
        },
      ],
    },
    {
      id: 'limit',
      title: 'Share one concurrency limit',
      description:
        'maxConcurrency caps the batches in flight across every partition. Limiters hold shares of it, and the Orchestrator moves the shares to where the demand is.',
      steps: [
        {
          id: 'choose',
          title: 'A partition finds its limiter by hashing',
          description:
            'Every partition ranks the queue’s limiters by a hash of both names and uses the highest. Adding or removing a limiter moves only the partitions that ranked it first, and nobody stores an assignment.',
          stage: ['*', 'focus:partition'],
          source: sourceFocus(
            limiterFor,
            'for (const limiter of limiters) {',
            'chosen = limiter;'
          ),
          durable: 'The limiter list in the partition’s configuration.',
          volatile: 'The choice, recomputed when needed.',
          status: 'normal',
        },
        {
          id: 'hold',
          title: 'Keep the permit across batches',
          description:
            'A permit covers one batch in flight, but asking for one per batch would cost a round trip each time. A target keeps its permit while it has work, for at most ten seconds, then returns it so other partitions get a turn.',
          stage: ['focus:partition'],
          source: sourceFocus(
            holdPermit,
            'const keptLongEnough =',
            'heldSince !== undefined && Date.now() - heldSince >= permitHoldMs;'
          ),
          durable: 'Which permit the target holds or waits for.',
          volatile: 'When the permit was taken.',
          status: 'normal',
        },
        {
          id: 'grant',
          title: 'A limiter grants within its share',
          description:
            'Each limiter enforces only its own share of the queue limit, and its share of every target’s ceiling. It reads both each time it hands out permits, so a new share applies without a restart.',
          stage: ['focus:limiter'],
          source: sourceFocus(
            limiter,
            'limit: () => this.share().permits,',
            'groupLimit: (target) => this.share().targets[target],'
          ),
          durable: 'The shares last pushed, and the permits handed out.',
          volatile: 'The count of requests still waiting.',
          status: 'normal',
        },
        {
          id: 'plan',
          title: 'Split the limit by demand',
          description:
            'Every tick the Orchestrator asks each limiter how many permits are in use and how many are still asked for, and plans shares in that proportion. The published shares never add up to more than the queue limit.',
          stage: ['focus:orchestrator'],
          source: sourceFocus(
            balanceLimiters,
            'const plan = planShares({',
            'revision: state.revision + 1,'
          ),
          durable: 'The shares and their revision.',
          volatile: 'The limiters’ answers for this tick.',
          status: 'commit',
        },
        {
          id: 'strict',
          title: 'strict lowers first and raises later',
          description:
            'Lowering a share never stops work already admitted. In strict mode a lowered limiter still counts at its old share until it reports the lower one applied, and other limiters are raised only from what is left. In fast mode both happen at once and the queue can run above its limit until that work finishes.',
          stage: ['focus:limiter'],
          source: sourceFocus(
            planShares,
            'if (share < current) {',
            'unassigned -= beforeLowering[name];'
          ),
          durable: 'The share each lowered limiter had before.',
          volatile: 'Nothing.',
          status: 'normal',
        },
        {
          id: 'scale',
          title: 'Add a limiter when requests grow',
          description:
            'The only signal is the rate of permit requests. One limiter is added when the total exceeds what the current ones should carry, and one is removed when the rest would be half idle. A removed limiter gets a share of zero and leaves once its permits are back.',
          stage: ['focus:orchestrator'],
          source: sourceFocus(
            planLimiters,
            'const wanted = Math.max(',
            'return load.current + 1;'
          ),
          durable: 'The active and draining limiters.',
          volatile: 'Each limiter’s request rate, counted in memory.',
          status: 'normal',
        },
        {
          id: 'restart',
          title: 'After a restart, a permit is adopted or returned',
          description:
            'How long a permit has been held lives in memory. After an eviction the target adopts a permit it already holds when it next has work; a permit nobody adopts is returned by a check that runs a minute after it was granted.',
          stage: ['focus:partition'],
          source: sourceFocus(
            holdPermit,
            "if (status?.state === 'admitted') {",
            'this.heldSince.set(item, Date.now());'
          ),
          durable: 'The permit itself.',
          volatile: 'The time it was taken, lost on eviction.',
          status: 'recovery',
        },
      ],
    },
    {
      id: 'observe',
      title: 'Count without counting messages',
      description:
        'The dashboard’s numbers come from positions the partitions already store, not from a write per message.',
      steps: [
        {
          id: 'sample',
          title: 'A partition reports positions',
          description:
            'The log’s next offset is the number of messages accepted, and each target’s position is the number settled for it. A sample carries those, the messages in flight, and the failure counters.',
          stage: ['*', 'focus:log'],
          source: sourceFocus(
            sample,
            'accepted: nextOffset,',
            'settled: positions[name] ?? 0,'
          ),
          durable: 'The positions, and the sample’s sequence number.',
          volatile: 'The in-flight counts.',
          status: 'normal',
        },
        {
          id: 'report',
          title: 'Only the newest sample is sent',
          description:
            'A busy partition stages a sample about once a second; a newer sample replaces one not yet sent, and sending is retried until the Orchestrator has it. The Orchestrator keeps one row per partition and lets only a later sequence number replace it.',
          stage: ['focus:orchestrator'],
          source: sourceFocus(
            report,
            'this.store(samples.filter((sample) => live.has(sample.epoch)));'
          ),
          durable: 'One sample per partition.',
          volatile: 'When the last report arrived.',
          status: 'commit',
        },
        {
          id: 'point',
          title: 'A tick adds the samples into a point',
          description:
            'Every two seconds the Orchestrator sums the samples into one point of cumulative counters and stores it: 30 minutes at full resolution and 48 hours by the minute. The same point feeds the autoscaler.',
          stage: ['focus:orchestrator'],
          source: sourceFocus(
            tick,
            'const point = this.recordPoint(this.limiterSamples);',
            'await this.autoscale(point);'
          ),
          durable: 'The points.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'push',
          title: 'The dashboard turns points into rates',
          description:
            'Each point is pushed to connected browsers. Accepted per second is the difference between two points divided by the time between them; a browser that reconnects replays the points it missed.',
          stage: ['focus:dashboard'],
          source: sourceFocus(tick, 'this.socket.point(point);'),
          durable: 'Recent socket events, for replay.',
          volatile: 'The connections.',
          status: 'normal',
        },
        {
          id: 'idle',
          title: 'An idle queue stops ticking',
          description:
            'Ticks continue while partitions report, and for 30 seconds after the last report. Then the Orchestrator schedules nothing and can be evicted; the next report starts the ticks again.',
          stage: ['focus:orchestrator'],
          source: sourceFocus(
            tick,
            'const busy =',
            "this.kv.get<boolean>('deleting') === true;"
          ),
          durable: 'Nothing is scheduled.',
          volatile: 'Nothing.',
          status: 'normal',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
