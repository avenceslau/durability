import { writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { parse as parseJavaScript } from '@babel/parser';
import MagicString from 'magic-string';
import type { Plugin, ResolvedConfig } from 'vite';

/** Configuration for the durability transforms Vite plugin. */
export type DoTransformsPluginOptions = {
  /** Wrangler config path relative to the Vite root. Defaults to `wrangler.jsonc`. */
  wrangler?: string;
  /** Generated declaration path relative to the Vite root, or false to disable generation. */
  types?: string | false;
};

type SyntaxNode = {
  type: string;
  argument?: unknown;
  callee?: unknown;
  computed?: boolean;
  declarations?: unknown;
  elements?: unknown;
  end?: number | null;
  expression?: unknown;
  id?: unknown;
  imported?: unknown;
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
  value?: unknown;
  [key: string]: unknown;
};

type BindingKind = 'env' | 'namespace' | 'other' | 'service';

type Binding = {
  kind: BindingKind;
  wrapReferences: boolean;
};

type Scope = {
  parent?: Scope;
  bindings: Map<string, Binding>;
};

type NodeRelation = {
  parent: SyntaxNode;
  key: string;
};

const memberExpressionTypes = new Set([
  'MemberExpression',
  'OptionalMemberExpression',
]);
const functionTypes = new Set([
  'ArrowFunctionExpression',
  'ClassMethod',
  'ClassPrivateMethod',
  'FunctionDeclaration',
  'FunctionExpression',
  'ObjectMethod',
]);

function syntaxNode(value: unknown): SyntaxNode | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return undefined;
  }
  return value as SyntaxNode;
}

