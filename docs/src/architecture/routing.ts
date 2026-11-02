import example from '../../../examples/email-queue/worker.ts?raw';
import target from '../../../packages/durability/src/durable-object-target.ts?raw';
import fanout from '../../../packages/durability/src/fanout.ts?raw';
import load from '../../../packages/durability/src/load.ts?raw';
import routingClient from '../../../packages/durability/src/routing-client.ts?raw';
import routing from '../../../packages/durability/src/routing.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture.ts';

const exampleFile = 'examples/email-queue/worker.ts';
const targetFile = 'packages/durability/src/durable-object-target.ts';
const fanoutFile = 'packages/durability/src/fanout.ts';
const loadFile = 'packages/durability/src/load.ts';
const routingClientFile = 'packages/durability/src/routing-client.ts';
const routingFile = 'packages/durability/src/routing.ts';

const emailDelivery = sourceExcerpt(
  example,
  exampleFile,
  'email-delivery',
  'EmailDelivery Durable Object',
  'export class EmailDelivery extends DurableObject<Env> {',
  '    return this.scheduler.alarm(info);\n  }'
);
const clientConfig = sourceExcerpt(
  example,
  exampleFile,
  'client-config',
  'Routing client for EmailDelivery',
  'export const routing = DurabilityRouting.client({',
  '});'
);
const redrive = sourceExcerpt(
  example,
  exampleFile,
  'redrive',
  'Redrive with stable message IDs',
  'export async function redrive(env: Env, after: number): Promise<number> {',
  '  return accepted;\n}'
);
const fetchHandler = sourceExcerpt(
  example,
  exampleFile,
  'fetch-handler',
  'Push from the Worker',
  'export default {',
  '} satisfies ExportedHandler<Env>;'
);
const stub = sourceExcerpt(
  routing,
  routingFile,
  'stub',
  'Turn an address into a stub',
  '    const client = new RoutingClient<Input, Value, Context>({',
  '        return config.invoke(stub, input);\n      },'
);
const resolve = sourceExcerpt(
  target,
  targetFile,
  'resolve',
  'Find the Durable Object namespace',
  'export const resolveNamespace = <Target extends Rpc.DurableObjectBranded>(',
  '  return exported as DurableObjectNamespace<Target>;\n};'
);
const push = sourceExcerpt(
  routingClient,
  routingClientFile,
  'push',
  'Choose one shard and record its load',
  '  async push(input: Input, context?: Context): Promise<EnqueueResult<Value>> {',
  '    return response;\n  }'
);
const select = sourceExcerpt(
  routingClient,
  routingClientFile,
  'select',
  'Compare two candidate shards',
  '  #select(observations: ReadonlyMap<string, LoadSnapshot>): string {',
  '    return pressure(a) <= pressure(b) ? first : second;\n  }'
);
const resize = sourceExcerpt(
  routingClient,
  routingClientFile,
  'resize',
  'Widen or narrow the shard range',
  '  #resize(load: LoadSnapshot): void {',
  '      this.#lastResize = now;\n    }\n  }'
);
const loadState = sourceExcerpt(
  load,
  loadFile,
  'load-state',
  'Telemetry kept in memory',
  'export class RoutingLoad {',
  '      this.buckets[direction].set(slot, bucket);\n    };\n  }'
);
const snapshot = sourceExcerpt(
  load,
  loadFile,
  'snapshot',
  'Build a load snapshot',
  '  snapshot(pendingDeliveries: number): LoadSnapshot {',
  '    };\n  }'
);
const enqueue = sourceExcerpt(
  fanout,
  fanoutFile,
  'enqueue',
  'Accept a batch in the object',
  "    const finish = this.#routing.begin('inbound');",
  '    return { success: true, value: entries.map(({ id }) => id), load };'
);
const pendingRows = sourceExcerpt(
  fanout,
  fanoutFile,
  'pending-rows',
  'Recount after a new instance',
  '  #pendingCount(): number {',
  '    return this.#pending;\n  }'
);

