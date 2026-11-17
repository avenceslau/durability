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
  typeAnnotation?: unknown;
  value?: unknown;
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

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return typeof value === 'object' && value !== null && 'type' in value;
}

export function syntaxNode(value: unknown): SyntaxNode | undefined {
  return isSyntaxNode(value) ? value : undefined;
}

export function isIdentifier(
  node: SyntaxNode | undefined
): node is SyntaxNode & { name: string } {
  return node?.type === 'Identifier' && typeof node.name === 'string';
}

export function isStringLiteral(
  node: SyntaxNode | undefined
): node is SyntaxNode & { value: string } {
  return node?.type === 'StringLiteral' && typeof node.value === 'string';
}

export function hasRange(
  node: SyntaxNode | undefined
): node is SyntaxNode & { start: number; end: number } {
  return typeof node?.start === 'number' && typeof node.end === 'number';
}

/**
 * Calls `visit` with every child node of a node and the key it is stored
 * under. Array children are visited item by item.
 */
export function forEachChild(
  node: SyntaxNode,
  visit: (child: SyntaxNode, key: string) => void
): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') {
      continue;
    }

    for (const item of Array.isArray(value) ? value : [value]) {
      const child = syntaxNode(item);

      if (child) {
        visit(child, key);
      }
    }
  }
}

export function unwrapExpression(
  expression: SyntaxNode | undefined
): SyntaxNode | undefined {
  let node = expression;

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
    return isStringLiteral(property) ? property.value : undefined;
  }

  return isIdentifier(property) ? property.name : undefined;
}

export function identifierName(
  node: SyntaxNode | undefined
): string | undefined {
  return isIdentifier(node) ? node.name : undefined;
}

export function bindingIdentifiers(node: SyntaxNode | undefined): SyntaxNode[] {
  if (!node) {
    return [];
  }

  if (node.type === 'Identifier') {
    return [node];
  }

  if (node.type === 'RestElement') {
    return bindingIdentifiers(syntaxNode(node.argument));
  }

  if (node.type === 'AssignmentPattern') {
    return bindingIdentifiers(syntaxNode(node.left));
  }

  if (node.type === 'TSParameterProperty') {
    return bindingIdentifiers(syntaxNode(node.parameter));
  }

  if (node.type === 'ArrayPattern' && Array.isArray(node.elements)) {
    return node.elements.flatMap((element) =>
      bindingIdentifiers(syntaxNode(element))
    );
  }

  if (node.type === 'ObjectPattern' && Array.isArray(node.properties)) {
    return node.properties.flatMap((propertyValue) => {
      const property = syntaxNode(propertyValue);

      if (!property) {
        return [];
      }

      return property.type === 'RestElement'
        ? bindingIdentifiers(syntaxNode(property.argument))
        : bindingIdentifiers(syntaxNode(property.value));
    });
  }

  return [];
}