function unwrapExpression(value: unknown): SyntaxNode | undefined {
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

function propertyName(node: SyntaxNode): string | undefined {
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

function identifierName(node: SyntaxNode | undefined): string | undefined {
  return node?.type === 'Identifier' && typeof node.name === 'string'
    ? node.name
    : undefined;
}

function bindingIdentifiers(value: unknown): SyntaxNode[] {
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

function resolveBinding(
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

/**
 * Adds transform support to configured Durable Object and service bindings.
 *
 * The plugin reads Wrangler bindings, wraps matching binding access with
 * `createTransformStub`, and generates declarations that add `.with(...)` to
 * their inferred types. It must run before other source transforms.
 *
 * @example
 * ```ts
 * import { defineConfig } from 'vite';
 * import { doTransforms } from '@durability/transforms/vite';
 *
 * export default defineConfig({
 *   plugins: [doTransforms({ wrangler: './wrangler.jsonc' })],
 * });
 * ```
 */
export function doTransforms(options: DoTransformsPluginOptions = {}): Plugin {
  let durableObjectBindingNames = new Set<string>();
  let serviceBindingNames = new Set<string>();

  return {
    name: 'do-transforms',
    enforce: 'pre',
    async configResolved(config: ResolvedConfig) {
      const wranglerPath = resolve(
        config.root,
        options.wrangler ?? 'wrangler.jsonc'
      );
      let wrangler: import('wrangler').Unstable_Config;
      try {
        const { unstable_readConfig: readConfig } = await import('wrangler');
        wrangler = readConfig(
          { config: wranglerPath },
          { hideWarnings: true, preserveOriginalMain: true }
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw Object.assign(
          new Error(
            `do-transforms could not load a valid Wrangler configuration at ${wranglerPath}: ${detail}`
          ),
          { cause: error }
        );
      }

      const durableObjectBindings = wrangler.durable_objects.bindings;
      const serviceBindings = wrangler.services ?? [];
      durableObjectBindingNames = new Set(
        durableObjectBindings.map((binding) => binding.name)
      );
      serviceBindingNames = new Set(
        serviceBindings.map((binding) => binding.binding)
      );

      if (options.types === false || !wrangler.main) {
        return;
      }

      const mainPath = resolve(dirname(wranglerPath), wrangler.main);
      const typesPath = options.types
        ? resolve(config.root, options.types)
        : resolve(dirname(mainPath), 'do-transforms.generated.d.ts');
      let modulePath = relative(dirname(typesPath), mainPath)
        .split('\\')
        .join('/');
      modulePath = modulePath.slice(0, -extname(modulePath).length);
      if (!modulePath.startsWith('.')) {
        modulePath = `./${modulePath}`;
      }

      const durableObjectTypeEntries = durableObjectBindings.map((binding) => {
        const className = binding.class_name;
        const localClass =
          binding.script_name === undefined &&
          /^[A-Z_$][\w$]*$/i.test(className)
            ? `import('${modulePath}').${className}`
            : undefined;
        return {
          binding: /^[A-Z_$][\w$]*$/i.test(binding.name)
            ? binding.name
            : JSON.stringify(binding.name),
          localClass,
        };
      });
      const serviceTypeEntries = serviceBindings.flatMap((binding) =>
        binding.service === wrangler.name && binding.entrypoint
          ? [
              {
                binding: /^[A-Z_$][\w$]*$/i.test(binding.binding)
                  ? binding.binding
                  : JSON.stringify(binding.binding),
                entrypoint: binding.entrypoint,
              },
            ]
          : []
      );
      const declarations = (indent: string) =>
        [
          ...durableObjectTypeEntries.map(({ binding, localClass }) =>
            localClass
              ? `${indent}${binding}: TransformDurableObjectNamespace<\n${indent}  ${localClass}\n${indent}>;`
              : `${indent}${binding}: TransformDurableObjectNamespace;`
          ),
          ...serviceTypeEntries.map(
            ({ binding, entrypoint }) =>
              `${indent}${binding}: TransformStub<\n${indent}  Service<typeof import('${modulePath}').${entrypoint}>\n${indent}>;`
          ),
        ].join('\n');
      const durableObjectNamespaceType =
        durableObjectTypeEntries.length === 0
          ? ''
          : `\ntype TransformDurableObjectNamespace<\n  T extends Rpc.DurableObjectBranded | undefined = undefined,\n> = Omit<DurableObjectNamespace<T>, 'get' | 'getByName'> & {\n  get(\n    id: DurableObjectId,\n    options?: DurableObjectNamespaceGetDurableObjectOptions\n  ): TransformStub<DurableObjectStub<T>>;\n  getByName(\n    name: string,\n    options?: DurableObjectNamespaceGetDurableObjectOptions\n  ): TransformStub<DurableObjectStub<T>>;\n};\n`;
      const contents = `import type { TransformStub } from '@durability/transforms';\n${durableObjectNamespaceType}\ndeclare global {\n  interface Env {\n${declarations('    ')}\n  }\n\n  namespace Cloudflare {\n    interface Env {\n${declarations('      ')}\n    }\n  }\n}\n\nexport {};\n`;

      writeFileSync(typesPath, contents);
    },
    transform(code, id) {
      const cleanId = id.split('?')[0] ?? id;
      if (
        cleanId.includes('/node_modules/') ||
        !/\.[cm]?[jt]sx?$/.test(cleanId) ||
        (durableObjectBindingNames.size === 0 && serviceBindingNames.size === 0)
      ) {
        return null;
      }

      const ast = parseJavaScript(code, {
        sourceType: 'unambiguous',
        plugins: ['decorators-legacy', 'jsx', 'typescript'],
      });
      const rootScope: Scope = { bindings: new Map() };
      const nodeScopes = new WeakMap<object, Scope>();
      const relations = new WeakMap<object, NodeRelation>();
      const declarators: Array<{ node: SyntaxNode; scope: Scope }> = [];

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
          for (const [childKey, child] of Object.entries(node)) {
            if (childKey !== 'type') {
              if (Array.isArray(child)) {
                for (const item of child) {
                  index(item, blockScope, node, childKey);
                }
              } else {
                index(child, blockScope, node, childKey);
              }
            }
          }
          return;
        }

        if (functionTypes.has(node.type)) {
          if (node.type === 'FunctionDeclaration') {
            const name = identifierName(syntaxNode(node.id));
            if (name) {
              scope.bindings.set(name, {
                kind: 'other',
                wrapReferences: false,
              });
            }
          }
          const functionScope: Scope = { parent: scope, bindings: new Map() };
          if (node.type === 'FunctionExpression') {
            const name = identifierName(syntaxNode(node.id));
            if (name) {
              functionScope.bindings.set(name, {
                kind: 'other',
                wrapReferences: false,
              });
            }
          }
          const params = Array.isArray(node.params) ? node.params : [];
          for (const param of params) {
            for (const identifier of bindingIdentifiers(param)) {
              const name = identifierName(identifier);
              if (name) {
                functionScope.bindings.set(name, {
                  kind:
                    syntaxNode(param)?.type === 'Identifier' && name === 'env'
                      ? 'env'
                      : 'other',
                  wrapReferences: false,
                });
              }
            }
          }
          for (const [childKey, child] of Object.entries(node)) {
            if (childKey === 'type' || childKey === 'id') {
              continue;
            }
            const childScope =
              childKey === 'params' || childKey === 'body'
                ? functionScope
                : scope;
            if (Array.isArray(child)) {
              for (const item of child) {
                index(item, childScope, node, childKey);
              }
            } else {
              index(child, childScope, node, childKey);
            }
          }
          return;
        }

        if (node.type === 'CatchClause') {
          const catchScope: Scope = { parent: scope, bindings: new Map() };
          for (const identifier of bindingIdentifiers(node.param)) {
            const name = identifierName(identifier);
            if (name) {
              catchScope.bindings.set(name, {
                kind: 'other',
                wrapReferences: false,
              });
            }
          }
          for (const [childKey, child] of Object.entries(node)) {
            if (childKey !== 'type') {
              index(child, catchScope, node, childKey);
            }
          }
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
              const name = identifierName(identifier);
              if (name) {
                scope.bindings.set(name, {
                  kind: 'other',
                  wrapReferences: false,
                });
              }
            }
            if (node.kind === 'const') {
              declarators.push({ node: declaration, scope });
            }
          }
        } else if (
          node.type === 'ClassDeclaration' &&
          identifierName(syntaxNode(node.id))
        ) {
          scope.bindings.set(identifierName(syntaxNode(node.id))!, {
            kind: 'other',
            wrapReferences: false,
          });
        } else if (
          (node.type === 'ImportDefaultSpecifier' ||
            node.type === 'ImportNamespaceSpecifier' ||
            node.type === 'ImportSpecifier') &&
          identifierName(syntaxNode(node.local))
        ) {
          const importSource = syntaxNode(parent?.source);
          const importedName = identifierName(syntaxNode(node.imported));
          scope.bindings.set(identifierName(syntaxNode(node.local))!, {
            kind:
              node.type === 'ImportSpecifier' &&
              importedName === 'env' &&
              importSource?.type === 'StringLiteral' &&
              importSource.value === 'cloudflare:test'
                ? 'env'
                : 'other',
            wrapReferences: false,
          });
        }

        for (const [childKey, child] of Object.entries(node)) {
          if (childKey === 'type') {
            continue;
          }
          if (Array.isArray(child)) {
            for (const item of child) {
              index(item, scope, node, childKey);
            }
          } else {
            index(child, scope, node, childKey);
          }
        }
      };

      index(ast, rootScope);

      const isEnvRoot = (value: unknown, scope: Scope): boolean => {
        const node = unwrapExpression(value);
        if (!node) {
          return false;
        }
        if (node.type === 'Identifier' && node.name === 'env') {
          return (
            resolveBinding(nodeScopes.get(node) ?? scope, 'env')?.kind === 'env'
          );
        }
        return (
          memberExpressionTypes.has(node.type) &&
          propertyName(node) === 'env' &&
          unwrapExpression(node.object)?.type === 'ThisExpression'
        );
      };

      const configuredBindingKind = (
        value: unknown,
        scope: Scope
      ): BindingKind | undefined => {
        const node = unwrapExpression(value);
        if (!node) {
          return undefined;
        }
        if (node.type === 'Identifier' && typeof node.name === 'string') {
          const binding = resolveBinding(
            nodeScopes.get(node) ?? scope,
            node.name
          );
          return binding?.kind === 'namespace' || binding?.kind === 'service'
            ? binding.kind
            : undefined;
        }
        if (
          !memberExpressionTypes.has(node.type) ||
          !isEnvRoot(node.object, scope)
        ) {
          return undefined;
        }
        const name = propertyName(node);
        if (name && durableObjectBindingNames.has(name)) {
          return 'namespace';
        }
        return name && serviceBindingNames.has(name) ? 'service' : undefined;
      };

      for (let changed = true; changed; ) {
        changed = false;
        for (const { node, scope } of declarators) {
          const bindingPattern = syntaxNode(node.id);
          if (!bindingPattern) {
            continue;
          }
          if (bindingPattern.type === 'Identifier') {
            const name = identifierName(bindingPattern);
            const binding = name ? scope.bindings.get(name) : undefined;
            const kind = configuredBindingKind(node.init, scope);
            if (binding && kind && binding.kind !== kind) {
              binding.kind = kind;
              binding.wrapReferences = false;
              changed = true;
            }
          } else if (
            bindingPattern.type === 'ObjectPattern' &&
            isEnvRoot(node.init, scope)
          ) {
            const properties = Array.isArray(bindingPattern.properties)
              ? bindingPattern.properties
              : [];
            for (const propertyValue of properties) {
              const property = syntaxNode(propertyValue);
              if (!property || property.type !== 'ObjectProperty') {
                continue;
              }
              const key = syntaxNode(property.key);
              const propertyBindings = bindingIdentifiers(property.value);
              const name =
                property.computed === true
                  ? key?.type === 'StringLiteral' &&
                    typeof key.value === 'string'
                    ? key.value
                    : undefined
                  : (identifierName(key) ??
                    (key?.type === 'StringLiteral' &&
                    typeof key.value === 'string'
                      ? key.value
                      : undefined));
              const kind = name
                ? durableObjectBindingNames.has(name)
                  ? 'namespace'
                  : serviceBindingNames.has(name)
                    ? 'service'
                    : undefined
                : undefined;
              const localName =
                propertyBindings.length === 1
                  ? identifierName(propertyBindings[0])
                  : undefined;
              const binding = localName
                ? scope.bindings.get(localName)
                : undefined;
              if (binding && kind && binding.kind !== kind) {
                binding.kind = kind;
                binding.wrapReferences = kind === 'service';
                changed = true;
              }
            }
          }
        }
      }

      const isUnsafePosition = (node: SyntaxNode): boolean => {
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
            ((parent.type === 'ForInStatement' ||
              parent.type === 'ForOfStatement') &&
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
      };

      const isReferenceIdentifier = (node: SyntaxNode): boolean => {
        if (isUnsafePosition(node)) {
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
      };

      const wrappers: Array<{ start: number; end: number }> = [];
      const visit = (value: unknown): void => {
        const node = syntaxNode(value);
        if (!node) {
          return;
        }

        if (
          (node.type === 'CallExpression' ||
            node.type === 'OptionalCallExpression') &&
          !isUnsafePosition(node)
        ) {
          const callee = unwrapExpression(node.callee);
          if (callee && memberExpressionTypes.has(callee.type)) {
            const method = propertyName(callee);
            if (
              (method === 'get' || method === 'getByName') &&
              configuredBindingKind(
                callee.object,
                nodeScopes.get(node) ?? rootScope
              ) === 'namespace' &&
              typeof node.start === 'number' &&
              typeof node.end === 'number'
            ) {
              wrappers.push({ start: node.start, end: node.end });
            }
          }
        }

        if (
          memberExpressionTypes.has(node.type) &&
          configuredBindingKind(node, nodeScopes.get(node) ?? rootScope) ===
            'service' &&
          !isUnsafePosition(node) &&
          typeof node.start === 'number' &&
          typeof node.end === 'number'
        ) {
          wrappers.push({ start: node.start, end: node.end });
        } else if (node.type === 'Identifier' && isReferenceIdentifier(node)) {
          const name = identifierName(node);
          const binding = name
            ? resolveBinding(nodeScopes.get(node), name)
            : undefined;
          if (
            binding?.kind === 'service' &&
            binding.wrapReferences &&
            typeof node.start === 'number' &&
            typeof node.end === 'number'
          ) {
            wrappers.push({ start: node.start, end: node.end });
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

      visit(ast);
      const uniqueWrappers: Array<{ start: number; end: number }> = [];
      let coveredUntil = -1;
      for (const wrapper of wrappers.sort(
        (left, right) => left.start - right.start || right.end - left.end
      )) {
        if (wrapper.end <= coveredUntil) {
          continue;
        }
        uniqueWrappers.push(wrapper);
        coveredUntil = wrapper.end;
      }
      if (uniqueWrappers.length === 0) {
        return null;
      }

      let helperName = '__doTransformsCreateStub';
      while (new RegExp(`\\b${helperName}\\b`).test(code)) {
        helperName += '_';
      }
      const transformed = new MagicString(code);
      for (const wrapper of uniqueWrappers) {
        transformed.prependLeft(wrapper.start, `${helperName}(`);
        transformed.appendRight(wrapper.end, ')');
      }
      const importOffset = code.startsWith('#!') ? code.indexOf('\n') + 1 : 0;
      transformed.prependLeft(
        importOffset,
        `import { createTransformStub as ${helperName} } from '@durability/transforms';\n`
      );

      return {
        code: transformed.toString(),
        map: transformed.generateMap({ hires: true, source: cleanId }),
      };
    },
  };
}
