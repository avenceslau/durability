import {
  resolveBinding,
  type Binding,
  type Scope,
  type ScopeIndex,
} from './scopes.js';
import {
  bindingIdentifiers,
  identifierName,
  memberExpressionTypes,
  propertyName,
  syntaxNode,
  unwrapExpression,
  type SyntaxNode,
} from './syntax.js';
import type { WranglerBindings } from './wrangler.js';

type ConfiguredBindingKind = 'namespace' | 'stub';

function isEnvRoot(scopes: ScopeIndex, value: unknown, scope: Scope): boolean {
  const node = unwrapExpression(value);
  if (!node) {
    return false;
  }
  if (node.type === 'Identifier' && typeof node.name === 'string') {
    return (
      resolveBinding(scopes.nodeScopes.get(node) ?? scope, node.name)?.kind ===
      'env'
    );
  }

  let trustsThisEnv = false;
  for (
    let current: Scope | undefined = scope;
    current;
    current = current.parent
  ) {
    if (current.trustedThisEnv === true) {
      trustsThisEnv = true;
      break;
    }
  }
  return (
    trustsThisEnv &&
    memberExpressionTypes.has(node.type) &&
    propertyName(node) === 'env' &&
    unwrapExpression(node.object)?.type === 'ThisExpression'
  );
}

function kindOfEnvProperty(
  bindings: WranglerBindings,
  name: string | undefined
): ConfiguredBindingKind | undefined {
  if (!name) {
    return undefined;
  }
  if (bindings.durableObjectBindingNames.has(name)) {
    return 'namespace';
  }
  return bindings.stubBindingNames.has(name) ? 'stub' : undefined;
}

/**
 * Whether an expression is a configured Durable Object namespace or another
 * wrapped binding: either `env.NAME` or a local name known to hold one.
 */
export function configuredBindingKind(
  scopes: ScopeIndex,
  bindings: WranglerBindings,
  value: unknown,
  scope: Scope
): ConfiguredBindingKind | undefined {
  const node = unwrapExpression(value);
  if (!node) {
    return undefined;
  }
  if (node.type === 'Identifier' && typeof node.name === 'string') {
    const binding = resolveBinding(
      scopes.nodeScopes.get(node) ?? scope,
      node.name
    );
    return binding?.kind === 'namespace' || binding?.kind === 'stub'
      ? binding.kind
      : undefined;
  }
  if (
    !memberExpressionTypes.has(node.type) ||
    !isEnvRoot(scopes, node.object, scope)
  ) {
    return undefined;
  }
  return kindOfEnvProperty(bindings, propertyName(node));
}

function setKind(
  binding: Binding | undefined,
  kind: ConfiguredBindingKind | undefined,
  wrapReferences: boolean
): boolean {
  if (!binding || !kind || binding.kind === kind) {
    return false;
  }
  binding.kind = kind;
  binding.wrapReferences = wrapReferences;
  return true;
}

function destructuredPropertyName(property: SyntaxNode): string | undefined {
  const key = syntaxNode(property.key);
  const literal =
    key?.type === 'StringLiteral' && typeof key.value === 'string'
      ? key.value
      : undefined;
  return property.computed === true
    ? literal
    : (identifierName(key) ?? literal);
}

/** Marks the names in `const { NAME } = env` that hold configured bindings. */
function markDestructuredBindings(
  bindings: WranglerBindings,
  pattern: SyntaxNode,
  scope: Scope
): boolean {
  const properties = Array.isArray(pattern.properties)
    ? pattern.properties
    : [];
  let changed = false;

  for (const propertyValue of properties) {
    const property = syntaxNode(propertyValue);
    if (!property || property.type !== 'ObjectProperty') {
      continue;
    }

    const kind = kindOfEnvProperty(
      bindings,
      destructuredPropertyName(property)
    );
    const locals = bindingIdentifiers(property.value);
    const localName =
      locals.length === 1 ? identifierName(locals[0]) : undefined;
    const binding = localName ? scope.bindings.get(localName) : undefined;

    if (setKind(binding, kind, kind === 'stub')) {
      changed = true;
    }
  }
  return changed;
}

function markDeclarator(
  scopes: ScopeIndex,
  bindings: WranglerBindings,
  declarator: SyntaxNode,
  scope: Scope
): boolean {
  const pattern = syntaxNode(declarator.id);
  if (!pattern) {
    return false;
  }

  if (pattern.type === 'Identifier') {
    const name = identifierName(pattern);
    const binding = name ? scope.bindings.get(name) : undefined;
    const kind = configuredBindingKind(
      scopes,
      bindings,
      declarator.init,
      scope
    );
    return setKind(binding, kind, false);
  }

  if (
    pattern.type === 'ObjectPattern' &&
    isEnvRoot(scopes, declarator.init, scope)
  ) {
    return markDestructuredBindings(bindings, pattern, scope);
  }
  return false;
}

/**
 * Marks every `const` that holds a configured binding. A `const` may alias
 * another one declared later, so declarators are revisited until none changes.
 */
export function markConfiguredBindings(
  scopes: ScopeIndex,
  bindings: WranglerBindings
): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const { node, scope } of scopes.declarators) {
      if (markDeclarator(scopes, bindings, node, scope)) {
        changed = true;
      }
    }
  }
}
