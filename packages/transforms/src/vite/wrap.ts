import type MagicString from 'magic-string';
import { configuredBindingKind } from './binding-kinds.js';
import {
  resolveBinding,
  type NodeRelation,
  type ScopeIndex,
} from './scopes.js';
import {
  forEachChild,
  functionTypes,
  identifierName,
  memberExpressionTypes,
  propertyName,
  syntaxNode,
  unwrapExpression,
  type SyntaxNode,
} from './syntax.js';
import type { WranglerBindings } from './wrangler.js';

type Wrapper = {
  start: number;
  end: number;
  namespaceCall?:
    | {
        calleeStart: number;
        objectEnd: number;
        calleeEnd: number;
        method: string;
        insertOptional: boolean;
      }
    | undefined;
};

function unusedName(code: string, name: string): string {
  let candidate = name;
  while (new RegExp(`\\b${candidate}\\b`).test(code)) {
    candidate += '_';
  }
  return candidate;
}

/**
 * Locates the edits that turn `namespace.get(args)` into
 * `factory(namespace, "get")(args)`, leaving the arguments untouched so they are
 * evaluated once and reused whenever the stub is restored.
 */
function namespaceCall(
  code: string,
  call: SyntaxNode,
  callee: SyntaxNode,
  method: string
): Wrapper['namespaceCall'] {
  const object = syntaxNode(callee.object);
  if (
    typeof callee.start !== 'number' ||
    typeof callee.end !== 'number' ||
    typeof object?.end !== 'number'
  ) {
    return undefined;
  }

  // Babel excludes wrapping parentheses from node ranges; keep them, and any
  // comments among them, with the object.
  let objectEnd = object.end;
  for (;;) {
    if (/[\s)]/.test(code[objectEnd] ?? '')) {
      objectEnd += 1;
    } else if (code.startsWith('/*', objectEnd)) {
      objectEnd = code.indexOf('*/', objectEnd) + 2;
    } else if (code.startsWith('//', objectEnd)) {
      objectEnd = code.indexOf('\n', objectEnd);
    } else {
      break;
    }
  }

  return {
    calleeStart: callee.start,
    objectEnd,
    calleeEnd: callee.end,
    method,
    // `env?.NS.get(id)` must still short-circuit once the chain is split.
    insertOptional:
      callee.type === 'OptionalMemberExpression' && call.optional !== true,
  };
}

type Relations = WeakMap<object, NodeRelation>;

