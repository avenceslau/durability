import {
  bindingIdentifiers,
  forEachChild,
  functionTypes,
  identifierName,
  syntaxNode,
  type SyntaxNode,
} from './syntax.js';

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

/** Lexical scopes of a parsed module and where each node sits in the tree. */
export type ScopeIndex = {
  rootScope: Scope;
  /** Scope each node was found in. */
  nodeScopes: WeakMap<object, Scope>;
  /** Parent of each node and the key the node is stored under. */
  relations: WeakMap<object, NodeRelation>;
  /** Every `const` declarator with the scope that declares it. */
  declarators: Array<{ node: SyntaxNode; scope: Scope }>;
};

const platformEntrypointNames = new Set([
  'DurableObject',
  'RpcTarget',
  'WorkerEntrypoint',
]);

// Worker handlers receive `env` as their second parameter.
const workerHandlerNames = new Set([
  'email',
  'fetch',
  'queue',
  'scheduled',
  'tail',
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

function declareLocal(scope: Scope, name: string | undefined): void {
  if (name) {
    scope.bindings.set(name, { kind: 'other', wrapReferences: false });
  }
}

function declareParameters(node: SyntaxNode, functionScope: Scope): void {
  const params = Array.isArray(node.params) ? node.params : [];
  const handlerName =
    node.type === 'FunctionDeclaration'
      ? identifierName(syntaxNode(node.id))
      : identifierName(syntaxNode(node.key));
  const hasWorkerEnvParameter =
    handlerName !== undefined && workerHandlerNames.has(handlerName);

  for (const [parameterIndex, param] of params.entries()) {
    const isEnv =
      hasWorkerEnvParameter &&
      parameterIndex === 1 &&
      syntaxNode(param)?.type === 'Identifier';

    for (const identifier of bindingIdentifiers(param)) {
      const name = identifierName(identifier);
      if (name) {
        functionScope.bindings.set(name, {
          kind: isEnv ? 'env' : 'other',
          wrapReferences: false,
        });
      }
    }
  }
}

function importedBindingKind(
  specifier: SyntaxNode,
  declaration: SyntaxNode | undefined
): BindingKind {
  if (specifier.type !== 'ImportSpecifier') {
    return 'other';
  }

  const source = syntaxNode(declaration?.source);
  const sourceName =
    source?.type === 'StringLiteral' && typeof source.value === 'string'
      ? source.value
      : undefined;
  const importedName = identifierName(syntaxNode(specifier.imported));
  if (sourceName === undefined || importedName === undefined) {
    return 'other';
  }

  const isTypeOnly =
    declaration?.importKind === 'type' || specifier.importKind === 'type';
  if (!isTypeOnly && clientFactories.get(sourceName) === importedName) {
    return 'client';
  }
  return importedName === 'env' && sourceName === 'cloudflare:test'
    ? 'env'
    : 'other';
}

/** Records the scope of every node and the names each scope declares. */
export function indexScopes(ast: unknown): ScopeIndex {
  const rootScope: Scope = { bindings: new Map() };
  const nodeScopes = new WeakMap<object, Scope>();
  const relations = new WeakMap<object, NodeRelation>();
  const declarators: ScopeIndex['declarators'] = [];

  const index = (
    value: unknown,
    scope: Scope,
    parent?: SyntaxNode,
    key?: string
  ): void => {
    const node = syntaxNode(value);
    if (!node) {
      return;
    }
    nodeScopes.set(node, scope);
    if (parent && key) {
      relations.set(node, { parent, key });
    }

    if (node.type === 'BlockStatement') {
      const blockScope: Scope = { parent: scope, bindings: new Map() };
      forEachChild(node, (child, childKey) => {
        index(child, blockScope, node, childKey);
      });
      return;
    }

    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      declareLocal(scope, identifierName(syntaxNode(node.id)));
      const superName = identifierName(syntaxNode(node.superClass));
      const classScope: Scope = {
        parent: scope,
        bindings: new Map(),
        trustedThisEnv:
          superName !== undefined && platformEntrypointNames.has(superName),
      };
      forEachChild(node, (child, childKey) => {
        if (childKey !== 'id') {
          index(child, classScope, node, childKey);
        }
      });
      return;
    }

    if (functionTypes.has(node.type)) {
      if (node.type === 'FunctionDeclaration') {
        declareLocal(scope, identifierName(syntaxNode(node.id)));
      }
      const functionScope: Scope = {
        parent: scope,
        bindings: new Map(),
        trustedThisEnv: scope.trustedThisEnv ?? false,
      };
      if (node.type === 'FunctionExpression') {
        declareLocal(functionScope, identifierName(syntaxNode(node.id)));
      }
      declareParameters(node, functionScope);

      forEachChild(node, (child, childKey) => {
        if (childKey === 'id') {
          return;
        }
        const childScope =
          childKey === 'params' || childKey === 'body' ? functionScope : scope;
        index(child, childScope, node, childKey);
      });
      return;
    }

    if (node.type === 'CatchClause') {
      const catchScope: Scope = { parent: scope, bindings: new Map() };
      for (const identifier of bindingIdentifiers(node.param)) {
        declareLocal(catchScope, identifierName(identifier));
      }
      forEachChild(node, (child, childKey) => {
        index(child, catchScope, node, childKey);
      });
      return;
    }

    if (
      node.type === 'VariableDeclaration' &&
      Array.isArray(node.declarations)
    ) {
      for (const declarationValue of node.declarations) {
        const declaration = syntaxNode(declarationValue);
        if (!declaration) {
          continue;
        }
        for (const identifier of bindingIdentifiers(declaration.id)) {
          declareLocal(scope, identifierName(identifier));
        }
        if (node.kind === 'const') {
          declarators.push({ node: declaration, scope });
        }
      }
    } else if (
      node.type === 'ImportDefaultSpecifier' ||
      node.type === 'ImportNamespaceSpecifier' ||
      node.type === 'ImportSpecifier'
    ) {
      const localName = identifierName(syntaxNode(node.local));
      if (localName) {
        scope.bindings.set(localName, {
          kind: importedBindingKind(node, parent),
          wrapReferences: false,
        });
      }
    }

    forEachChild(node, (child, childKey) => {
      index(child, scope, node, childKey);
    });
  };

  index(ast, rootScope);
  return { rootScope, nodeScopes, relations, declarators };
}
