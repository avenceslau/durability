import { exports as workerExports } from 'cloudflare:workers';
import type { QueueAdmin, QueueBinding } from '@queues-example/queue';
import type { LoadCounts, LoadOptions } from '@queues-example/queue/load';
import type { LoadController } from './controller';
import type { LoadGenerator } from './generator';

export type Env = {
  QUEUE: Service<QueueBinding>;
  QUEUE_ADMIN: Service<QueueAdmin>;
};

export type Run = {
  runId: string;
  /** Generators only adopt a newer revision, so a late poke cannot undo a stop. */
  revision: number;
  startedAt: number;
  /** Every run ends by itself, so a forgotten one cannot send for ever. */
  endsAt: number;
  stopped?: true;
  options: LoadOptions;
};

/** What a generator did since its previous report. */
export type Report = LoadCounts & {
  /** How long the report covers. */
  seconds: number;
  /** Requests answered, whatever the answer. */
  completed: number;
  latencySumMs: number;
  latencyMaxMs: number;
  /** Why a request of this report failed, and why the queue refused messages. */
  lastFailure?: string;
  lastRejection?: string;
};

/** One generator sends at most this many requests a second, so the load comes from many objects. */
export const generatorRps = 25;
/** Each one reports to the controller every tick; this many keep that within what one object takes. */
export const maxGenerators = 5_000;

const generatorsPerTenant = (options: LoadOptions): number =>
  Math.ceil(options.requestsPerSecond / generatorRps);

export const generatorCount = (options: LoadOptions): number =>
  options.tenants * generatorsPerTenant(options);

/**
 * Generators wake each other: generator 0 is woken by the controller, and
 * each one wakes this many more. Thousands start within a few hops, where
 * the controller waking them one by one took longer than a short run lasts.
 */
const fanout = 16;

/** The generators that generator `index` wakes, out of `count`. */
export const childrenOf = (index: number, count: number): number[] => {
  const first = index * fanout + 1;
  const last = Math.min(first + fanout, count);
  return Array.from(
    { length: Math.max(0, last - first) },
    (_, at) => first + at
  );
};

export const queueOf = (tenant: number): string => `load-${tenant}`;
export const isLoadQueue = (name: string): boolean => /^load-\d+$/.test(name);

/** The queue a generator sends to, and how many requests a second. */
export const assignment = (
  options: LoadOptions,
  index: number
): { queue: string; rate: number } => {
  const perTenant = generatorsPerTenant(options);
  return {
    queue: queueOf(Math.floor(index / perTenant)),
    rate: options.requestsPerSecond / perTenant,
  };
};

/**
 * Whether a bursty run is sending at `now`. It depends only on the run, so
 * every generator starts and stops its bursts together.
 */
export const inBurst = (run: Run, now: number): boolean => {
  const { burstSeconds, quietSeconds } = run.options;
  if (!quietSeconds) {
    return true;
  }
  const cycleMs = (burstSeconds + quietSeconds) * 1_000;
  return (now - run.startedAt) % cycleMs < burstSeconds * 1_000;
};

export const active = (run: Run | undefined, now: number): run is Run =>
  run !== undefined && !run.stopped && now < run.endsAt;

/** The Worker's own Durable Object classes, reached through its exports. */
const namespace = <T extends Rpc.DurableObjectBranded>(
  exportName: string
): DurableObjectNamespace<T> =>
  (workerExports as Record<string, unknown>)[
    exportName
  ] as DurableObjectNamespace<T>;

export const controller = () =>
  namespace<LoadController>('LoadController').getByName('controller');
/**
 * Generators are spread over these regions. Each one runs the queue's Worker
 * next to itself, so thousands in one place would have a few machines do all
 * the work of accepting, and the test would measure those machines.
 */
const regions: DurableObjectLocationHint[] = [
  'wnam',
  'enam',
  'sam',
  'weur',
  'eeur',
  'apac',
  'afr',
  'me',
];

/** The hint only places an object the first time, so it is part of the name. */
export const generator = (index: number) => {
  const region = regions[index % regions.length]!;
  return namespace<LoadGenerator>('LoadGenerator').getByName(
    `generator-${index}-${region}`,
    { locationHint: region }
  );
};

export const generatorIndex = (name: string | undefined): number =>
  Number(name?.split('-')[1] ?? 0);
