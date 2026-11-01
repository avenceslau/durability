import eventStreamSource from '../../../examples/event-topics/worker.ts?raw';
import {
  sourceExcerpt,
  sourceFocus,
  validateWalkthrough,
  type ArchitectureWalkthrough,
} from '../lib/architecture';

const file = 'examples/event-topics/worker.ts';

const logStorage = sourceExcerpt(
  eventStreamSource,
  file,
  'log-storage',
  'Hot log and cold segments',
  '  private readonly log = new DurabilityLog<Event>({',
  '  });'
);
const retention = sourceExcerpt(
  eventStreamSource,
  file,
  'retention',
  'Retention alarm and append guard',
  '  // Retention needs a schedule, and a named alarm is that schedule.',
  '    return result;\n  }'
);
const cursor = sourceExcerpt(
  eventStreamSource,
  file,
  'cursor',
  'Consumer cursor and commit',
  "  /**\n   * Consumers pull. A group's cursor is the only thing that advances, and a",
  '  }\n\n  cursors() {'
);
const handler = sourceExcerpt(
  eventStreamSource,
  file,
  'handler',
  'Consumer handler and producer routing',
  "/**\n * Stands in for the consumer's real work. Records arrive in offset order",
  '});'
);
const polling = sourceExcerpt(
  eventStreamSource,
  file,
  'polling',
  'Read, handle, then commit',
  '    // Each partition is polled independently: a slow group never blocks others.',
  '    return Response.json(pages);'
);