/** Whether the node is being assigned to, declared, or deleted, not read. */
function isUnsafePosition(relations: Relations, node: SyntaxNode): boolean {
  let current = node;
  for (
    let relation = relations.get(current);
    relation;
    relation = relations.get(current)
  ) {
    const { parent, key } = relation;
    if (
      (parent.type === 'AssignmentExpression' && key === 'left') ||
      (parent.type === 'AssignmentPattern' && key === 'left') ||
      ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') &&
        key === 'left') ||
      (parent.type === 'UpdateExpression' && key === 'argument') ||
      (parent.type === 'UnaryExpression' &&
        parent.operator === 'delete' &&
        key === 'argument') ||
      (parent.type === 'VariableDeclarator' && key === 'id') ||
      (functionTypes.has(parent.type) && key === 'params') ||
      (parent.type === 'CatchClause' && key === 'param')
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

/** Whether an identifier reads a variable, as opposed to naming a property, label, or type. */
function isReferenceIdentifier(
  relations: Relations,
  node: SyntaxNode
): boolean {
  if (isUnsafePosition(relations, node)) {
    return false;
  }
  const relation = relations.get(node);
  if (!relation) {
    return false;
  }
  const { parent, key } = relation;
  if (
    (memberExpressionTypes.has(parent.type) && key === 'property') ||
    ((parent.type === 'ObjectProperty' ||
      parent.type === 'ObjectMethod' ||
      parent.type === 'ClassMethod' ||
      parent.type === 'ClassPrivateMethod') &&
      (key === 'key' || parent.shorthand === true)) ||
    parent.type === 'ImportSpecifier' ||
    parent.type === 'ImportDefaultSpecifier' ||
    parent.type === 'ImportNamespaceSpecifier' ||
    parent.type === 'ExportSpecifier' ||
    parent.type === 'LabeledStatement' ||
    parent.type === 'BreakStatement' ||
    parent.type === 'ContinueStatement' ||
    parent.type === 'MetaProperty' ||
    parent.type.startsWith('JSX') ||
    (parent.type.startsWith('TS') && key !== 'expression')
  ) {
    return false;
  }
  return true;
}

type WrapSearch = {
  code: string;
  scopes: ScopeIndex;
  bindings: WranglerBindings;
  restoreBrokenStubs: boolean | undefined;
};

/** A `get` or `getByName` call on a Durable Object namespace binding. */
function namespaceGetWrapper(
  search: WrapSearch,
  node: SyntaxNode
): Wrapper | undefined {
  const { code, scopes, bindings, restoreBrokenStubs } = search;
  if (
    (node.type !== 'CallExpression' &&
      node.type !== 'OptionalCallExpression') ||
    isUnsafePosition(scopes.relations, node)
  ) {
    return undefined;
  }

  const callee = unwrapExpression(node.callee);
  if (!callee || !memberExpressionTypes.has(callee.type)) {
    return undefined;
  }

  const method = propertyName(callee);
  if (
    (method !== 'get' && method !== 'getByName') ||
    configuredBindingKind(
      scopes,
      bindings,
      callee.object,
      scopes.nodeScopes.get(node) ?? scopes.rootScope
    ) !== 'namespace' ||
    typeof node.start !== 'number' ||
    typeof node.end !== 'number'
  ) {
    return undefined;
  }

  return {
    start: node.start,
    end: node.end,
    namespaceCall: restoreBrokenStubs
      ? namespaceCall(code, node, callee, method)
      : undefined,
  };
}

/** A read of a wrapped binding: `env.NAME`, or a name destructured from `env`. */
function stubReferenceWrapper(
  search: WrapSearch,
  node: SyntaxNode
): Wrapper | undefined {
  const { scopes, bindings } = search;
  if (typeof node.start !== 'number' || typeof node.end !== 'number') {
    return undefined;
  }

  if (memberExpressionTypes.has(node.type)) {
    const isStub =
      configuredBindingKind(
        scopes,
        bindings,
        node,
        scopes.nodeScopes.get(node) ?? scopes.rootScope
      ) === 'stub' && !isUnsafePosition(scopes.relations, node);
    return isStub ? { start: node.start, end: node.end } : undefined;
  }

  if (
    node.type !== 'Identifier' ||
    !isReferenceIdentifier(scopes.relations, node)
  ) {
    return undefined;
  }
  const name = identifierName(node);
  const binding = name
    ? resolveBinding(scopes.nodeScopes.get(node), name)
    : undefined;
  return binding?.kind === 'stub' && binding.wrapReferences
    ? { start: node.start, end: node.end }
    : undefined;
}

/**
 * Finds every expression to wrap in a transformable stub. Where one wrapped
 * expression contains another, only the outer one is returned.
 */
export function findWrappers(search: WrapSearch, ast: unknown): Wrapper[] {
  const wrappers: Wrapper[] = [];
  const visit = (value: unknown): void => {
    const node = syntaxNode(value);
    if (!node) {
      return;
    }

    const wrapper =
      namespaceGetWrapper(search, node) ?? stubReferenceWrapper(search, node);
    if (wrapper) {
      wrappers.push(wrapper);
    }
    forEachChild(node, visit);
  };
  visit(ast);

  const outermost: Wrapper[] = [];
  let coveredUntil = -1;
  for (const wrapper of wrappers.sort(
    (left, right) => left.start - right.start || right.end - left.end
  )) {
    if (wrapper.end <= coveredUntil) {
      continue;
    }
    outermost.push(wrapper);
    coveredUntil = wrapper.end;
  }
  return outermost;
}

/** Rewrites each wrapper's source range and imports the helpers it calls. */
export function applyWrappers(
  transformed: MagicString,
  code: string,
  wrappers: Wrapper[]
): void {
  const helperName = unusedName(code, '__doTransformsCreateStub');
  const restoreHelperName = unusedName(code, '__doTransformsRestorableStub');
  const imports = new Set<string>();

  for (const wrapper of wrappers) {
    const call = wrapper.namespaceCall;
    if (!call) {
      imports.add(`createTransformStub as ${helperName}`);
      transformed.prependLeft(wrapper.start, `${helperName}(`);
      transformed.appendRight(wrapper.end, ')');
      continue;
    }

    imports.add(`createRestorableStubFactory as ${restoreHelperName}`);
    transformed.prependLeft(call.calleeStart, `${restoreHelperName}(`);
    transformed.overwrite(
      call.objectEnd,
      call.calleeEnd,
      `, ${JSON.stringify(call.method)})${call.insertOptional ? '?.' : ''}`
    );
  }

  const importOffset = code.startsWith('#!') ? code.indexOf('\n') + 1 : 0;
  transformed.prependLeft(
    importOffset,
    `import { ${[...imports].join(', ')} } from '@durability/transforms';\n`
  );
}
