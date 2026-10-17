import { exports as workerExports } from 'cloudflare:workers';

/** An application-owned Durable Object class a client-side helper routes to. */
export type DurableObjectTarget<Target extends Rpc.DurableObjectBranded> = {
  /** Application-owned exported Durable Object class. */
  target: { prototype: Target };
  /** Injected by the Vite plugin; explicit for builds without it. */
  exportName?: string;
  /** Explicit namespace escape hatch for cross-worker or non-Vite consumers. */
  namespace?: () => DurableObjectNamespace<Target>;
};

export const resolveNamespace = <Target extends Rpc.DurableObjectBranded>(
  config: DurableObjectTarget<Target>,
  error: (message: string) => Error
): DurableObjectNamespace<Target> => {
  const namespace = config.namespace?.();
  if (namespace) {
    return namespace;
  }
  if (!config.exportName) {
    throw error(
      'Use the durability Vite plugin, exportName, or an explicit namespace to resolve the target'
    );
  }

  const exported: unknown = Reflect.get(workerExports, config.exportName);
  if (
    exported === null ||
    (typeof exported !== 'object' && typeof exported !== 'function') ||
    typeof Reflect.get(exported, 'getByName') !== 'function'
  ) {
    throw error(
      `Export "${config.exportName}" is not a Durable Object namespace`
    );
  }
  return exported as DurableObjectNamespace<Target>;
};
