import type { SyntaxNode } from './syntax.js';

export type BindingKind = 'client' | 'env' | 'namespace' | 'other' | 'stub';

/** Durability helpers whose `.client({ target })` receives an injected `exportName`. */
export const clientFactories: ReadonlyMap<string, string> = new Map([
  ['durability/routing', 'DurabilityRouting'],
  ['durability/experimental/semaphore', 'DurabilitySemaphore'],
]);

export type Binding = {
  kind: BindingKind;
  wrapReferences: boolean;
};

export type Scope = {
  parent?: Scope;
  bindings: Map<string, Binding>;
  trustedThisEnv?: boolean;
};

export type NodeRelation = {
  parent: SyntaxNode;
  key: string;
};

export const platformEntrypointNames = new Set([
  'DurableObject',
  'RpcTarget',
  'WorkerEntrypoint',
]);

export function resolveBinding(
  scope: Scope | undefined,
  name: string
): Binding | undefined {
  for (let current = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) {
      return binding;
    }
  }
  return undefined;
}
