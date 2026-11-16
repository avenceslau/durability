import type { LoadCounts, LoadOptions, LoadStatus } from '../src/load';
import { api } from './api';
import { compact, dateTime, element, numberField, perSecond } from './dom';
import { field, handleSubmit, numberInput } from './forms';

type Answer = { available: false } | ({ available: true } & LoadStatus);

const refreshMs = 2_000;

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

const tiles = (status: LoadStatus): HTMLElement[] => {
  const total = (pick: (counts: LoadCounts) => number): string =>
    `${compact(pick(status.totals))} in total`;
  return [
    tile(
      'Requests',
      perSecond(status.perSecond.requests),
      total((counts) => counts.requests)
    ),
    tile(
      'Messages accepted',
      perSecond(status.perSecond.accepted),
      total((counts) => counts.accepted)
    ),
    tile(
      'Messages rejected',
      perSecond(status.perSecond.rejected),
      total((counts) => counts.rejected)
    ),
    tile(
      'Requests failed',
      perSecond(status.perSecond.failed),
      total((counts) => counts.failed)
    ),
    tile(
      'Send latency',
      `${Math.round(status.latencyMs.average)} ms`,
      `${Math.round(status.latencyMs.max)} ms at most`
    ),
    tile('Generators', compact(status.generators)),
  ];
};

const describe = (status: LoadStatus): string => {
  if (status.phase === 'idle' || !status.options) {
    return 'No run yet.';
  }
  const { tenants, requestsPerSecond, minMessages, maxMessages } =
    status.options;
  const { burstSeconds, quietSeconds } = status.options;
  const shape =
    `${tenants} tenants at ${requestsPerSecond} requests/s each, ` +
    `${minMessages} to ${maxMessages} messages per request` +
    (quietSeconds > 0
      ? `, in bursts of ${burstSeconds} s with ${quietSeconds} s between`
      : '');
  if (status.phase === 'running') {
    return `Running: ${shape}. Stops by itself at ${dateTime(status.endsAt ?? 0)}.`;
  }
  return `${status.phase === 'stopped' ? 'Stopped' : 'Finished'}: ${shape}.`;
};

/**
 * Drives the load generator Worker, which sends to queues named `load-<n>`
 * from inside Cloudflare. Resolves to nothing when the queue has no binding
 * to one.
 */
export const loadTestSection = async (): Promise<
  { element: HTMLElement; stop: () => void } | undefined
