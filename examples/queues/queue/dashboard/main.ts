import { api } from './api';
import type { QueueSummary } from '../src/model';
import {
  compact,
  element,
  errorMessage,
  numberField,
  perSecond,
  textField,
} from './dom';
import {
  field,
  handleSubmit,
  limitModeChoices,
  namePattern,
  numberInput,
} from './forms';
import { maxPartitions } from './forms';
import { loadTestSection } from './load';
import { showQueue } from './queue';

const root = document.querySelector<HTMLElement>('#app') ?? document.body;
let leavePage: (() => void) | undefined;

const createQueueForm = (): HTMLFormElement => {
  const notice = element('p', { class: 'notice' });
  const form = element(
    'form',
    { class: 'stack' },
    element(
      'div',
      { class: 'inline' },
      field(
        'Name',
        element('input', {
          name: 'name',
          required: true,
          pattern: namePattern,
          placeholder: 'orders',
        }),
        'Lowercase letters, digits, - or _'
      ),
      field(
        'Min partitions',
        numberInput('min', { min: 1, max: maxPartitions, value: 1 })
      ),
      field(
        'Max partitions',
        numberInput('max', { min: 1, max: maxPartitions, placeholder: 'none' }),
        'Empty means no limit'
      ),
      field(
        'Max concurrency',
        numberInput('maxConcurrency', { min: 1, placeholder: 'none' }),
        'Batches in flight; empty means no limit'
      )
    ),
    limitModeChoices(),
    element(
      'div',
      { class: 'actions' },
      element('button', { type: 'submit' }, 'Create queue')
    ),
    notice
  );

  handleSubmit(form, notice, async () => {
    const name = textField(form, 'name');
    await api('POST', '/api/queues', {
      name,
      settings: {
        partitions: {
          min: numberField(form, 'min') ?? 1,
          max: numberField(form, 'max') ?? null,
        },
        maxConcurrency: numberField(form, 'maxConcurrency') ?? null,
        limitMode: textField(form, 'limitMode') === 'fast' ? 'fast' : 'strict',
      },
    });
    location.hash = `#/queues/${encodeURIComponent(name)}`;
    return `Created ${name}`;
  });
  return form;
};

const refreshMs = 5_000;

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

/** Every queue at once: totals, then a row for each. */
const allQueues = (summaries: QueueSummary[]): HTMLElement[] => {
  if (summaries.length === 0) {
    return [element('p', { class: 'hint' }, 'No queues yet.')];
  }
  const total = (pick: (summary: QueueSummary) => number): number =>
    summaries.reduce((all, summary) => all + pick(summary), 0);
  const resizing = summaries.filter((summary) => summary.epochs > 1).length;
  const number = (value: string): HTMLElement =>
    element('td', { class: 'number' }, value);
  return [
    element(
      'div',
      { class: 'tiles' },
      tile('Queues', compact(summaries.length)),
      tile(
        'Partitions',
        compact(total((summary) => summary.partitions)),
        resizing === 0 ? undefined : `${resizing} queues draining older ones`
      ),
      tile(
        'Accepted',
        perSecond(total((summary) => summary.acceptedPerSecond))
      ),
      tile(
        'Delivered',
        perSecond(total((summary) => summary.deliveredPerSecond))
      ),
      tile('Backlog', compact(total((summary) => summary.backlog))),
      tile(
        'Rejected',
        perSecond(total((summary) => summary.rejectedPerSecond))
      ),
      tile('Dead letters', compact(total((summary) => summary.deadLettered)))
    ),
    element(
      'div',
      { class: 'table-wrap' },
      element(
        'table',
        {},
        element(
          'thead',
          {},
          element(
            'tr',
            {},
            element('th', {}, 'Name'),
            ...[
              'Partitions',
              'Accepted',
              'Delivered',
              'Backlog',
              'Rejected',
            ].map((heading) => element('th', { class: 'number' }, heading))
          )
        ),
        element(
          'tbody',
          {},
          summaries.map((summary) =>
            element(
              'tr',
              {},
              element(
                'td',
                {},
                element(
                  'a',
                  {
                    href: `#/queues/${encodeURIComponent(summary.queue)}`,
                    class: 'mono',
                  },
                  summary.queue
                )
              ),
              number(
                summary.epochs > 1
                  ? `${summary.partitions} (${summary.epochs - 1} draining)`
                  : String(summary.partitions)
              ),
              number(perSecond(summary.acceptedPerSecond)),
              number(perSecond(summary.deliveredPerSecond)),
              number(compact(summary.backlog)),
              number(perSecond(summary.rejectedPerSecond))
            )
          )
        )
      )
    ),
  ];
};

const showQueueList = async (): Promise<void> => {
  const list = element(
    'div',
    { class: 'stack' },
    element('p', { class: 'hint' }, 'Loading...')
  );
  root.replaceChildren(
    element('header', { class: 'page-header' }, element('h1', {}, 'Queues')),
    element('section', { class: 'card' }, list),
    element(
      'section',
      { class: 'card' },
      element('h2', {}, 'Create a queue'),
      createQueueForm()
    )
  );

  const refresh = async (): Promise<void> => {
    const summaries = (await api('GET', '/api/summary')) as QueueSummary[];
    // load-10 after load-9, not after load-1.
    summaries.sort((a, b) =>
      a.queue.localeCompare(b.queue, undefined, { numeric: true })
    );
    list.replaceChildren(...allQueues(summaries));
  };
  const [loadTest] = await Promise.all([loadTestSection(), refresh()]);
  // The page may have been left while those were on their way.
  if (location.hash.startsWith('#/queues/') || location.hash === '#/load') {
    loadTest?.stop();
    return;
  }
  if (loadTest) {
    root.appendChild(loadTest.element);
  }
  const timer = setInterval(() => {
    refresh().catch(() => undefined);
  }, refreshMs);
  leavePage = () => {
    clearInterval(timer);
    loadTest?.stop();
  };
};

/** The load test on a page of its own, which the API's `url` points at. */
const showLoadTest = async (): Promise<void> => {
  root.replaceChildren(
    element(
      'header',
      { class: 'page-header' },
      element('a', { href: '#/' }, 'Queues'),
      element('h1', {}, 'Load test')
    )
  );
  const loadTest = await loadTestSection();
  if (location.hash !== '#/load') {
    loadTest?.stop();
    return;
  }
  if (!loadTest) {
    root.appendChild(
      element(
        'p',
        { class: 'notice error' },
        'This queue has no load generator bound.'
      )
    );
    return;
  }
  root.appendChild(loadTest.element);
  leavePage = loadTest.stop;
};

function route(): void {
  leavePage?.();
  leavePage = undefined;

  if (location.hash === '#/load') {
    showLoadTest().catch((error: unknown) => {
      root.appendChild(
        element('p', { class: 'notice error' }, errorMessage(error))
      );
    });
    return;
  }

  const match = /^#\/queues\/([^/]+)$/.exec(location.hash);
  if (match?.[1] !== undefined) {
    leavePage = showQueue(root, decodeURIComponent(match[1]));
    return;
  }
  showQueueList().catch((error: unknown) => {
    root.appendChild(
      element('p', { class: 'notice error' }, errorMessage(error))
    );
  });
}

window.addEventListener('hashchange', route);
route();
