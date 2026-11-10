export type SyntaxNode = {
  type: string;
  argument?: unknown;
  arguments?: unknown;
  body?: unknown;
  callee?: unknown;
  computed?: boolean;
  optional?: boolean;
  declaration?: unknown;
  declarations?: unknown;
  specifiers?: unknown;
  elements?: unknown;
  end?: number | null;
  exported?: unknown;
  expression?: unknown;
  id?: unknown;
  imported?: unknown;
  importKind?: unknown;
  init?: unknown;
  key?: unknown;
  kind?: unknown;
  left?: unknown;
  local?: unknown;
  name?: unknown;
  object?: unknown;
  operator?: unknown;
  param?: unknown;
  parameter?: unknown;
  params?: unknown;
  properties?: unknown;
  property?: unknown;
  shorthand?: unknown;
  source?: unknown;
  start?: number | null;
  superClass?: unknown;
  value?: unknown;
  [key: string]: unknown;
};

export const memberExpressionTypes = new Set([
  'MemberExpression',
  'OptionalMemberExpression',
]);

export const functionTypes = new Set([
  'ArrowFunctionExpression',
  'ClassMethod',
  'ClassPrivateMethod',
  'FunctionDeclaration',
  'FunctionExpression',
  'ObjectMethod',
]);

export function syntaxNode(value: unknown): SyntaxNode | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return undefined;
  }
  return value as SyntaxNode;
}

export function unwrapExpression(value: unknown): SyntaxNode | undefined {
  let node = syntaxNode(value);
  while (
    node &&
    (node.type === 'ChainExpression' ||
      node.type === 'ParenthesizedExpression' ||
      node.type === 'TSAsExpression' ||
      node.type === 'TSNonNullExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSTypeAssertion')
  ) {
    node = syntaxNode(node.expression);
  }
  return node;
}

export function propertyName(node: SyntaxNode): string | undefined {
  const property = syntaxNode(node.property);
  if (!property) {
    return undefined;
  }
  if (node.computed === true) {
    return property.type === 'StringLiteral' &&
      typeof property.value === 'string'
      ? property.value
      : undefined;
  }
  return property.type === 'Identifier' && typeof property.name === 'string'
    ? property.name
    : undefined;
}

export function identifierName(
  node: SyntaxNode | undefined
): string | undefined {
  return node?.type === 'Identifier' && typeof node.name === 'string'
    ? node.name
    : undefined;
}

export function bindingIdentifiers(value: unknown): SyntaxNode[] {
  const node = syntaxNode(value);
  if (!node) {
    return [];
  }
  if (node.type === 'Identifier') {
    return [node];
  }
  if (node.type === 'RestElement') {
    return bindingIdentifiers(node.argument);
  }
  if (node.type === 'AssignmentPattern') {
    return bindingIdentifiers(node.left);
  }
  if (node.type === 'TSParameterProperty') {
    return bindingIdentifiers(node.parameter);
  }
  if (node.type === 'ArrayPattern' && Array.isArray(node.elements)) {
    return node.elements.flatMap(bindingIdentifiers);
  }
  if (node.type === 'ObjectPattern' && Array.isArray(node.properties)) {
    return node.properties.flatMap((propertyValue) => {
      const property = syntaxNode(propertyValue);
      if (!property) {
        return [];
      }
      return property.type === 'RestElement'
        ? bindingIdentifiers(property.argument)
        : bindingIdentifiers(property.value);
    });
  }
  return [];
}