export const walkthrough = validateWalkthrough({
  id: 'routing',
  title: 'How DurabilityRouting uses your Durable Objects',
  summary:
    'The routing client lives in the calling Worker and picks one object per push; the object side only measures load in memory. Step through a push, then lose a reply and retry it.',
  diagram: {
    canvas: { width: 1000, height: 900 },
    direction: 'down',
    routing: 'auto',
    flows: {
      push: { label: 'push a batch', color: 'blue' },
      observe: { label: 'report load', color: 'purple' },
      retry: { label: 'retry on another shard', color: 'red' },
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
      client: {
        rank: 1,
        row: 1,
        label: 'Routing client',
        sublabel: 'isolate memory',
        icon: 'shield',
      },
      shard: {
        rank: 2,
        row: 1,
        label: 'EmailDelivery',
        sublabel: 'shard customer-a',
        icon: 'durable-objects',
      },
      other: {
        rank: 2,
        row: 0,
        label: 'EmailDelivery',
        sublabel: 'another shard',
        icon: 'durable-objects',
      },
      load: {
        rank: 4,
        row: 2,
        label: 'DurabilityRouting',
        sublabel: 'in memory',
        icon: 'shield',
      },
      fanout: {
        rank: 3,
        row: 1,
        label: 'DurabilityFanout',
        sublabel: 'durable queue',
        icon: 'queues',
      },
      deliveries: {
        rank: 4,
        row: 1,
        label: 'fanout tables',
        sublabel: 'ctx.storage.sql',
        icon: 'database',
      },
    },
    edges: [
      { from: 'worker', to: 'client', label: 'push(batch)', flow: 'push' },
      { from: 'client', to: 'shard', label: 'stub.enqueue()', flow: 'push' },
      { from: 'shard', to: 'fanout', label: 'enqueue()', flow: 'push' },
      { from: 'fanout', to: 'deliveries', label: 'rows', flow: 'push' },
      { from: 'fanout', to: 'load', label: 'begin()', flow: 'observe' },
      {
        from: 'load',
        to: 'client',
        label: 'result.load',
        flow: 'observe',
        back: true,
      },
      { from: 'client', to: 'other', label: 'retry', flow: 'retry' },
    ],
    groups: [
      {
        id: 'shard-object',
        label: 'One Durable Object',
        contains: ['shard', 'load', 'fanout', 'deliveries'],
      },
    ],
  },
  details: {
    worker: {
      description:
        'Your fetch handler. It calls routing.push() with ordinary caller transforms; the lane transform adds caller context and timeout bounds the wait for the reply.',
      href: '/reference/transforms/',
      source: 'fetch-handler',
    },
    client: {
      description:
        'Built once at module scope by DurabilityRouting.client(), so it lives in the calling isolate. Its recent load observations and adaptive shard width are local to that isolate and are never persisted or shared.',
      href: '/primitives/routing/',
      source: 'push',
    },
    shard: {
      description:
        'Your class, addressed by the shard key with namespace.getByName(). Routing generates no class and calls no method on its own; invoke() decides that stub.enqueue() is the RPC.',
      href: '/primitives/routing/',
      source: 'email-delivery',
    },
    other: {
      description:
        'A separate object of the same class with its own SQLite storage. Its tables hold nothing about work accepted by the first shard.',
      href: '/reference/identity/',
      source: 'select',
    },
    load: {
      description:
        'The object-side DurabilityRouting is a RoutingLoad: in-flight counters and sixty one-second buckets in memory. It owns no table and no alarm, and the runtime discards it on eviction.',
      href: '/primitives/routing/',
      source: 'load-state',
    },
    fanout: {
      description:
        'The capability that receives the batch. It reports inbound and outbound work to the load observer and supplies the durable pending-delivery count for each snapshot.',
      href: '/primitives/fanout/',
      source: 'enqueue',
    },
    deliveries: {
      description:
        'durability_fanout_messages and durability_fanout_deliveries in the object’s own SQLite storage, written through the scheduler transaction that also sets the object alarm.',
      href: '/reference/storage/',
      source: 'pending-rows',
    },
  },
  excerpts: [
    emailDelivery,
    clientConfig,
    redrive,
    fetchHandler,
    stub,
    resolve,
    push,
    select,
    resize,
    loadState,
    snapshot,
    enqueue,
    pendingRows,
  ],
  scenarios: [
    {
      id: 'push',
      title: 'Route one push',
      description:
        'Follow one batch from the Worker to the shard that accepts it, and the load report that comes back.',
      steps: [
        {
          id: 'isolate',
          title: 'The client lives in the calling Worker',
          description:
            'DurabilityRouting.client() runs at module scope in the Worker, not in a Durable Object. It binds a target class, an invoke callback that names the RPC, and a sharding function.',
          stage: ['worker', 'client', 'focus:client'],
          source: sourceFocus(
            clientConfig,
            'export const routing = DurabilityRouting.client({',
            'invoke: (stub, batch: Batch) => stub.enqueue(batch),'
          ),
          durable: 'Nothing. The routing client has no storage.',
          volatile:
            'Observations and the shard width exist per isolate; another isolate starts empty.',
          status: 'normal',
        },
        {
          id: 'push',
          title: 'The fetch handler pushes a batch',
          description:
            'The lane transform contributes { lane: "vip" } as caller context and timeout bounds the wait. Context is passed to sharding only; it is not sent to the object.',
          stage: ['flow:push'],
          source: sourceFocus(
            fetchHandler,
            'const result = await routing',
            '.push({ messages });'
          ),
          durable: 'Nothing is written until an object accepts the batch.',
          volatile: 'The batch and its context in the request.',
          status: 'normal',
        },
        {
          id: 'choose',
          title: 'Choose exactly one shard',
          description:
            'Custom sharding receives the input, the context, and the unexpired observations. This example returns the lane or the customer key, plus a location hint from the first message.',
          stage: ['focus:client'],
          source: sourceFocus(
            push,
            'const observed = this.observations();',
            'const address = typeof target === '
          ),
          durable: 'Nothing.',
          volatile: 'The address for this push only.',
          status: 'normal',
        },
        {
          id: 'namespace',
          title: 'Find the namespace for your class',
          description:
            'An explicit namespace() wins. Otherwise the client looks up exportName, which the Vite plugin injects, in the Worker’s own exports from cloudflare:workers. No binding or generated class is involved.',
          stage: ['focus:client'],
          source: sourceFocus(
            resolve,
            'const namespace = config.namespace?.();',
            'return exported as DurableObjectNamespace<Target>;'
          ),
          durable: 'Nothing.',
          volatile: 'The resolved namespace for this push.',
          status: 'normal',
        },
        {
          id: 'stub',
          title: 'Get a stub for the shard key',
          description:
            'getByName() addresses one object by the shard key and invoke() makes the RPC. The location hint only affects where a new object is first placed, not an existing one.',
          stage: ['shard', 'shard-object', 'focus:shard'],
          source: sourceFocus(
            stub,
            'const namespace = resolveNamespace(',
            'return config.invoke(stub, input);'
          ),
          durable: 'The object and its storage exist independently of routing.',
          volatile: 'The stub is created per push.',
          status: 'normal',
        },
        {
          id: 'begin',
          title: 'The object starts measuring the call',
          description:
            'EmailDelivery.enqueue() hands the batch to fanout, which calls routing.begin("inbound") before validating it. That only increments an in-memory counter.',
          stage: ['fanout', 'load', 'focus:load'],
          source: sourceFocus(
            loadState,
            'begin(direction: Direction): () => void {',
            'this.active[direction] += 1;'
          ),
          durable: 'Nothing yet.',
          volatile: 'The inbound in-flight count and the start time.',
          status: 'normal',
        },
        {
          id: 'accept',
          title: 'Accept the batch in the object’s storage',
          description:
            'Fanout writes one manifest row per message and one pending delivery row per target inside the scheduler transaction, which also sets the object alarm. Routing takes no part in this write.',
          stage: ['deliveries', 'focus:deliveries'],
          source: sourceFocus(
            enqueue,
            'registered = await this.#transaction((sql) => {',
            'this.#adjustPending(1);'
          ),
          durable:
            'Manifest and delivery rows, and the alarm that will deliver them.',
          volatile: 'A cached count of pending deliveries.',
          status: 'commit',
        },
        {
          id: 'snapshot',
          title: 'Attach a load snapshot to the reply',
          description:
            'The reply carries a snapshot: pendingDeliveries from the durable rows, plus in-flight counts and average timings from the last 60 seconds of in-memory buckets.',
          stage: ['focus:load'],
          source: sourceFocus(
            snapshot,
            'const now = Date.now();',
            'pendingDeliveries,'
          ),
          durable: 'The pending count reflects committed rows.',
          volatile: 'Timings and in-flight counts.',
          status: 'normal',
        },
        {
          id: 'observe',
          title: 'Remember the shard’s load in the isolate',
          description:
            'The client stores the snapshot under the shard key unless it already has a newer one, and drops the oldest entry past 1,024 shards. A success: false result is returned unchanged, not retried.',
          stage: ['flow:observe'],
          source: sourceFocus(
            push,
            'const response = await this.#config.invoke(address, input);',
            'return response;'
          ),
          durable: 'Nothing. Observations are advisory.',
          volatile:
            'The observation, until it is older than its 60-second window.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'default-sharding',
      title: 'Default sharding',
      description:
        'What the client does when no sharding function is given: compare two random shards and adjust how many it spreads over.',
      steps: [
        {
          id: 'sample',
          title: 'Sample two candidate shards',
          description:
            'The client draws two keys of the form shard-n from its current width, which starts at 1. A candidate it has no fresh observation for is chosen first.',
          stage: ['*', 'focus:client'],
          source: sourceFocus(
            select,
            'const first = `shard-${Math.floor(Math.random() * this.#width)}`;',
            'return !a ? first : second;'
          ),
          durable: 'Nothing.',
          volatile: 'The width and the observations in this isolate.',
          status: 'normal',
        },
        {
          id: 'compare',
          title: 'Compare backlog, then processing pressure',
          description:
            'The shard with fewer pending deliveries wins. On a tie, in-flight work weighted by average processing time decides.',
          stage: ['focus:load'],
          source: sourceFocus(
            select,
            'if (a.outbound.pendingDeliveries !== b.outbound.pendingDeliveries) {',
            'return pressure(a) <= pressure(b) ? first : second;'
          ),
          durable: 'The backlog figures came from the shards’ rows.',
          volatile: 'The timing figures came from the shards’ memory.',
          status: 'normal',
        },
        {
          id: 'widen',
          title: 'Widen under backlog',
          description:
            'When a fresh reply reports more pending deliveries than softBacklogLimit (1,000 by default), the client adds a shard, at most once per second.',
          stage: ['other', 'focus:other'],
          source: sourceFocus(
            resize,
            'load.outbound.pendingDeliveries > this.#limit &&',
            'return;'
          ),
          durable: 'A new shard key creates a new object with empty tables.',
          volatile: 'The wider range in this isolate.',
          status: 'normal',
        },
        {
          id: 'narrow',
          title: 'Narrow slowly when idle',
          description:
            'The width drops by one only after a full window without a resize, when the backlog is below a quarter of the limit and nothing is in flight. Work already accepted stays in its shard.',
          stage: ['focus:client'],
          source: sourceFocus(
            resize,
            'this.#width > 1 &&',
            'this.#width -= 1;'
          ),
          durable: 'Rows in the dropped shard remain and are still delivered.',
          volatile: 'The narrower range in this isolate.',
          status: 'normal',
        },
      ],
    },
    {
      id: 'failure',
      title: 'Evict a shard and lose a reply',
      description:
        'What survives an eviction, and why a retry is only as safe as the shard key and message IDs it reuses.',
      steps: [
        {
          id: 'evicted',
          title: 'Eviction resets the telemetry',
          description:
            'The load observer is a field of your class, constructed with each instance and handed to fanout. When the object is evicted its counters and buckets go too; the next instance reports no completions and null averages until work arrives.',
          stage: ['*', 'focus:load'],
          source: sourceFocus(
            emailDelivery,
            'private readonly routing = new DurabilityRouting();',
            'routing: this.routing,'
          ),
          durable: 'Manifest and delivery rows, and the object alarm.',
          volatile:
            'In-flight counts, timing buckets, and the cached pending count.',
          status: 'failure',
        },
        {
          id: 'recount',
          title: 'The backlog is recounted from SQLite',
          description:
            'The cached pending count is undefined in a new instance, so the first snapshot runs COUNT(*) over pending delivery rows. Backlog is never rebuilt from telemetry.',
          stage: ['focus:deliveries'],
          source: sourceFocus(
            pendingRows,
            'this.#pending ??= countRowSchema.parse(',
            "WHERE status = 'pending'`"
          ),
          durable: 'The count matches the committed rows.',
          volatile: 'The count is cached again in the new instance.',
          status: 'recovery',
        },
        {
          id: 'reply-lost',
          title: 'The reply is lost after the commit',
          description:
            'Assume the shard commits the batch, but the RPC fails or the timeout transform rejects first. push() throws before recording an observation; routing stores no retry intent and does not try another shard.',
          stage: ['flow:push'],
          source: sourceFocus(
            push,
            'const response = await this.#config.invoke(address, input);'
          ),
          durable: 'The batch may already be committed in the shard.',
          volatile: 'The caller only sees an error.',
          status: 'failure',
        },
        {
          id: 'stable-retry',
          title: 'A stable retry reaches the same rows',
          description:
            'Redrive takes the message ID and deduplication key from the parked entry and, without a lane, sharding picks the customer’s shard. Running it again after a lost reply reaches the same object, whose manifest row makes the repeated key a no-op.',
          stage: ['focus:shard'],
          source: sourceFocus(
            redrive,
            'const result = await routing.push({',
            'options: { targets: [entry.target] },'
          ),
          durable: 'The existing manifest row deduplicates the message.',
          volatile: 'Nothing from the first push is needed.',
          status: 'recovery',
        },
        {
          id: 'fresh-ids',
          title: 'Fresh IDs are new work',
          description:
            'The fetch handler sends bodies without IDs, so fanout generates a random ID for each message. Retrying that request enqueues the emails again, even on the same shard.',
          stage: ['focus:worker'],
          source: sourceFocus(
            fetchHandler,
            'const messages = (await request.json<Email[]>()).map((body) => ({ body }));'
          ),
          durable: 'A second set of rows with new IDs.',
          volatile: 'The caller cannot tell whether the first push committed.',
          status: 'gap',
        },
        {
          id: 'other-shard',
          title: 'Another shard has no record',
          description:
            'If a retry selects a different shard, as default sharding can, that object’s tables have never seen the key and accept the message again. Deduplication holds only within one object.',
          stage: ['other', 'flow:retry'],
          source: sourceFocus(
            select,
            'const first = `shard-${Math.floor(Math.random() * this.#width)}`;',
            'const second = `shard-${Math.floor(Math.random() * this.#width)}`;'
          ),
          durable: 'Both shards may hold the same message.',
          volatile: 'Nothing coordinates the shards.',
          status: 'gap',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
