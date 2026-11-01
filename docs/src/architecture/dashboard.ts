import pipelineSource from '../../../examples/job-dashboard/pipeline.ts?raw';
import dashboardSource from '../../../examples/job-dashboard/dashboard.ts?raw';
import clientSource from '../../../examples/job-dashboard/client.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture';

const operation = sourceExcerpt(
  pipelineSource,
  'examples/job-dashboard/pipeline.ts',
  'pipeline-operation',
  'Retained import operation and lifecycle results',
  '  private readonly durability = new Durability({',
  '    includeResults: true,\n  });'
);

const lifecycle = sourceExcerpt(
  pipelineSource,
  'examples/job-dashboard/pipeline.ts',
  'pipeline-lifecycle',
  'Best-effort lifecycle projection hook',
  '    this.durability.lifecycle((event) => {',
  '    });'
);

const enqueue = sourceExcerpt(
  pipelineSource,
  'examples/job-dashboard/pipeline.ts',
  'pipeline-enqueue',
  'Stable fanout delivery identity',
  '  private async publish(',
  '    ]);\n  }'
);

const ingest = sourceExcerpt(
  dashboardSource,
  'examples/job-dashboard/dashboard.ts',
  'dashboard-ingest',
  'SQL projection followed by socket publication',
  '  ingest(events: JobEvent[]): void {',
  '      this.socket.job(record);'
);

const clientSnapshot = sourceExcerpt(
  clientSource,
  'examples/job-dashboard/client.ts',
  'client-snapshot',
  'Browser snapshot reload and incremental events',
  '  const reload = async () => {',
  '  });'
);