> => {
  const first = (await api('GET', '/api/load')) as Answer;
  if (!first.available) {
    return undefined;
  }

  const summary = element('p', { class: 'hint' });
  const numbers = element('div', { class: 'tiles' });
  const reasons = element('p', { class: 'hint' });
  const notice = element('p', { class: 'notice' });
  const startButton = element('button', { type: 'submit' }, 'Start');
  const stopButton = element(
    'button',
    { type: 'button', class: 'secondary' },
    'Stop'
  );
  const deleteButton = element(
    'button',
    { type: 'button', class: 'danger' },
    'Delete the load queues'
  );
  const form = element(
    'form',
    { class: 'stack' },
    element(
      'div',
      { class: 'inline' },
      field(
        'Tenants',
        numberInput('tenants', { min: 1, max: 200, value: 50, required: true }),
        'One queue each, named load-0, load-1, ...'
      ),
      field(
        'Requests per second, per tenant',
        numberInput('requestsPerSecond', {
          min: 1,
          max: 100_000,
          value: 100,
          required: true,
        })
      ),
      field(
        'Messages per request, from',
        numberInput('minMessages', {
          min: 1,
          max: 1_000,
          value: 100,
          required: true,
        })
      ),
      field(
        'to',
        numberInput('maxMessages', {
          min: 1,
          max: 1_000,
          value: 300,
          required: true,
        })
      )
    ),
    element(
      'div',
      { class: 'inline' },
      field(
        'Keys per tenant',
        numberInput('keys', {
          min: 1,
          max: 1_000_000,
          value: 1_000,
          required: true,
        })
      ),
      field(
        'Seconds',
        numberInput('seconds', {
          min: 1,
          max: 3_600,
          value: 300,
          required: true,
        })
      ),
      field(
        'Burst, seconds',
        numberInput('burstSeconds', {
          min: 1,
          max: 3_600,
          value: 30,
          required: true,
        })
      ),
      field(
        'Quiet, seconds',
        numberInput('quietSeconds', {
          min: 0,
          max: 3_600,
          value: 0,
          required: true,
        }),
        '0 for a steady load. Otherwise: a burst, this long with nothing, and again'
      ),
      field(
        'Deliver at most',
        numberInput('deliverPerSecond', {
          min: 1,
          max: 1_000_000,
          placeholder: 'no limit',
        }),
        'Messages per second, per partition. A low value lets a backlog build'
      ),
      field(
        'Partitions per tenant, from',
        numberInput('partitionsMin', {
          min: 1,
          max: 1_000,
          value: 8,
          required: true,
        })
      ),
      field(
        'to',
        numberInput('partitionsMax', {
          min: 1,
          max: 1_000,
          value: 32,
          required: true,
        })
      )
    ),
    element('div', { class: 'actions' }, startButton, stopButton, deleteButton),
    notice
  );

  const render = (status: LoadStatus): void => {
    summary.textContent = describe(status);
    numbers.replaceChildren(...tiles(status));
    reasons.textContent = [
      status.lastRejection === undefined
        ? undefined
        : `Last rejection: ${status.lastRejection}`,
      status.lastFailure === undefined
        ? undefined
        : `Last failure: ${status.lastFailure}`,
    ]
      .filter((line) => line !== undefined)
      .join(' · ');
    const running = status.phase === 'running';
    startButton.toggleAttribute('disabled', running);
    stopButton.toggleAttribute('disabled', !running);
    deleteButton.toggleAttribute('disabled', running);
  };
  const refresh = async (): Promise<void> => {
    const answer = (await api('GET', '/api/load')) as Answer;
    if (answer.available) {
      render(answer);
    }
  };

  handleSubmit(form, notice, async () => {
    const number = (name: string): number => numberField(form, name) ?? 1;
    const options: LoadOptions = {
      tenants: number('tenants'),
      requestsPerSecond: number('requestsPerSecond'),
      minMessages: number('minMessages'),
      maxMessages: number('maxMessages'),
      keys: number('keys'),
      seconds: number('seconds'),
      burstSeconds: number('burstSeconds'),
      quietSeconds: numberField(form, 'quietSeconds') ?? 0,
      deliverPerSecond: numberField(form, 'deliverPerSecond') ?? null,
      partitions: {
        min: number('partitionsMin'),
        max: number('partitionsMax'),
      },
    };
    const total = options.tenants * options.requestsPerSecond;
    const messages = (total * (options.minMessages + options.maxMessages)) / 2;
    if (
      !confirm(
        `Send ${compact(total)} requests and about ${compact(messages)} messages every second for ${options.seconds} seconds?`
      )
    ) {
      return 'Not started';
    }
    render((await api('POST', '/api/load', options)) as LoadStatus);
    return 'Started';
  });
  stopButton.addEventListener('click', () => {
    api('DELETE', '/api/load')
      .then((status) => render(status as LoadStatus))
      .catch(() => undefined);
  });
  deleteButton.addEventListener('click', () => {
    if (!confirm('Delete every queue named load-<n> and what it holds?')) {
      return;
    }
    api('DELETE', '/api/load/queues')
      .then(() => location.reload())
      .catch(() => undefined);
  });

  render(first);
  const timer = setInterval(() => {
    refresh().catch(() => undefined);
  }, refreshMs);
  return {
    element: element(
      'section',
      { class: 'card' },
      element('h2', {}, 'Load test'),
      summary,
      numbers,
      reasons,
      form
    ),
    stop: () => clearInterval(timer),
  };
};
