import { DurabilitySocketClient, type SocketStatus } from 'durability/client';
import type { MessageInput, Overview, Point } from '../src/model';
import type { Orchestrator } from '../src/orchestrator';
import { api, ApiError, queuePath } from './api';
import { lineChart } from './charts';
import { compact, element, errorMessage, showNotice } from './dom';
import { resizeForm, sendMessagesForm, settingsForm } from './forms';
import { targetForm } from './target-form';
import { targetsTable } from './targets';
import {
  acceptedCounter,
  levelSeries,
  pendingCounter,
  rateSeries,
  settledCounter,
} from './metrics';
import { eventList, limiterTable, partitionGrid, statTiles } from './sections';

const client = new DurabilitySocketClient<Orchestrator['socket']>({
  url: (queue) =>
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${queuePath(queue)}/socket`,
});

const palette = [
  '#2563eb',
  '#16a34a',
  '#d97706',
  '#db2777',
  '#7c3aed',
  '#0891b2',
  '#dc2626',
  '#65a30d',
];
const liveRangeMs = 30 * 60_000;
const historyRangeMs = 48 * 60 * 60_000;
const liveRefreshMs = 5_000;
const historyRefreshMs = 60_000;

const statusLabels: Record<SocketStatus, string> = {
  connecting: 'connecting',
  connected: 'live',
  disconnected: 'reconnecting',
  closed: 'closed',
};

const section = (title: string, ...children: (Node | string)[]): HTMLElement =>
  element('section', { class: 'card' }, element('h2', {}, title), ...children);

/** Renders one queue and keeps it live until the returned function is called. */
export const showQueue = (root: HTMLElement, queue: string): (() => void) => {
  const connection = client.connect(queue);
  let overview: Overview | undefined;
  let status: SocketStatus = 'connecting';
  let showHistory = false;
  let history: Point[] = [];
  let historyLoadedAt = 0;
  let liveLoadedAt = 0;
  let lastProbeAt = 0;

  const notice = element('p', { class: 'notice' });
  const report = (error: unknown): void =>
    showNotice(notice, errorMessage(error), 'error');

  const badges = element('div', { class: 'badges' });
  const tiles = element('div', { class: 'tiles' });
  const charts = element('div', { class: 'charts' });
  const rangeButton = element(
    'button',
    { type: 'button', class: 'secondary' },
    'Show 48 h'
  );
  const partitions = element('div');
  const limiters = element('div');
  const limiterSection = section('Limiters', limiters);
  const events = element('div');

  const editor = targetForm(async (name, target) => {
    await connection.rpc.putTarget({ name, target });
  });
  const settings = settingsForm((next) => connection.rpc.updateSettings(next));
  const resize = resizeForm((count) => connection.rpc.resize(count));
  const send = sendMessagesForm(async (messages: MessageInput[]) => {
    try {
      const outcome = (await api(
        'POST',
        `${queuePath(queue)}/messages`,
        messages
      )) as {
        accepted: string[];
      };
      return `Accepted ${outcome.accepted.length} messages`;
    } catch (error) {
      // 429 and 503 still carry the per-message outcome instead of an error field.
      if (
        !(error instanceof ApiError) ||
        typeof error.body !== 'object' ||
        error.body === null ||
        !('rejected' in error.body)
      ) {
        throw error;
      }
      const body = error.body as {
        accepted: string[];
        rejected: { ids: string[]; error: { message: string } }[];
      };
      const reasons = [
        ...new Set(body.rejected.map((entry) => entry.error.message)),
      ];
      const rejected = body.rejected.reduce(
        (sum, entry) => sum + entry.ids.length,
        0
      );
      throw new Error(
        `Accepted ${body.accepted.length}, rejected ${rejected}: ${reasons.join('; ')}`,
        { cause: error }
      );
    }
  });

  const deleteQueue = async (): Promise<void> => {
    if (!confirm(`Delete queue "${queue}"? Its stored messages are dropped.`)) {
      return;
    }
    await api('DELETE', queuePath(queue));
    location.hash = '#/';
  };

  const redrive = async (name: string): Promise<void> => {
    const outcome = (await api(
      'POST',
      `${queuePath(queue)}/targets/${encodeURIComponent(name)}/redrive`
    )) as {
      redriven: number;
      more: boolean;
    };
    const more = outcome.more ? '; more remain, redrive again' : '';
    showNotice(
      notice,
      `Redrove ${outcome.redriven} messages to ${name}${more}`
    );
  };

  const removeTarget = async (name: string): Promise<void> => {
    if (
      !confirm(
        `Delete target "${name}"? Its undelivered messages are not delivered to it.`
      )
    ) {
      return;
    }
    await connection.rpc.removeTarget(name);
  };

  const targets = targetsTable({
    pause: (name, paused) => connection.rpc.pauseTarget({ name, paused }),
    edit: (name, target) => editor.edit(name, target),
    redrive,
    remove: removeTarget,
    report,
  });

  root.replaceChildren(
    element(
      'header',
      { class: 'page-header' },
      element('a', { href: '#/', class: 'back' }, 'Queues'),
      element('h1', {}, queue),
      badges
    ),
    notice,
    tiles,
    section(
      'Throughput and backlog',
      element('div', { class: 'actions' }, rangeButton),
      charts
    ),
    section(
      'Targets',
      targets.element,
      element('h3', {}, 'Add or edit a target'),
      editor.form
    ),
    section('Partitions', partitions),
    limiterSection,
    section('Settings', settings.form, element('h3', {}, 'Resize'), resize),
    section('Send test messages', send),
    section('Events', events),
    section(
      'Danger zone',
      element(
        'button',
        {
          type: 'button',
          class: 'danger',
          onclick: () => void deleteQueue().catch(report),
        },
        'Delete queue'
      )
    )
  );

  const renderHeader = (): void => {
    const statusBadge = element(
      'span',
      { class: `badge status-${status}` },
      statusLabels[status]
    );
    if (!overview) {
      badges.replaceChildren(statusBadge);
      return;
    }

    const count =
      overview.points.at(-1)?.partitions ?? overview.epochs.at(-1)?.count ?? 0;
    badges.replaceChildren(
      statusBadge,
      element(
        'span',
        { class: 'badge' },
        count === 1 ? '1 partition' : `${count} partitions`
      )
    );
    if (overview.epochs.length > 1) {
      badges.appendChild(
        element('span', { class: 'badge warning' }, 'resizing')
      );
    }
  };

  const colorOf = (index: number): string => palette[index % palette.length]!;

  const renderCharts = (): void => {
    if (!overview) {
      return;
    }
    const points = showHistory ? history : overview.points;
    const maxGapMs = showHistory ? 180_000 : 10_000;
    const to = Date.now();
    const from = to - (showHistory ? historyRangeMs : liveRangeMs);
    const names = Object.keys(overview.targets).sort();
    charts.replaceChildren(
      lineChart({
        title: 'Messages per second',
        from,
        to,
        format: compact,
        series: [
          {
            label: 'accepted',
            color: colorOf(0),
            values: rateSeries(points, acceptedCounter, maxGapMs),
          },
          ...names.map((name, index) => ({
            label: `${name} delivered`,
            color: colorOf(index + 1),
            values: rateSeries(points, settledCounter(name), maxGapMs),
          })),
        ],
      }),
      lineChart({
        title: 'Backlog per target',
        from,
        to,
        format: compact,
        series: names.map((name, index) => ({
          label: name,
          color: colorOf(index + 1),
          values: levelSeries(points, pendingCounter(name), maxGapMs),
        })),
      })
    );
  };

  const renderLive = (): void => {
    if (!overview) {
      return;
    }
    renderHeader();
    tiles.replaceChildren(...statTiles(overview));
    renderCharts();
    targets.render(overview);
  };

  const renderPartitionsAndLimiters = (): void => {
    if (!overview) {
      return;
    }
    partitions.replaceChildren(partitionGrid(overview));
    limiters.replaceChildren(limiterTable(overview));
  };

  const renderAll = (): void => {
    if (!overview) {
      return;
    }
    renderLive();
    renderPartitionsAndLimiters();
    limiterSection.hidden = overview.settings.maxConcurrency === null;
    events.replaceChildren(eventList(overview));
    settings.update(overview.settings);
  };

  // Overlapping reloads collapse into one follow-up, so a burst of events costs two calls.
  let reloading = false;
  let reloadAgain = false;
  const reloadOverview = (): void => {
    if (reloading) {
      reloadAgain = true;
      return;
    }
    reloading = true;
    const load = async (): Promise<void> => {
      overview = await connection.rpc.overview();
      renderAll();
    };
    load()
      .catch(report)
      .finally(() => {
        reloading = false;
        if (reloadAgain) {
          reloadAgain = false;
          reloadOverview();
        }
      });
  };

  // Partition samples and limiter numbers change with traffic but fire no `changed` event.
  const loadLive = async (): Promise<void> => {
    liveLoadedAt = Date.now();
    const live = await connection.rpc.live();
    if (!overview) {
      return;
    }
    overview.partitions = live.partitions;
    overview.limiters = live.limiters;
    renderPartitionsAndLimiters();
    targets.render(overview);
  };

  const loadHistory = async (): Promise<void> => {
    historyLoadedAt = Date.now();
    history = await connection.rpc.history();
    renderCharts();
  };

  rangeButton.addEventListener('click', () => {
    showHistory = !showHistory;
    rangeButton.textContent = showHistory ? 'Show 30 min' : 'Show 48 h';
    renderCharts();
    if (showHistory) {
      loadHistory().catch(report);
    }
  });

  const onPoint = (point: Point): void => {
    if (!overview) {
      return;
    }
    const oldest = Date.now() - liveRangeMs;
    overview.points = [
      ...overview.points.filter((entry) => entry.at >= oldest),
      point,
    ];
    renderLive();
    if (Date.now() - liveLoadedAt > liveRefreshMs) {
      loadLive().catch(report);
    }
    if (showHistory && Date.now() - historyLoadedAt > historyRefreshMs) {
      loadHistory().catch(report);
    }
  };

  // A failing reconnect can mean a lost session or a deleted queue; HTTP tells which.
  const onStatus = (next: SocketStatus): void => {
    status = next;
    renderHeader();
    if (next !== 'disconnected' || Date.now() - lastProbeAt < 10_000) {
      return;
    }
    lastProbeAt = Date.now();
    api('GET', queuePath(queue)).catch(report);
  };

  const unsubscribe: (() => void)[] = [];
  let closed = false;
  const ticker = setInterval(renderLive, 5_000);

  // HTTP first: a missing session or queue is reported, not retried forever by the socket.
  const start = async (): Promise<void> => {
    const initial = (await api('GET', queuePath(queue))) as Overview;
    if (closed) {
      return;
    }
    overview = initial;
    liveLoadedAt = Date.now();
    renderAll();
    unsubscribe.push(
      connection.on.status(onStatus),
      connection.on.point(onPoint),
      connection.on.changed(reloadOverview),
      connection.on.resync(reloadOverview)
    );
  };

  renderHeader();
  start().catch(report);

  return () => {
    closed = true;
    clearInterval(ticker);
    for (const stop of unsubscribe) {
      stop();
    }
    connection.close();
  };
};
