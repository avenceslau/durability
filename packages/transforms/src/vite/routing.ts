import { resolveBinding, type Scope } from './scopes.js';
import {
  identifierName,
  memberExpressionTypes,
  propertyName,
  syntaxNode,
  unwrapExpression,
  type SyntaxNode,
} from './syntax.js';

export type RoutingInjection = { at: number; text: string };

const objectHasProperty = (object: SyntaxNode, name: string): boolean => {
  const properties = Array.isArray(object.properties) ? object.properties : [];
  return properties.some((value) => {
    const property = syntaxNode(value);
    if (
      !property ||
      (property.type !== 'ObjectProperty' && property.type !== 'ObjectMethod')
    ) {
      return false;
    }
    const key = syntaxNode(property.key);
    return property.computed === true
      ? key?.type === 'StringLiteral' && key.value === name
      : (identifierName(key) ?? key?.value) === name;
  });
};

function clientExportName(
  program: SyntaxNode,
  targetName: string,
  durableObjectClassNames: ReadonlySet<string>
): string {
  const statements = Array.isArray(program.body) ? program.body : [];
  const localClasses = new Set<string>();
  const exportsByLocal = new Map<string, Set<string>>();

  const addExport = (localName: string, exportName: string): void => {
    let exportNames = exportsByLocal.get(localName);
    if (!exportNames) {
      exportNames = new Set();
      exportsByLocal.set(localName, exportNames);
    }
    exportNames.add(exportName);
  };

  for (const value of statements) {
    const statement = syntaxNode(value);
    const declaration =
      statement?.type === 'ExportNamedDeclaration'
        ? syntaxNode(statement.declaration)
        : statement;
    if (declaration?.type === 'ClassDeclaration') {
      const className = identifierName(syntaxNode(declaration.id));
      if (className) {
        localClasses.add(className);
        if (statement?.type === 'ExportNamedDeclaration') {
          addExport(className, className);
        }
      }
    }

    if (
      statement?.type !== 'ExportNamedDeclaration' ||
      (statement.source !== undefined && statement.source !== null)
    ) {
      continue;
    }
    const specifiers = Array.isArray(statement.specifiers)
      ? statement.specifiers
      : [];
    for (const specifierValue of specifiers) {
      const specifier = syntaxNode(specifierValue);
      if (specifier?.type !== 'ExportSpecifier') {
        continue;
      }
      const localName = identifierName(syntaxNode(specifier.local));
      const exportName = identifierName(syntaxNode(specifier.exported));
      if (localName && exportName) {
        addExport(localName, exportName);
      }
    }
  }

  if (!localClasses.has(targetName)) {
    throw new Error(
      `Durability client target "${targetName}" is not a declared local class export; set \`exportName\` explicitly`
    );
  }

  const exportNames = [...(exportsByLocal.get(targetName) ?? [])];
  if (exportNames.length === 0) {
    throw new Error(
      `Durability client target "${targetName}" is not a declared local class export; set \`exportName\` explicitly`
    );
  }
  if (exportNames.length > 1) {
    throw new Error(
      `Durability client target "${targetName}" has ambiguous class aliases (${exportNames.join(', ')}); set \`exportName\` explicitly`
    );
  }
  const exportName = exportNames[0];
  if (exportName === undefined || !durableObjectClassNames.has(exportName)) {
    throw new Error(
      `Durability client target export "${exportName}" is not declared as a local Durable Object class in the Wrangler configuration`
    );
  }
  return exportName;
}

export function collectRoutingInjections(
  code: string,
  program: SyntaxNode,
  durableObjectClassNames: ReadonlySet<string>,
  nodeScopes: WeakMap<object, Scope>,
  rootScope: Scope
): RoutingInjection[] {
  const injections: RoutingInjection[] = [];
  const visit = (value: unknown): void => {
    const node = syntaxNode(value);
    if (!node) {
      return;
    }

    if (
      node.type === 'CallExpression' ||
      node.type === 'OptionalCallExpression'
    ) {
      const callee = unwrapExpression(node.callee);
      const factoryName =
        callee &&
        memberExpressionTypes.has(callee.type) &&
        propertyName(callee) === 'client'
          ? identifierName(unwrapExpression(callee.object))
          : undefined;
      const factoryBinding = factoryName
        ? resolveBinding(
            nodeScopes.get(syntaxNode(callee?.object) ?? node) ?? rootScope,
            factoryName
          )
        : undefined;
      if (factoryBinding?.kind === 'client') {
        const argumentsList = Array.isArray(node.arguments)
          ? node.arguments
          : [];
        const config = unwrapExpression(argumentsList[0]);
        if (config?.type === 'ObjectExpression') {
          if (!objectHasProperty(config, 'exportName')) {
            const properties = Array.isArray(config.properties)
              ? config.properties
              : [];
            const targetProperty = properties.find((propertyValue) => {
              const property = syntaxNode(propertyValue);
              return (
                property?.type === 'ObjectProperty' &&
                property.computed !== true &&
                identifierName(syntaxNode(property.key)) === 'target'
              );
            });
            if (targetProperty) {
              const target = unwrapExpression(
                syntaxNode(targetProperty)?.value
              );
              if (target?.type !== 'Identifier') {
                throw new Error(
                  'Durability client target must be an Identifier; set `exportName` explicitly for dynamic targets'
                );
              }
              const targetName = identifierName(target)!;
              if (
                resolveBinding(
                  nodeScopes.get(target) ?? rootScope,
                  targetName
                ) !== rootScope.bindings.get(targetName)
              ) {
                throw new Error(
                  `Durability client target "${targetName}" is shadowed; set \`exportName\` explicitly`
                );
              }
              const exportName = clientExportName(
                program,
                targetName,
                durableObjectClassNames
              );
              if (
                typeof config.start === 'number' &&
                typeof config.end === 'number'
              ) {
                const close = config.end - 1;
                const lastProperty = syntaxNode(
                  properties[properties.length - 1]
                );
                const trailingText =
                  lastProperty && typeof lastProperty.end === 'number'
                    ? code.slice(lastProperty.end, close)
                    : '';
                const withoutComments = trailingText
                  .replace(/\/\*[\s\S]*?\*\//g, '')
                  .replace(/\/\/[^\r\n]*/g, '');
                const separator =
                  properties.length > 0 &&
                  !withoutComments.trimStart().startsWith(',')
                    ? ','
                    : '';
                injections.push({
                  at: close,
                  text: `${separator} exportName: ${JSON.stringify(exportName)}`,
                });
              }
            }
          }
        }
      }
    }

    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          visit(item);
        }
      } else {
        visit(child);
      }
    }
  };

  visit(program);
  return injections;
}
