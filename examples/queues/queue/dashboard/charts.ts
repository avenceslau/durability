import { element, svgElement } from './dom';
import type { ChartValues } from './metrics';

export type ChartSeries = {
  label: string;
  color: string;
  values: ChartValues;
};

const width = 640;
const height = 220;
const margin = {
  top: 12,
  right: 12,
  bottom: 24,
  left: 52,
};
const plotWidth = width - margin.left - margin.right;
const plotHeight = height - margin.top - margin.bottom;
const gridLines = 4;
const timeTicks = 5;

/** Smallest of 1, 2, 2.5, 5, 10 times a power of ten that is at least `value`. */
const roundedMaximum = (value: number): number => {
  if (value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= value) {
      return step * magnitude;
    }
  }
  return 10 * magnitude;
};

const timeLabel = (at: number, rangeMs: number): string =>
  rangeMs > 86_400_000
    ? new Date(at).toLocaleString([], {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : new Date(at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });

const linePath = (
  values: ChartValues,
  from: number,
  x: (at: number) => number,
  y: (value: number) => number
): string => {
  const commands: string[] = [];
  let hasPreviousPoint = false;
  for (const value of values) {
    if (value === null || value.at < from) {
      hasPreviousPoint = false;
      continue;
    }
    commands.push(
      `${hasPreviousPoint ? 'L' : 'M'}${x(value.at).toFixed(1)},${y(value.value).toFixed(1)}`
    );
    hasPreviousPoint = true;
  }
  return commands.join('');
};

/** A time-series line chart over [from, to] with a y axis starting at zero. */
export const lineChart = (options: {
  title: string;
  series: ChartSeries[];
  from: number;
  to: number;
  format: (value: number) => string;
}): HTMLElement => {
  const { series, from, to, format } = options;
  const visible = series.flatMap((line) =>
    line.values.filter((value) => value !== null && value.at >= from)
  );
  const maximum = roundedMaximum(
    Math.max(0, ...visible.map((value) => value?.value ?? 0))
  );
  const x = (at: number): number =>
    margin.left + ((at - from) / (to - from)) * plotWidth;
  const y = (value: number): number =>
    margin.top + plotHeight - (value / maximum) * plotHeight;

  const parts: SVGElement[] = [];

  for (let line = 0; line <= gridLines; line++) {
    const value = (maximum * line) / gridLines;
    parts.push(
      svgElement('line', {
        x1: margin.left,
        x2: width - margin.right,
        y1: y(value),
        y2: y(value),
        class: line === 0 ? 'axis' : 'grid',
      }),
      svgElement(
        'text',
        {
          x: margin.left - 6,
          y: y(value) + 4,
          'text-anchor': 'end',
          class: 'tick',
        },
        format(value)
      )
    );
  }

  for (let tick = 0; tick < timeTicks; tick++) {
    const at = from + ((to - from) * tick) / (timeTicks - 1);
    const anchor =
      tick === 0 ? 'start' : tick === timeTicks - 1 ? 'end' : 'middle';
    parts.push(
      svgElement(
        'text',
        {
          x: x(at),
          y: height - 6,
          'text-anchor': anchor,
          class: 'tick',
        },
        timeLabel(at, to - from)
      )
    );
  }

  for (const line of series) {
    parts.push(
      svgElement('path', {
        d: linePath(line.values, from, x, y),
        stroke: line.color,
        class: 'series',
      })
    );
  }

  if (visible.length === 0) {
    parts.push(
      svgElement(
        'text',
        {
          x: margin.left + plotWidth / 2,
          y: margin.top + plotHeight / 2,
          'text-anchor': 'middle',
          class: 'empty',
        },
        'No samples in this range'
      )
    );
  }

  const chart = svgElement(
    'svg',
    {
      viewBox: `0 0 ${width} ${height}`,
      class: 'chart',
      role: 'img',
      'aria-label': options.title,
    },
    ...parts
  );

  return element(
    'figure',
    { class: 'chart-card' },
    element('figcaption', {}, options.title),
    chart,
    element(
      'ul',
      { class: 'legend' },
      series.map((line) =>
        element(
          'li',
          {},
          element('span', {
            class: 'swatch',
            style: `background:${line.color}`,
          }),
          line.label
        )
      )
    )
  );
};