export const eventStreamWalkthrough = validateWalkthrough({
  id: 'event-stream',
  title: 'Partitioned durable event stream',
  summary:
    'A routed partition persists its log and group cursors; consumers read a page, do work, and commit only after that work succeeds.',
  width: 900,
  height: 540,
  nodes: [
    {
      id: 'producer',
      title: 'Producer',
      kind: 'compute',
      description:
        'The HTTP worker groups an input batch by topic partition before pushing it.',
      href: '/primitives/routing',
      x: 150,
      y: 80,
    },
    {
      id: 'routing',
      title: 'Topic routing',
      kind: 'compute',
      description:
        'A topic and partition key select one Partition Durable Object.',
      href: '/primitives/routing',
      x: 450,
      y: 80,
    },
    {
      id: 'partition',
      title: 'Partition object',
      kind: 'durable',
      description:
        'The Durable Object composes routing, scheduling, retained-log, and cursor state for one partition.',
      href: '/primitives/log',
      x: 750,
      y: 80,
    },
    {
      id: 'hot-log',
      title: 'Hot log and cursors',
      kind: 'durable',
      description:
        'DurabilityLog retains the hot records and the durable per-group cursor that commit advances.',
      href: '/primitives/log',
      x: 750,
      y: 290,
    },
    {
      id: 'alarms',
      title: 'Named retention alarm',
      kind: 'durable',
      description:
        'A named alarm schedules retention work; its pending schedule is durable scheduler state.',
      href: '/primitives/alarms',
      x: 450,
      y: 290,
    },
    {
      id: 'cold',
      title: 'Cold R2 segments',
      kind: 'external',
      description:
        'Flushed retained segments live in R2 and are read back for consumers behind the hot window.',
      href: '/primitives/log',
      x: 150,
      y: 480,
    },
    {
      id: 'handler',
      title: 'Consumer work',
      kind: 'external',
      description:
        'The example handler only logs records; it stands in for real downstream work that must tolerate replay.',
      href: '/primitives/log',
      x: 750,
      y: 480,
    },
  ],
  edges: [
    {
      id: 'select',
      from: 'producer',
      to: 'routing',
      label: 'group and push events',
    },
    {
      id: 'append',
      from: 'routing',
      to: 'partition',
      label: 'append to selected partition',
    },
    {
      id: 'persist',
      from: 'partition',
      to: 'hot-log',
      label: 'persist retained records',
    },
    {
      id: 'schedule',
      from: 'partition',
      to: 'alarms',
      label: 'register retention alarm',
    },
    { id: 'trim', from: 'alarms', to: 'hot-log', label: 'trim hot window' },
    {
      id: 'flush',
      from: 'hot-log',
      to: 'cold',
      label: 'write flushed segment',
    },
    {
      id: 'cold-read',
      from: 'cold',
      to: 'hot-log',
      label: 'read older segment',
    },
    {
      id: 'read',
      from: 'hot-log',
      to: 'handler',
      label: 'read page at cursor',
    },
    {
      id: 'commit',
      from: 'handler',
      to: 'hot-log',
      label: 'commit next offset',
    },
  ],
  excerpts: [logStorage, retention, cursor, handler, polling],
  scenarios: [
    {
      id: 'read-handle-commit',
      title: 'Read, handle, commit',
      description:
        'The page read is separate from cursor advancement, so the handler is always before the durable commit.',
      steps: [
        {
          id: 'read',
          title: 'Read from the group cursor',
          description:
            'A new group starts at the oldest readable offset. When that is below the hot window, the log can serve the page from cold storage.',
          nodes: ['partition', 'hot-log', 'cold', 'handler'],
          edges: ['cold-read', 'read'],
          source: sourceFocus(
            cursor,
            '  const from =',
            '  return this.log.read({ from, limit });'
          ),
          durable:
            'The group cursor is unchanged; the log and any cold segment index remain durable.',
          volatile: 'The returned page is held by the polling request.',
          status: 'normal',
        },
        {
          id: 'handle',
          title: 'Perform consumer work',
          description:
            'The endpoint passes the page to the handler before it commits its next offset.',
          nodes: ['handler'],
          edges: ['read'],
          source: sourceFocus(polling, '    await handle(page.records);'),
          durable: 'No cursor movement has been persisted.',
          volatile: "The handler is performing this page's work.",
          status: 'normal',
        },
        {
          id: 'commit',
          title: 'Advance the cursor',
          description:
            'Only a completed handler call is followed by the partition commit.',
          nodes: ['handler', 'hot-log'],
          edges: ['commit'],
          source: sourceFocus(
            polling,
            '    await stub.commit(group, page.nextOffset);'
          ),
          durable: 'The group cursor advances to the page nextOffset.',
          volatile: 'The response can now report the handled count.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'crash-before-commit',
      title: 'Crash after work, before commit',
      description:
        'The replay protects against silently skipping work, but downstream work must be idempotent because this example has no external deduplication layer.',
      steps: [
        {
          id: 'page',
          title: 'Read the pending page',
          description:
            'The cursor identifies the same starting page until a commit occurs.',
          nodes: ['hot-log', 'handler'],
          edges: ['read'],
          source: sourceFocus(
            polling,
            '    const page = await stub.consume(group, 100);'
          ),
          durable: 'The durable cursor still points at this page.',
          volatile: 'The polling request owns the page.',
          status: 'normal',
        },
        {
          id: 'effect',
          title: 'Finish the handler effect',
          description:
            'The handler can finish its downstream work before the cursor write begins.',
          nodes: ['handler'],
          edges: ['read'],
          source: sourceFocus(polling, '    await handle(page.records);'),
          durable: 'The cursor is still unchanged.',
          volatile:
            'The completed handler result exists only in this invocation.',
          status: 'normal',
        },
        {
          id: 'crash',
          title: 'Stop before commit',
          description:
            'A failure here loses the invocation state but leaves the cursor at the old offset.',
          nodes: ['handler', 'hot-log'],
          edges: ['commit'],
          source: sourceFocus(polling, '    await handle(page.records);'),
          durable: 'No nextOffset has been committed.',
          volatile:
            'The page and local knowledge of completion disappear; an external committed effect can remain.',
          status: 'failure',
        },
        {
          id: 'replay',
          title: 'Read the same page again',
          description:
            'The next poll reads from the unchanged cursor, replaying the page rather than skipping it.',
          nodes: ['hot-log', 'handler'],
          edges: ['read'],
          source: sourceFocus(
            cursor,
            '  return this.log.read({ from, limit });'
          ),
          durable: 'The same durable cursor selects the replayed records.',
          volatile: 'A new request holds the replay page.',
          status: 'recovery',
        },
        {
          id: 'settle',
          title: 'Commit after replay work',
          description:
            'After successful repeated work, commit advances the cursor.',
          nodes: ['handler', 'hot-log'],
          edges: ['commit'],
          source: sourceFocus(
            polling,
            '    await stub.commit(group, page.nextOffset);'
          ),
          durable: 'The cursor now records the page as consumed.',
          volatile: 'The replay request can complete.',
          status: 'commit',
        },
      ],
    },
    {
      id: 'retention',
      title: 'Retention scheduling and cold history',
      description:
        'Append registers retention once, trimming can flush readable history to R2, and the separate flag/alarm awaits leave an intentionally unrepaired crash gap.',
      steps: [
        {
          id: 'partition-key',
          title: 'Choose one partition for this push',
          description:
            'The custom shard function uses the first event. The fronting Worker must group the original input by partition before pushing; routing does not split this batch for it.',
          nodes: ['producer', 'routing', 'partition'],
          edges: ['select', 'append'],
          source: sourceFocus(
            handler,
            'const shard = `${first.topic}:${partitionFor(first.partitionKey)}`;'
          ),
          durable: 'Shard selection itself creates no durable record.',
          volatile: 'The batch and routing decision are local to the caller.',
          status: 'normal',
        },
        {
          id: 'append',
          title: 'Append to the hot log',
          description:
            'The partition appends the batch to its retained log before considering retention scheduling.',
          nodes: ['producer', 'routing', 'partition', 'hot-log'],
          edges: ['select', 'append', 'persist'],
          source: sourceFocus(
            retention,
            '  const result = await this.log.append(batch.events);'
          ),
          durable: 'Accepted records are in the partition log.',
          volatile: 'The append result is available to this object invocation.',
          status: 'commit',
        },
        {
          id: 'guard',
          title: 'Set the scheduling guard',
          description:
            'Only a successful append with no sweeping marker writes the durable guard and then requests the named alarm.',
          nodes: ['partition', 'alarms'],
          edges: ['schedule'],
          source: sourceFocus(
            retention,
            "  if (result.success && !(await this.ctx.storage.get<boolean>('sweeping'))) {",
            '    await this.alarms.enforceRetention(Date.now() + retentionSweepMs);'
          ),
          durable:
            'The sweeping marker and, on success, the alarm registration are durable state.',
          volatile:
            'This append invocation is deciding whether it owns scheduling.',
          status: 'normal',
        },
        {
          id: 'gap',
          title: 'Expose the non-atomic gap',
          description:
            'A crash after writing sweeping but before registering the alarm can leave the marker without a pending sweep. This source has no reconciliation repair for that state.',
          nodes: ['partition', 'alarms'],
          edges: ['schedule'],
          source: sourceFocus(
            retention,
            "    await this.ctx.storage.put('sweeping', true);"
          ),
          durable:
            'The sweeping marker may persist even though no alarm registration completed.',
          volatile:
            'The interrupted invocation and its planned alarm call are gone.',
          status: 'gap',
        },
        {
          id: 'trim',
          title: 'Trim and flush old hot records',
          description:
            'When an alarm does run, trim applies retention; the configured cold writer persists flushed segments in R2.',
          nodes: ['alarms', 'hot-log', 'cold'],
          edges: ['trim', 'flush'],
          source: sourceFocus(retention, '      await this.log.trim();'),
          durable:
            'Hot retention advances while flushed segment locators remain readable through the log.',
          volatile: 'The alarm handler is evaluating current bounds.',
          status: 'commit',
        },
        {
          id: 'cold-read',
          title: 'Read a flushed segment',
          description:
            'The cold callback fetches a segment when the log needs retained history outside its hot window.',
          nodes: ['cold', 'hot-log'],
          edges: ['cold-read'],
          source: sourceFocus(
            logStorage,
            '    read: async (locator) => {',
            '      return stored ? await stored.json<LogRecord<Event>[]>() : undefined;'
          ),
          durable:
            "The R2 segment and the log's cold reference remain durable.",
          volatile: 'The decoded records are temporary read results.',
          status: 'recovery',
        },
      ],
    },
  ],
} satisfies ArchitectureWalkthrough);
