import type { Destination, Overview, PartitionSample } from '../src/model';
import { compact, dateTime, element, perSecond } from './dom';
import {
  acceptedCounter,
  latestTotals,
  recentRate,
  settledCounter,
  slowestTarget,
} from './metrics';

export const describeDestination = (destination: Destination): string => {
  if (destination.type === 'webhook') {
    return `webhook ${destination.url}`;
  }
  if (destination.type === 'service') {
    return `service ${destination.binding}`;
  }
  if (destination.type === 'queue') {
    return `queue ${destination.queue}`;
  }
  return 'archive';
};

const tile = (label: string, value: string, detail?: string): HTMLElement =>
  element(
    'div',
    { class: 'tile' },
    element('span', { class: 'tile-label' }, label),
    element('strong', { class: 'tile-value' }, value),
    detail === undefined
      ? null
      : element('span', { class: 'tile-detail' }, detail)
  );

/**
 * Delivery numbers come from the target with the largest backlog: summing
 * targets would count each message once per target.
 */
export const statTiles = (overview: Overview): HTMLElement[] => {
  const totals = latestTotals(overview);
  const slowest = slowestTarget(totals);
  const slowestTotals = slowest === undefined ? undefined : totals[slowest];
  const last = overview.points.at(-1);
  const all = Object.values(totals);

  const tiles = [
    tile('Accepted', perSecond(recentRate(overview.points, acceptedCounter))),
    tile(
      'Delivered',
      slowest === undefined
        ? '-'
        : perSecond(recentRate(overview.points, settledCounter(slowest))),
      slowest === undefined ? 'no targets' : `slowest: ${slowest}`
    ),
    tile(
      'Backlog',
      slowestTotals === undefined ? '-' : compact(slowestTotals.pending),
      slowest === undefined ? 'no targets' : `slowest: ${slowest}`
    ),
    tile(
      'In flight',
      compact(all.reduce((sum, target) => sum + target.inFlight, 0)),
      'all targets'
    ),
    tile(
      'Dead letters',
      compact(all.reduce((sum, target) => sum + target.deadLettered, 0)),
      'all targets'
    ),
    tile(
      'Rejected',
      last === undefined ? '-' : compact(last.rejected),
      'total'
    ),
  ];

  if (last?.permits) {
    tiles.push(
      tile(
        'Permits',
        `${compact(last.permits.granted)} / ${compact(last.permits.limit)}`,
        `${compact(last.permits.blocked)} blocked`
      )
    );
  }
  return tiles;
};

const largestBacklog = (sample: PartitionSample): number =>
  Math.max(
    0,
    ...Object.values(sample.targets).map(
      (progress) => sample.accepted - progress.settled
    )
  );

const backlogLevel = (backlog: number): number => {
  if (backlog === 0) {
    return 0;
  }
  if (backlog < 100) {
    return 1;
  }
  if (backlog < 1_000) {
    return 2;
  }
  if (backlog < 10_000) {
    return 3;
  }
  return 4;
};

const partitionTitle = (
  epoch: number,
  index: number,
  sample: PartitionSample | undefined
): string => {
  const heading = `Epoch ${epoch}, partition ${index}`;
  if (!sample) {
    return `${heading}\nNo sample yet`;
  }
  const lines = [heading, `Accepted ${compact(sample.accepted)}`];
  if (!sample.accepting) {
    lines.push('Not accepting');
  }
  for (const [name, progress] of Object.entries(sample.targets)) {
    lines.push(
      `${name}: backlog ${compact(sample.accepted - progress.settled)}`
    );
  }
  return lines.join('\n');
};

export const partitionGrid = (overview: Overview): HTMLElement => {
  const samples = new Map(
    overview.partitions.map((sample) => [
      `${sample.epoch}/${sample.index}`,
      sample,
    ])
  );
  const newest = overview.epochs.at(-1)?.epoch;

  return element(
    'div',
    { class: 'partitions' },
    overview.epochs.map((layout) =>
      element(
        'div',
        { class: 'epoch' },
        element(
          'span',
          { class: 'epoch-label' },
          `Epoch ${layout.epoch} · ${layout.count} · ${layout.epoch === newest ? 'accepting' : 'draining'}`
        ),
        element(
          'div',
          { class: 'cells' },
          Array.from({ length: layout.count }, (_, index) => {
            const sample = samples.get(`${layout.epoch}/${index}`);
            const level = sample ? backlogLevel(largestBacklog(sample)) : 0;
            return element('span', {
              class: `cell level-${level}${sample?.accepting === false ? ' not-accepting' : ''}${sample ? '' : ' missing'}`,
              title: partitionTitle(layout.epoch, index, sample),
            });
          })
        )
      )
    ),
    element(
      'p',
      { class: 'hint' },
      'Colour shows the backlog of the slowest target in each partition: none, under 100, 1k, 10k, more. Striped cells were replaced by a resize and only deliver.'
    )
  );
};

export const limiterTable = (overview: Overview): HTMLElement => {
  const { active, draining, shares, samples } = overview.limiters;
  const names = [...active, ...draining];
  if (names.length === 0) {
    return element('p', { class: 'hint' }, 'No limiters are running yet.');
  }

  return element(
    'table',
    {},
    element(
      'thead',
      {},
      element(
        'tr',
        {},
        ['Limiter', 'State', 'Share', 'Granted', 'Blocked', 'Requests/s'].map(
          (label) => element('th', {}, label)
        )
      )
    ),
    element(
      'tbody',
      {},
      names.map((name) => {
        const sample = samples.find((entry) => entry.limiter === name);
        const isDraining = draining.includes(name);
        return element(
          'tr',
          { class: isDraining ? 'muted' : null },
          element('td', { class: 'mono' }, name),
          element('td', {}, isDraining ? 'draining' : 'active'),
          element('td', { class: 'number' }, compact(shares[name] ?? 0)),
          element(
            'td',
            { class: 'number' },
            sample ? compact(sample.granted) : '-'
          ),
          element(
            'td',
            { class: 'number' },
            sample ? compact(sample.blocked) : '-'
          ),
          element(
            'td',
            { class: 'number' },
            sample ? perSecond(sample.requestsPerSecond) : '-'
          )
        );
      })
    )
  );
};

export const eventList = (overview: Overview): HTMLElement => {
  if (overview.events.length === 0) {
    return element('p', { class: 'hint' }, 'No events yet.');
  }
  return element(
    'ol',
    { class: 'events' },
    overview.events.map((entry) =>
      element(
        'li',
        {},
        element(
          'time',
          { datetime: new Date(entry.at).toISOString() },
          dateTime(entry.at)
        ),
        element('span', { class: `badge kind-${entry.kind}` }, entry.kind),
        element('span', {}, entry.detail)
      )
    )
  );
};
