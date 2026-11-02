import coordinatorWorker from '../../../packages/durability/tests/topology-worker.ts?raw';
import outbox from '../../../packages/durability/src/outbox.ts?raw';
import scheduler from '../../../packages/durability/src/scheduler.ts?raw';
import client from '../../../packages/durability/src/topology-client.ts?raw';
import snapshot from '../../../packages/durability/src/topology-snapshot.ts?raw';
import topology from '../../../packages/durability/src/topology.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const workerFile = 'packages/durability/tests/topology-worker.ts';
const outboxFile = 'packages/durability/src/outbox.ts';
const schedulerFile = 'packages/durability/src/scheduler.ts';
const clientFile = 'packages/durability/src/topology-client.ts';
const snapshotFile = 'packages/durability/src/topology-snapshot.ts';
const topologyFile = 'packages/durability/src/topology.ts';

const coordinator = sourceExcerpt(
  coordinatorWorker,
  workerFile,
  'coordinator',
  'TopologyCoordinator Durable Object',
  'export class TopologyCoordinator extends DurableObject<Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const shard = sourceExcerpt(
  coordinatorWorker,
  workerFile,
  'shard',
  'TopologyShard Durable Object',
  'export class TopologyShard extends DurableObject<Env> {',
  '    });\n  }'
);
const construct = sourceExcerpt(
  topology,
  topologyFile,
  'construct',
  'Attach tables and outbox channels',
  '    const scheduler = config.scheduler ?? new DurabilityScheduler(config);',
  '            this.#deliver(name, channel, entries, timeoutMs),'
);
const update = sourceExcerpt(
  topology,
  topologyFile,
  'update',
  'Apply a change in one transaction',
  '  async update(',
  '    return { snapshot, published: await this.#publishNow(group) };\n  }'
);
const transaction = sourceExcerpt(
  scheduler,
  schedulerFile,
  'transaction',
  'Write rows and the alarm together',
  '  async transaction<T>(write: (sql: SqlStorage) => T): Promise<T> {',
  '    return result;\n  }'
);
const stageDeliveries = sourceExcerpt(
  topology,
  topologyFile,
  'stage-deliveries',
  'Stage a delivery per member',
  '  #stageDeliveries(',
  '          value: deserialize(value),\n        });\n      }\n    }\n  }'
);
const publish = sourceExcerpt(
  topology,
  topologyFile,
  'publish',
  'Record each write before it starts',
  '  async #publishSnapshots(',
  '          entry.retry(Math.min(outstandingUntil - Date.now(), maxTimeoutMs));\n        }\n      })\n    );\n  }'
);
const landing = sourceExcerpt(
  topology,
  topologyFile,
  'landing',
  'Bound how long an old write can land',
  ' * How long after its timeout an abandoned publisher write is assumed able to',
  '  return until ?? undefined;\n};'
);
const deliver = sourceExcerpt(
  topology,
  topologyFile,
  'deliver',
  'Deliver to each member',
  '  async #deliver(',
  '          entry.retry();\n        }\n      })\n    );\n  }'
);
const runBatch = sourceExcerpt(
  outbox,
  outboxFile,
  'run-batch',
  'Claim outbox rows with a deadline',
  '  async #runBatch(key?: string): Promise<void> {',
  '      return claimed;\n    });'
);
const clientGet = sourceExcerpt(
  client,
  clientFile,
  'client-get',
  'Serve from the isolate cache',
  '  get(group: string): Promise<TopologyView<Meta>> {',
  '    return run;\n  }'
);
const clientLoad = sourceExcerpt(
  client,
  clientFile,
  'client-load',
  'Never move readers backwards',
  '  async #load(group: string): Promise<TopologyView<Meta>> {',
  '    return this.#fallback(group, entry);\n  }'
);
const clientRead = sourceExcerpt(
  client,
  clientFile,
  'client-read',
  'Read the store with a timeout',
  '  async #read(',
  "      return { failure: { reason: 'invalid', cause } };\n    }\n  }"
);
const decode = sourceExcerpt(
  snapshot,
  snapshotFile,
  'decode',
  'Re-validate the stored snapshot',
  'const encodedSchema = z.object({',
  '  return snapshot as unknown as TopologySnapshot<Meta>;\n};'
);
const clientFallback = sourceExcerpt(
  client,
  clientFile,
  'client-fallback',
  'Opt-in fallbacks, then fail',
  '  async #fallback(',
  '    throw new TopologyUnavailableError(group, reason, { cause });\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'topology',
  title: 'How DurabilityTopology uses your Durable Object',
  summary:
    'One coordinator object keeps each group’s membership in its SQLite storage, publishes a snapshot to a read store, and pushes state values to member objects through outbox rows driven by its alarm. Readers never call it. Step through a change, an eviction mid-publish, a shard rotation, and a read.',
  diagram: {
    canvas: { width: 1140, height: 960 },
    direction: 'down',
    routing: 'auto',
    flows: {
      update: { label: 'change a group', color: 'blue' },
      publish: { label: 'publish the snapshot', color: 'orange' },
      deliver: { label: 'deliver a state value', color: 'purple' },
      recover: { label: 'recover from the alarm', color: 'green' },
      read: { label: 'read from a Worker', color: 'red' },
    },
    nodes: {
      admin: {
        rank: 0,
        row: 1,
        label: 'Worker',
        sublabel: 'admin request',
        icon: 'workers',
        tone: 'external',
      },
      coordinator: {
        size: [330, 72],
        rank: 1,
        row: 1,
        label: 'TopologyCoordinator',
        sublabel: 'your Durable Object',
        icon: 'durable-objects',
      },
      topology: {
        rank: 2,
        row: 1,
        label: 'DurabilityTopology',
        sublabel: 'in memory',
        icon: 'shield',
      },
      alarm: {
        rank: 3,
        row: 0,
        label: 'Object alarm',
        sublabel: 'ctx.storage.setAlarm',
        icon: 'clock',
      },
      tables: {
        rank: 3,
        row: 1,
        label: 'Topology tables',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      outbox: {
        rank: 3,
        row: 2,
        label: 'durability_outbox',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
      shard: {
        size: [264, 72],
        rank: 4,
        row: 0,
        label: 'TopologyShard',
        sublabel: 'member objects',
        icon: 'durable-objects',
        replicas: 3,
      },
      kv: {
        size: [216, 72],
        rank: 4,
        row: 2,
        label: 'Workers KV',
        sublabel: 'read store',
        icon: 'kv',
        tone: 'external',
      },
      client: {
        rank: 5,
        row: 2,
        label: 'TopologyClient',
        sublabel: 'Worker isolate',
        icon: 'workers',
        tone: 'external',
      },
    },
    edges: [
      {
        from: 'admin',
        to: 'coordinator',
        label: 'create(group)',
        flow: 'update',
      },
      {
        from: 'coordinator',
        to: 'topology',
        label: 'update()',
        flow: 'update',
      },
      { from: 'topology', to: 'tables', label: 'rows', flow: 'update' },
      { from: 'topology', to: 'outbox', label: 'stage', flow: 'update' },
      { from: 'topology', to: 'alarm', label: 'setAlarm', flow: 'update' },
      {
        from: 'alarm',
        to: 'coordinator',
        label: 'alarm()',
        flow: 'recover',
        back: true,
      },
      {
        from: 'topology',
        to: 'kv',
        label: 'write(encoded)',
        flow: 'publish',
      },
      {
        from: 'topology',
        to: 'shard',
        label: 'applyLimits()',
        flow: 'deliver',
      },
      {
        from: 'client',
        to: 'kv',
        label: 'read(group)',
        flow: 'read',
        back: true,
      },
    ],
    groups: [
      {
        id: 'coordinator-object',
        label: 'Coordinator Durable Object',
        contains: ['coordinator', 'topology', 'alarm', 'tables', 'outbox'],
      },
      {
        id: 'member-objects',
        label: 'Member Durable Objects',
        contains: ['shard'],
      },
    ],
  },
  details: {
    admin: {
      description:
        'Any caller with a stub to the coordinator. Only the coordinator can change or publish its groups, so every membership change and state value goes through its methods.',
      href: '/primitives/topology/',
      source: 'coordinator',
    },
    coordinator: {
      description:
        'Your class. DurabilityTopology is one of its fields, so the helper is rebuilt with every new instance. Its alarm() must delegate to the scheduler the helper shares, or staged publications and deliveries stop after an eviction.',
      href: '/primitives/topology/',
      source: 'coordinator',
    },
    topology: {
      description:
        'Needs the object’s ID, which every snapshot carries as its coordinator. Holds one DurabilityOutbox for publication and one per state channel. In-flight writes, deliveries, and their timeouts exist only in this instance.',
      href: '/primitives/topology/',
      source: 'construct',
    },
    alarm: {
      description:
        'The object’s single alarm, shared with every helper on the scheduler. Each topology transaction sets it to the earliest pending outbox row, so staged publications and deliveries survive eviction.',
      href: '/primitives/scheduler/',
      source: 'transaction',
    },
    tables: {
      description:
        'durability_topology_groups holds each group’s version and members, durability_topology_states each channel’s latest value, and durability_topology_writes every publisher write that might still land.',
      href: '/reference/storage/',
      source: 'update',
    },
    outbox: {
      description:
        'Shared with any other outbox on the scheduler and partitioned by channel: durability.topology keyed by group, and durability.topology.<channel> keyed by [group, member]. Only the newest value per key is pending.',
      href: '/primitives/outbox/',
      source: 'stage-deliveries',
    },
    shard: {
      description:
        'Separate Durable Objects, each with its own storage. A delivery is an RPC call; the shard must ignore versions it has already passed, in the same transaction that applies the value.',
      href: '/primitives/topology/',
      source: 'shard',
    },
    kv: {
      description:
        'The read store, outside every Durable Object. KV has no conditional write, so an older snapshot can land over a newer one; the coordinator bounds that window with its write records.',
      href: '/reference/guarantees/',
      source: 'publish',
    },
    client: {
      description:
        'Runs in a stateless Worker and never contacts the coordinator. Its cache, in-flight reads, and fallback decisions live in the isolate and are not durable membership.',
      href: '/primitives/topology/',
      source: 'client-get',
    },
  },
  excerpts: [
    coordinator,
    construct,
    update,
    transaction,
    stageDeliveries,
    publish,
    deliver,
    shard,
    runBatch,
    landing,
    clientGet,
    clientRead,
    decode,
    clientLoad,
    clientFallback,
  ],
  scenarios: [
    {
      id: 'update',
      title: 'Create a group and publish it',
      description:
        'Follow one create() from the RPC call to a published snapshot and a state value applied on every member.',
      steps: [
        {
          id: 'field',
          title: 'The helper belongs to the coordinator',
          description:
            'DurabilityTopology attaches to the object’s scheduler and reads the object’s ID. Without a Durable Object context it throws, because every snapshot names the coordinator that published it.',
          stage: [
            'coordinator',
            'topology',
            'coordinator-object',
            'focus:topology',
          ],
          source: sourceFocus(
            construct,
            'this.#engine = engineFor({ scheduler });',
            'this.#coordinator = coordinator;'
          ),
          durable: 'Nothing is written yet.',
          volatile: 'The helper, its engine, and the coordinator ID string.',
          status: 'normal',
        },
        {
          id: 'migrate',
          title: 'Create the topology tables',
          description:
            'The constructor applies the topology migrations synchronously through ctx.storage.sql: groups, states, and write records.',
          stage: ['tables', 'focus:tables'],
          source: sourceFocus(
            construct,
            "this.#engine.migrateSchema('topology', durabilityTopologyMigrations);"
          ),
          durable: 'The three durability_topology_* tables exist.',
          volatile: 'Nothing beyond the helper.',
          status: 'commit',
        },
        {
          id: 'outboxes',
          title: 'Publication and channels are outbox channels',
          description:
            'The publisher gets an outbox on durability.topology and each state channel one on durability.topology.<name>, all on the same scheduler, so their rows share durability_outbox and the object alarm.',
          stage: ['outbox', 'focus:outbox'],
          source: sourceFocus(
            construct,
            'this.#publication = new DurabilityOutbox<Publication<Meta>>({',
            'channel: `${publicationChannel}.${name}`,'
          ),
          durable: 'durability_outbox, partitioned by channel.',
          volatile: 'One DurabilityOutbox instance per channel.',
          status: 'normal',
        },
        {
          id: 'rpc',
          title: 'A caller creates a group',
          description:
            'create() calls update with a draft that sets three active members and the limits value. Only this coordinator can change the group.',
          stage: ['admin', 'flow:update'],
          source: sourceFocus(
            coordinator,
            'create(group: string, shards: number, limits: Limits) {',
            'states: { limits },'
          ),
          durable: 'Nothing until the transaction commits.',
          volatile: 'The RPC call waits on update.',
          status: 'normal',
        },
        {
          id: 'transaction',
          title: 'Read and write the group in one transaction',
          description:
            'update reads the current members and state values, runs your draft function inside the storage transaction, and rejects a draft that returns a promise. A membership change bumps the group version.',
          stage: ['focus:tables'],
          source: sourceFocus(
            update,
            'const snapshot = await this.#engine.transaction((sql) => {',
            "throw new TopologyError('update must return its draft synchronously');"
          ),
          durable: 'The group row with version 1 and the limits value.',
          volatile: 'The draft, only for the transaction.',
          status: 'commit',
        },
        {
          id: 'stage',
          title: 'Stage sends and set the alarm before commit',
          description:
            'In the same transaction the snapshot is staged on the publication channel and a delivery for each member on the limits channel. The engine then sets the object alarm to the earliest pending row, so nothing commits without its alarm.',
          stage: ['alarm', '-alarm->coordinator', 'focus:topology'],
          source: sourceFocus(
            transaction,
            'const result = await this.storage.transaction(async (transaction) => {',
            'nextPendingAt = await this.reconcile(transaction);'
          ),
          durable:
            'Group rows, outbox rows, and the alarm commit together or not at all.',
          volatile:
            'An in-memory timer for rows due before the alarm, set after commit.',
          status: 'commit',
        },
        {
          id: 'publish',
          title: 'Record the write, then publish once',
          description:
            'After the commit, update attempts one publication. A write record with a landing deadline commits before the KV put starts and is deleted once it settles. published is false if the write failed or an older one may still land.',
          stage: ['kv', 'flow:publish'],
          source: sourceFocus(
            publish,
            'INSERT INTO durability_topology_writes (id, group_id, land_by)',
            'encodeSnapshot(publication.snapshot)'
          ),
          durable:
            'The write record until the put settles; the encoded snapshot in KV.',
          volatile: 'The put promise and its timeout.',
          status: 'normal',
        },
        {
          id: 'deliver',
          title: 'Deliver the value to each member',
          description:
            'The limits rows are published by the outbox on the next timer or alarm pass, not by update. Each member gets its own RPC call with its own timeout; a failure retries only that member.',
          stage: ['shard', 'member-objects', 'flow:deliver'],
          source: sourceFocus(deliver, 'await withTimeout(', 'entry.retry();'),
          durable: 'Each member’s outbox row stays until its call returns.',
          volatile: 'The RPC calls in flight.',
          status: 'normal',
        },
        {
          id: 'apply',
          title: 'The member applies only newer versions',
          description:
            'A timed-out delivery can arrive after a newer one. The shard stores the value and its outbox version in one transaction and ignores any version it has already passed.',
          stage: ['focus:shard'],
          source: sourceFocus(
            shard,
            "const applied = this.ctx.storage.kv.get<number>('limits:version') ?? 0;",
            "this.ctx.storage.kv.put('limits:version', update.version);"
          ),
          durable: 'limits and limits:version in the shard’s own storage.',
          volatile: 'Nothing; the check is in storage.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'eviction',
      title: 'Evict the coordinator mid-publish',
      description:
        'An illustrative eviction while a KV write is in flight, not execution of the test worker.',
      steps: [
        {
          id: 'evicted',
          title: 'The coordinator is evicted during a write',
          description:
            'Assume the write record has committed and the KV put is in flight when the runtime evicts the object. The put may still land later; nothing in the object can tell.',
          stage: ['*', 'flow:publish'],
          source: sourceFocus(
            publish,
            'const write = Promise.resolve().then(() =>',
            "await withTimeout(write, timeoutMs, 'publish');"
          ),
          durable:
            'The group, the claimed outbox row, the write record, and the alarm.',
          volatile: 'The put promise, its timeout, and the helper.',
          status: 'failure',
        },
        {
          id: 'wake',
          title: 'The alarm retries the claimed row',
          description:
            'Claiming the row set its retry time to the batch deadline, so it becomes due again. The alarm starts a new instance, alarm() delegates to the scheduler, and the outbox claims the snapshot for another attempt.',
          stage: ['flow:recover'],
          source: sourceFocus(
            runBatch,
            '// A crash mid-publication leaves the claim due again at the deadline.',
            'deadline\n        );'
          ),
          durable: 'The outbox row with its attempt count increased.',
          volatile: 'A fresh helper and a new publish batch.',
          status: 'recovery',
        },
        {
          id: 'blocked',
          title: 'A newer write is not acknowledged yet',
          description:
            'The new write lands and deletes its own record, but the evicted write’s record is still there. The entry is retried at that record’s landing deadline instead of being acknowledged.',
          stage: ['focus:tables'],
          source: sourceFocus(
            publish,
            'const outstandingUntil = await this.#engine.transaction((sql) => {',
            'entry.retry(Math.min(outstandingUntil - Date.now(), maxTimeoutMs));'
          ),
          durable:
            'The old write record and the pending outbox row, with the alarm set.',
          volatile: 'Nothing that recovery depends on.',
          status: 'recovery',
        },
        {
          id: 'rewrite',
          title: 'Write again after the landing deadline',
          description:
            'At the deadline the expired record is deleted and the snapshot is written again, so the newest version is the last write the coordinator knows of. Then the outbox row is acknowledged.',
          stage: ['focus:kv'],
          source: sourceFocus(
            landing,
            'DELETE FROM durability_topology_writes WHERE group_id = ? AND land_by <= ?',
            'return until ?? undefined;'
          ),
          durable: 'No write records; the outbox row is deleted.',
          volatile: 'Nothing.',
          status: 'recovery',
        },
        {
          id: 'bound',
          title: 'The landing window is a bound, not a proof',
          description:
            'The deadline is the write’s start plus attemptTimeoutMs plus five minutes. An old put that lands later still overwrites the newer snapshot until the next change; only a store that keeps the highest version closes that gap.',
          stage: ['focus:kv'],
          source: sourceFocus(landing, 'const landingWindowMs = 5 * 60_000;'),
          durable: 'Whatever KV holds last.',
          volatile: 'The abandoned put, beyond the coordinator’s reach.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'rotate',
      title: 'Rotate a shard',
      description: 'Drain one member and add a new one in a single update.',
      steps: [
        {
          id: 'rotate',
          title: 'Drain one member and add another',
          description:
            'rotate() returns the current members with one marked draining and a new active member. A draining member stays in the read set, so readers still reach its data.',
          stage: ['*', 'focus:coordinator'],
          source: sourceFocus(
            coordinator,
            'rotate(group: string, shardId: string) {',
            "{ id: `${group}-${members.length}`, state: 'active' },"
          ),
          durable: 'Nothing until the transaction commits.',
          volatile: 'The draft.',
          status: 'normal',
        },
        {
          id: 'version',
          title: 'A membership change bumps the version',
          description:
            'The members are compared canonically with the stored ones. Because they changed, the version increases and a new snapshot is staged for publication in the same transaction.',
          stage: ['focus:tables'],
          source: sourceFocus(
            update,
            'const changed =',
            'this.#stagePublication(sql, group, { snapshot: current });'
          ),
          durable: 'The group row with the new version and members.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'joiner',
          title: 'The new member gets the current value',
          description:
            'The limits value did not change, so existing members get nothing. The new member was not in the channel’s role before, so its delivery is staged in the same transaction that added it.',
          stage: ['focus:outbox'],
          source: sourceFocus(
            stageDeliveries,
            'if (!changed.has(name) && previous.has(member.id)) {',
            'stageWithin(channel.outbox, sql, deliveryKey(group, member.id), {'
          ),
          durable: 'One new outbox row for the new member.',
          volatile: 'Nothing.',
          status: 'commit',
        },
        {
          id: 'draining',
          title: 'The draining member leaves the write channel',
          description:
            'limits reaches active members only, so the draining member’s pending delivery is deleted. A delivery already in flight still arrives; its version check orders values but cannot tell the shard it left the role.',
          stage: ['focus:shard'],
          source: sourceFocus(
            stageDeliveries,
            'for (const id of previous) {',
            'discardWithin(channel.outbox, sql, deliveryKey(group, id));'
          ),
          durable: 'The draining member’s outbox row is gone.',
          volatile: 'A delivery already in flight to it.',
          status: 'gap',
        },
      ],
    },
    {
      id: 'reader',
      title: 'Read from a stateless Worker',
      description:
        'How a Worker finds a group’s members without contacting the coordinator.',
      steps: [
        {
          id: 'cache',
          title: 'Serve from the isolate cache',
          description:
            'A fresh entry is returned without I/O. Concurrent callers for one group share a single read, and at most 1,024 groups stay cached per isolate.',
          stage: ['client', 'kv', 'focus:client'],
          source: sourceFocus(
            clientGet,
            'if (entry && Date.now() < entry.expiresAt) {',
            'return run;'
          ),
          durable: 'Nothing; the client writes no storage.',
          volatile: 'The cache entry, jittered TTL, and in-flight read.',
          status: 'normal',
        },
        {
          id: 'read',
          title: 'Read the published copy with a timeout',
          description:
            'On a miss the client calls your read function and races it against readTimeoutMs. A missing value, a timeout, and a thrown error are remembered for negativeTtlMs.',
          stage: ['flow:read'],
          source: sourceFocus(
            clientRead,
            'encoded = await Promise.race([',
            "return { failure: { reason: 'missing' } };"
          ),
          durable: 'The encoded snapshot in KV.',
          volatile: 'The read and its timer.',
          status: 'normal',
        },
        {
          id: 'validate',
          title: 'Re-validate the stored snapshot',
          description:
            'The stored value crossed a trust boundary, so every field is parsed again: format, positive version, coordinator ID, and at least one member sorted by ID. A snapshot for another group is rejected.',
          stage: ['focus:kv'],
          source: sourceFocus(
            decode,
            'const encodedSchema = z.object({',
            'members: membersSchema.min(1),'
          ),
          durable: 'Unchanged.',
          volatile: 'The decoded snapshot.',
          status: 'normal',
        },
        {
          id: 'no-regress',
          title: 'Never move readers backwards',
          description:
            'KV is eventually consistent. If a lagging replica returns an older version from the same coordinator, the cached newer snapshot is kept. A different coordinator ID starts over.',
          stage: ['focus:client'],
          source: sourceFocus(
            clientLoad,
            'const keep =',
            'previous.view.version > snapshot.version;'
          ),
          durable: 'Unchanged.',
          volatile: 'The isolate’s newest snapshot per group.',
          status: 'normal',
        },
        {
          id: 'fallback',
          title: 'Fail rather than call the coordinator',
          description:
            'When the published copy is unusable, the client tries the opt-in fallbacks in order: a stale snapshot, local seed members, then your fallback function. Without them it throws TopologyUnavailableError; it never contacts the coordinator.',
          stage: ['focus:client'],
          source: sourceFocus(
            clientFallback,
            'this.#config.staleIfErrorMs !== undefined &&',
            'throw new TopologyUnavailableError(group, reason, { cause });'
          ),
          durable: 'Nothing; the coordinator is not involved.',
          volatile: 'The negative cache entry and the fallback result.',
          status: 'gap',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
