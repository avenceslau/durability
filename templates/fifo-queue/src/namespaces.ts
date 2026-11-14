import { exports as workerExports } from 'cloudflare:workers';
import type { Directory } from './directory';
import type { Limiter } from './limiter';
import type { Orchestrator } from './orchestrator';
import type { Partition } from './partition';
import type { PullConsumer } from './pull-consumer';
import type { Redriver } from './redriver';

/**
 * The Worker's own Durable Object classes, reached through its exports. They
 * need a migration in `wrangler.jsonc` but no binding.
 */
const namespace = <T extends Rpc.DurableObjectBranded>(
  exportName: string
): DurableObjectNamespace<T> =>
  (workerExports as Record<string, unknown>)[
    exportName
  ] as DurableObjectNamespace<T>;

export const partitions = () => namespace<Partition>('Partition');
export const limiters = () => namespace<Limiter>('Limiter');
export const orchestrators = () => namespace<Orchestrator>('Orchestrator');
export const redrivers = () => namespace<Redriver>('Redriver');
export const pullConsumers = () => namespace<PullConsumer>('PullConsumer');
export const directory = () =>
  namespace<Directory>('Directory').getByName('directory');
