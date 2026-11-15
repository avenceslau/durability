import type { Overview, PartitionTarget } from '../src/model';
import { compact, element, perSecond } from './dom';
import { latestTotals, recentRate, settledCounter } from './metrics';
import { describeDestination } from './sections';

type TargetCells = Record<
  | 'state'
  | 'backlog'
  | 'inFlight'
  | 'rate'
  | 'retries'
  | 'deadLettered'
  | 'error',
  HTMLTableCellElement
>;

export type TargetActions = {
  pause: (name: string, paused: boolean) => Promise<unknown>;
  edit: (name: string, target: PartitionTarget) => void;
  redrive: (name: string) => Promise<unknown>;
  remove: (name: string) => Promise<unknown>;
  report: (error: unknown) => void;
};

const headings = [
  'Name',
  'Destination',
  'State',
  'Backlog',
  'In flight',
  'Delivered',
  'Retries',
  'Dead letters',
  'Last error',
  '',
];

const newestError = (overview: Overview, name: string): string | undefined =>
  overview.partitions
    .filter((sample) => sample.targets[name]?.lastError !== undefined)
    .sort((left, right) => right.at - left.at)[0]?.targets[name]?.lastError;

/**
 * Rows are rebuilt only when the targets themselves change; live updates
 * rewrite the number cells, so a click is never lost to a re-render.
 */
export const targetsTable = (
  actions: TargetActions
): {
  element: HTMLElement;
  render: (overview: Overview) => void;
} => {
  const container = element('div', { class: 'table-wrap' });
  const cellsByTarget = new Map<string, TargetCells>();
  let signature = '';

  const button = (
    label: string,
    action: () => Promise<unknown>,
    className = 'secondary'
  ): HTMLButtonElement =>
    element(
      'button',
      {
        type: 'button',
        class: className,
        onclick: () => void action().catch(actions.report),
      },
      label
    );

  const row = (name: string, target: PartitionTarget): HTMLTableRowElement => {
    const cells: TargetCells = {
      state: element('td'),
      backlog: element('td', { class: 'number' }),
      inFlight: element('td', { class: 'number' }),
      rate: element('td', { class: 'number' }),
      retries: element('td', { class: 'number' }),
      deadLettered: element('td', { class: 'number' }),
      error: element('td', { class: 'error-text' }),
    };
    cellsByTarget.set(name, cells);

    return element(
      'tr',
      {},
      element('td', { class: 'mono' }, name),
      element(
        'td',
        { class: 'destination' },
        describeDestination(target.destination)
      ),
      cells.state,
      cells.backlog,
      cells.inFlight,
      cells.rate,
      cells.retries,
      cells.deadLettered,
      cells.error,
      element(
        'td',
        { class: 'row-actions' },
        // The queue's own pull target is switched in the settings, not here.
        ...(target.destination.type === 'pull'
          ? []
          : [
              button(target.paused ? 'Resume' : 'Pause', () =>
                actions.pause(name, !target.paused)
              ),
              button('Edit', async () => actions.edit(name, target)),
            ]),
        button('Redrive', () => actions.redrive(name)),
        ...(target.destination.type === 'pull'
          ? []
          : [button('Delete', () => actions.remove(name), 'danger')])
      )
    );
  };

  const build = (overview: Overview): void => {
    cellsByTarget.clear();
    const names = Object.keys(overview.targets).sort();
    if (names.length === 0) {
      container.replaceChildren(
        element(
          'p',
          { class: 'hint' },
          'No targets yet. Messages are kept until a target reads them.'
        )
      );
      return;
    }

    container.replaceChildren(
      element(
        'table',
        {},
        element(
          'thead',
          {},
          element(
            'tr',
            {},
            headings.map((heading) => element('th', {}, heading))
          )
        ),
        element(
          'tbody',
          {},
          names.map((name) => row(name, overview.targets[name]!))
        )
      )
    );
  };

  const render = (overview: Overview): void => {
    const newestEpoch = overview.epochs.at(-1)?.epoch ?? 0;
    const nextSignature = JSON.stringify([overview.targets, newestEpoch]);
    if (nextSignature !== signature) {
      signature = nextSignature;
      build(overview);
    }

    const totals = latestTotals(overview);
    for (const [name, cells] of cellsByTarget) {
      const target = overview.targets[name];
      if (!target) {
        continue;
      }
      const total = totals[name];
      const lastError = newestError(overview, name) ?? '';

      if (target.paused) {
        cells.state.textContent = 'paused';
      } else if (target.deliverFromEpoch < newestEpoch) {
        cells.state.textContent = `draining epoch ${target.deliverFromEpoch}`;
      } else {
        cells.state.textContent = 'running';
      }
      cells.backlog.textContent = compact(total?.pending ?? 0);
      cells.inFlight.textContent = compact(total?.inFlight ?? 0);
      cells.rate.textContent = perSecond(
        recentRate(overview.points, settledCounter(name))
      );
      cells.retries.textContent = compact(total?.retries ?? 0);
      cells.deadLettered.textContent = compact(total?.deadLettered ?? 0);
      cells.error.textContent = lastError;
      cells.error.title = lastError;
    }
  };

  return { element: container, render };
};
