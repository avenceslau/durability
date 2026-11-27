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
/** As many as one controller can wake within its subrequest limit. */
export const maxGenerators = 2_000;

const generatorsPerTenant = (options: LoadOptions): number =>
  Math.ceil(options.requestsPerSecond / generatorRps);

export const generatorCount = (options: LoadOptions): number =>
  options.tenants * generatorsPerTenant(options);

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
export const generator = (index: number) =>
  namespace<LoadGenerator>('LoadGenerator').getByName(`generator-${index}`);
