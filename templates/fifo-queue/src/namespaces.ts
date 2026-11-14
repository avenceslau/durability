import { exports as workerExports } from 'cloudflare:workers';
import type { Directory } from './directory';
import type { Limiter } from './limiter';
import type { Orchestrator } from './orchestrator';
import type { Partition } from './partition';

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
export const directory = () =>
  namespace<Directory>('Directory').getByName('directory');