export const dashboardWalkthrough: ArchitectureWalkthrough =
  validateWalkthrough({
    id: 'dashboard',
    title: 'Live dashboard projection',
    summary:
      'The Pipeline retains the authoritative import operation. A best-effort lifecycle hook stages a durable fanout delivery; Dashboard.ingest owns a separate SQL read model, and the browser rebuilds only from that projection.',
    width: 900,
    height: 420,
    nodes: [
      {
        id: 'operation',
        title: 'Pipeline import operation',
        source: 'pipeline-operation',
        kind: 'durable',
        description:
          'Authoritative retained import:<orderId> record and result.',
        href: '/primitives/operations/',
        x: 150,
        y: 80,
      },
      {
        id: 'lifecycle-hook',
        title: 'Lifecycle hook',
        source: 'pipeline-lifecycle',
        kind: 'memory',
        description:
          'Ephemeral callback that selects pending, completed, or failed projection state.',
        href: '/reference/lifecycle/',
        x: 450,
        y: 80,
      },
      {
        id: 'fanout',
        title: 'Fanout delivery',
        source: 'pipeline-enqueue',
        kind: 'durable',
        description:
          'Durable only after enqueue commits; retries delivery until ingest returns.',
        href: '/primitives/fanout/',
        x: 750,
        y: 80,
      },
      {
        id: 'dashboard-sql',
        title: 'Dashboard SQL',
        source: 'dashboard-ingest',
        kind: 'durable',
        description:
          'Persistent, non-authoritative jobs projection owned by Dashboard.',
        href: '/primitives/tracker/',
        x: 150,
        y: 300,
      },
      {
        id: 'socket',
        title: 'DurabilitySocket',
        source: 'dashboard-ingest',
        kind: 'durable',
        description:
          'Persists replayable job events before sending them to connected browsers.',
        href: '/primitives/socket/',
        x: 450,
        y: 300,
      },
      {
        id: 'browser',
        title: 'Browser client',
        source: 'client-snapshot',
        kind: 'external',
        description:
          'Volatile local map; reconnect resync replaces it from the Dashboard snapshot.',
        href: '/primitives/client/',
        x: 750,
        y: 300,
      },
    ],
    edges: [
      {
        id: 'settles',
        from: 'operation',
        to: 'lifecycle-hook',
        label: 'settles; include result',
      },
      {
        id: 'stages',
        from: 'lifecycle-hook',
        to: 'fanout',
        label: 'enqueue projection event',
      },
      {
        id: 'delivers',
        from: 'fanout',
        to: 'dashboard-sql',
        label: 'deliver to ingest; ack on return',
      },
      {
        id: 'publishes',
        from: 'dashboard-sql',
        to: 'socket',
        label: 'upsert then job event',
      },
      {
        id: 'pushes',
        from: 'socket',
        to: 'browser',
        label: 'replayable job event',
      },
      {
        id: 'snapshots',
        from: 'browser',
        to: 'dashboard-sql',
        label: 'work snapshot on resync',
      },
    ],
    excerpts: [operation, lifecycle, enqueue, ingest, clientSnapshot],
    scenarios: [
      {
        id: 'projection',
        title: 'Normal projection handoffs',
        description:
          'Each handoff has its own owner and durability boundary; the SQL view is not the Pipeline operation record.',
        steps: [
          {
            id: 'retained-operation',
            title: 'Expose operation results to the hook',
            description:
              'Durability owns the import operation and result. This option makes a completed summary visible to lifecycle callbacks; it does not itself register an import.',
            nodes: ['operation'],
            edges: ['settles'],
            source: sourceFocus(operation, '    includeResults: true,'),
            durable:
              'Pipeline retains the operation and its result under the stable import ID.',
            volatile:
              'No browser wait or lifecycle callback is retained as a subscription.',
            status: 'commit',
          },
          {
            id: 'lifecycle-selection',
            title: 'Select a projection state',
            description:
              'The hook maps the completed lifecycle event and its result into a completed JobEvent state.',
            nodes: ['operation', 'lifecycle-hook'],
            edges: ['settles', 'stages'],
            source: sourceFocus(
              lifecycle,
              '        event.result !== undefined',
              '        });'
            ),
            durable:
              'The operation has settled before this callback is invoked.',
            volatile:
              'The lifecycle callback itself is best-effort work in the Pipeline object.',
            status: 'normal',
          },
          {
            id: 'durable-fanout',
            title: 'Commit the fanout obligation',
            description:
              'The delivery ID includes operation ID, generation, and status, so a committed fanout message can be retried safely.',
            nodes: ['lifecycle-hook', 'fanout'],
            edges: ['stages', 'delivers'],
            source: sourceFocus(
              enqueue,
              '        id: `${event.id}:${event.generation}:${state.status}`,',
              '      },'
            ),
            durable:
              'After enqueue commits, fanout retains delivery until Dashboard.ingest returns without throwing.',
            volatile:
              'The hook call that initiated enqueue is not itself a durable handoff.',
            status: 'commit',
          },
          {
            id: 'sql-and-socket',
            title: 'Project, then publish',
            description:
              'ingest upserts Dashboard SQL and only then emits the socket job event. The same-generation predicate protects a settled row from a late pending event; a failed attempt row can therefore block a later completed row, and inequality between generations is not a freshness order.',
            nodes: ['fanout', 'dashboard-sql', 'socket'],
            edges: ['delivers', 'publishes'],
            source: sourceFocus(
              ingest,
              '        ON CONFLICT(id) DO UPDATE SET',
              '      this.socket.job(record);'
            ),
            durable:
              'The jobs table and socket event history are Dashboard-owned durable state, separate from Pipeline.',
            volatile:
              'Watcher callbacks and current socket connections are ephemeral.',
            status: 'commit',
          },
          {
            id: 'browser-snapshot',
            title: 'Render the SQL snapshot',
            description:
              'On resync the client pages work records, replaces its local map, then applies incremental job events.',
            nodes: ['dashboard-sql', 'socket', 'browser'],
            edges: ['snapshots', 'pushes'],
            source: sourceFocus(
              clientSnapshot,
              '      const page = await conn.rpc.work({ cursor });',
              '    } while (cursor !== undefined);'
            ),
            durable:
              'The snapshot comes from Dashboard SQL through its tracker records API.',
            volatile:
              'The browser Map is rebuilt and can be discarded at any time.',
            status: 'normal',
          },
        ],
      },
      {
        id: 'lost-projection',
        title: 'Lost projection before fanout commits',
        description:
          'This is a projection gap, not a failure of delivery after a fanout event has been committed.',
        steps: [
          {
            id: 'operation-settles',
            title: 'The operation settles first',
            description:
              'A completed operation has an authoritative retained result before the lifecycle hook tries to publish it.',
            nodes: ['operation', 'lifecycle-hook'],
            edges: ['settles'],
            source: sourceFocus(
              lifecycle,
              "        event.type === 'attempt_settled' &&",
              '        event.result !== undefined'
            ),
            durable: 'Pipeline has the completed operation result.',
            volatile:
              'The next lifecycle-to-fanout action has not committed yet.',
            status: 'failure',
          },
          {
            id: 'enqueue-gap',
            title: 'Eviction can lose the handoff',
            description:
              'If the object dies after settlement but before enqueue commits, there is no durable fanout event to retry. The source comment names this lifecycle hook as best-effort.',
            nodes: ['lifecycle-hook', 'fanout'],
            edges: ['stages'],
            source: sourceFocus(
              enqueue,
              '    await this.fanout.enqueue([',
              '    ]);'
            ),
            durable: 'No fanout registration exists in this failure window.',
            volatile:
              'The interrupted hook invocation disappears with the object.',
            status: 'gap',
          },
          {
            id: 'resync-is-projection-only',
            title: 'Resync reads only Dashboard state',
            description:
              'The client reacts to resync by calling work and rebuilding its map. It cannot repair the missing Pipeline event because work reads Dashboard SQL, where no row was ever ingested.',
            nodes: ['dashboard-sql', 'socket', 'browser'],
            edges: ['snapshots', 'pushes'],
            source: sourceFocus(
              clientSnapshot,
              '  conn.on.resync(() => void reload());'
            ),
            durable:
              'Existing Dashboard rows remain available, but the absent projection has no row or socket event.',
            volatile:
              'The reconnect and browser cache do not consult Pipeline operations.',
            status: 'recovery',
          },
          {
            id: 'reconciliation-needed',
            title: 'Reconciliation remains application work',
            description:
              'Production needs an explicit reconciliation process from authoritative Pipeline history into the projection. That process is not implemented by these source files.',
            nodes: ['operation', 'dashboard-sql'],
            edges: ['delivers'],
            source: sourceFocus(ingest, '      this.sql.exec(', '      );'),
            durable:
              'A reconciler would need to idempotently write a missing Dashboard row.',
            volatile:
              'No built-in client resync or fanout retry can invent an event that was never enqueued.',
            status: 'gap',
          },
        ],
      },
    ],
  } satisfies ArchitectureWalkthrough);
