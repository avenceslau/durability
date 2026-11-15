import type { Overview, Point, TargetTotals } from '../src/model';

export type ChartValue = { at: number; value: number };

/** `null` marks a gap: the line is not drawn across it. */
export type ChartValues = (ChartValue | null)[];

type Counter = (point: Point) => number | undefined;

/** Points stop while a queue is idle; a newest point older than this means no traffic. */
const staleAfterMs = 15_000;

export const acceptedCounter: Counter = (point) => point.accepted;

export const settledCounter =
  (target: string): Counter =>
  (point) =>
    point.targets[target]?.settled;

export const pendingCounter =
  (target: string): Counter =>
  (point) =>
    point.targets[target]?.pending;

/** Per-second rates between consecutive cumulative points. */
export const rateSeries = (
  points: readonly Point[],
  counter: Counter,
  maxGapMs: number
): ChartValues => {
  const values: ChartValues = [];
  for (let index = 1; index < points.length; index++) {
    const before = points[index - 1]!;
    const after = points[index]!;
    const elapsedMs = after.at - before.at;
    const start = counter(before);
    const end = counter(after);
    if (
      elapsedMs <= 0 ||
      elapsedMs > maxGapMs ||
      start === undefined ||
      end === undefined
    ) {
      values.push(null);
      continue;
    }
    values.push({
      at: after.at,
      value: Math.max(0, end - start) / (elapsedMs / 1_000),
    });
  }
  return values;
};

export const levelSeries = (
  points: readonly Point[],
  counter: Counter,
  maxGapMs: number
): ChartValues => {
  const values: ChartValues = [];
  let previousAt: number | undefined;
  for (const point of points) {
    const value = counter(point);
    if (previousAt !== undefined && point.at - previousAt > maxGapMs) {
      values.push(null);
    }
    previousAt = point.at;
    values.push(value === undefined ? null : { at: point.at, value });
  }
  return values;
};

const rateWindowMs = 10_000;

/** Rate over roughly the last ten seconds, smoothing out single noisy intervals. */
export const recentRate = (
  points: readonly Point[],
  counter: Counter
): number => {
  const last = points.at(-1);
  if (!last || Date.now() - last.at > staleAfterMs) {
    return 0;
  }
  const first = points.find(
    (point) => point.at >= last.at - rateWindowMs && point !== last
  );
  if (!first) {
    return 0;
  }
  const start = counter(first);
  const end = counter(last);
  if (start === undefined || end === undefined) {
    return 0;
  }
  return Math.max(0, end - start) / ((last.at - first.at) / 1_000);
};

/**
 * Per-target totals from the newest point, or summed from partition samples
 * when the queue has been idle for longer than the points cover. Partition
 * samples miss counters of epochs that left the queue, so retries and dead letters can
 * read low in that case.
 */
export const latestTotals = (
  overview: Overview
): Record<string, TargetTotals> => {
  const last = overview.points.at(-1);
  if (last) {
    return last.targets;
  }

  const totals: Record<string, TargetTotals> = {};
  for (const name of Object.keys(overview.targets)) {
    totals[name] = {
      settled: 0,
      pending: 0,
      inFlight: 0,
      retries: 0,
      deadLettered: 0,
    };
  }
  for (const sample of overview.partitions) {
    for (const [name, progress] of Object.entries(sample.targets)) {
      const target = totals[name];
      if (!target) {
        continue;
      }
      target.settled += progress.settled;
      target.pending += sample.accepted - progress.settled;
      target.inFlight += progress.inFlight;
      target.retries += progress.retries;
      target.deadLettered += progress.deadLettered;
    }
  }
  return totals;
};

/** The target with the largest backlog; its numbers bound how far behind the queue is. */
export const slowestTarget = (
  totals: Record<string, TargetTotals>
): string | undefined => {
  let slowest: string | undefined;
  let largest = -1;
  for (const name of Object.keys(totals).sort()) {
    const pending = totals[name]!.pending;
    if (pending > largest) {
      slowest = name;
      largest = pending;
    }
  }
  return slowest;
};
