import { writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { parse as parseJavaScript } from '@babel/parser';
import MagicString from 'magic-string';
import type { Plugin, ResolvedConfig } from 'vite';
import { wranglerBindingTypes } from './declarations.js';
import { collectRoutingInjections } from './routing.js';
import {
  clientFactories,
  platformEntrypointNames,
  resolveBinding,
  type BindingKind,
  type NodeRelation,
  type Scope,
} from './scopes.js';
import {
  bindingIdentifiers,
  forEachChild,
  functionTypes,
  identifierName,
  memberExpressionTypes,
  propertyName,
  syntaxNode,
  unwrapExpression,
  type SyntaxNode,
} from './syntax.js';
import { unwrappedBindingTypes } from './wrangler.js';
import { namespaceCall, unusedName, type Wrapper } from './wrap.js';

/** Configuration for the durability transforms Vite plugin. */
export type DoTransformsPluginOptions = {
  /** Wrangler config path relative to the Vite root. Defaults to `wrangler.jsonc`. */
  wrangler?: string;
  /** Generated declaration path relative to the Vite root, or false to disable generation. */
  types?: string | false;
  /**
   * Replaces a Durable Object stub after a call through it throws, so later
   * calls do not reuse a broken stub. Failed calls are not retried. Defaults to
   * false.
   */
  restoreBrokenStubs?: boolean;
};

/**
 * Adds caller transform support to every object binding in the Wrangler config.
 *
 * The plugin reads Wrangler bindings, wraps Durable Object stubs and all other
 * object bindings (services, KV, R2, Workflows, queues, and so on) with
 * `createTransformStub`, and generates declarations that add `.with(...)` to
 * their Wrangler-inferred types. Plain values such as vars, secrets, and module
 * blobs are left alone. It must run before other source transforms.
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
  let stubBindingNames = new Set<string>();
  let durableObjectClassNames = new Set<string>();

  return {
    name: 'do-transforms',
    enforce: 'pre',
    async configResolved(config: ResolvedConfig) {
      const wranglerPath = resolve(
        config.root,
        options.wrangler ?? 'wrangler.jsonc'
      );
      const wranglerModule = await import('wrangler');
      let wrangler: import('wrangler').Unstable_Config;
      try {
        wrangler = wranglerModule.unstable_readConfig(
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
      durableObjectBindingNames = new Set(
        durableObjectBindings.map((binding) => binding.name)
      );
      const bindings =
        wranglerModule.unstable_convertConfigBindingsToStartWorkerBindings(
          wrangler
        ) ?? {};
      stubBindingNames = new Set(
        Object.entries(bindings).flatMap(([name, binding]) => {
          const type: unknown = Reflect.get(Object(binding), 'type');
          return typeof type !== 'string' ||
            unwrappedBindingTypes.has(type) ||
            type.startsWith('unsafe_')
            ? []
            : [name];
        })
      );
      durableObjectClassNames = new Set([
        ...durableObjectBindings.flatMap((binding) =>
          binding.script_name === undefined ? [binding.class_name] : []
        ),
        ...(wrangler.migrations ?? []).flatMap((migration) => [
          ...(migration.new_sqlite_classes ?? []),
          ...(migration.new_classes ?? []),
        ]),
      ]);

      if (options.types === false || !wrangler.main) {
        return;
      }

      const mainPath = resolve(dirname(wranglerPath), wrangler.main);
      const typesPath = options.types
        ? resolve(config.root, options.types)
        : resolve(dirname(mainPath), 'do-transforms.generated.d.ts');
      if (!typesPath.endsWith('.d.ts')) {
        throw new Error(
          `do-transforms types path must end in .d.ts: ${typesPath}`
        );
      }
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
            ? `import(${JSON.stringify(modulePath)}).${className}`
            : undefined;
        return {
          binding: /^[A-Z_$][\w$]*$/i.test(binding.name)
            ? binding.name
            : JSON.stringify(binding.name),
          localClass,
        };
      });
      let wranglerEnvTypes: string | null;
      try {
        ({ env: wranglerEnvTypes } =
          await wranglerModule.experimental_generateTypes({
            config: wranglerPath,
            includeRuntime: false,
            path: typesPath,
          }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw Object.assign(
          new Error(
            `do-transforms could not generate Wrangler binding types for ${wranglerPath}: ${detail}`
          ),
          { cause: error }
        );
      }
      const bindingTypes = wranglerBindingTypes(wranglerEnvTypes ?? '');
      const stubTypeEntries = [...stubBindingNames].flatMap((name) => {
        const type = bindingTypes.get(name);
        if (type === undefined) {
          return [];
        }
        return [
          {
            binding: /^[A-Z_$][\w$]*$/i.test(name)
              ? name
              : JSON.stringify(name),
            type,
          },
        ];
      });
      const declarations = (indent: string) =>
        [
          ...durableObjectTypeEntries.map(({ binding, localClass }) =>
            localClass
              ? `${indent}${binding}: TransformDurableObjectNamespace<\n${indent}  ${localClass}\n${indent}>;`
              : `${indent}${binding}: TransformDurableObjectNamespace;`
          ),
          ...stubTypeEntries.map(
            ({ binding, type }) =>
              `${indent}${binding}: TransformStub<${type}>;`
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
      const mayWrapBindings =
        durableObjectBindingNames.size > 0 || stubBindingNames.size > 0;
      const mayInjectRouting = [...clientFactories.values()].some((name) =>
        code.includes(name)
      );
      if (
        cleanId.includes('/node_modules/') ||
        !/\.[cm]?[jt]sx?$/.test(cleanId) ||
        (!mayWrapBindings && !mayInjectRouting)
      ) {
        return null;
      }

      const ast = parseJavaScript(code, {
        sourceType: 'unambiguous',
        plugins: ['decorators-legacy', 'jsx', 'typescript'],
      });
      const program = syntaxNode(
        (ast as unknown as { program?: unknown }).program
      );
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
          forEachChild(node, (child, childKey) => {
            index(child, blockScope, node, childKey);
          });
          return;
        }

        if (
          node.type === 'ClassDeclaration' ||
          node.type === 'ClassExpression'
        ) {
          const className = identifierName(syntaxNode(node.id));
          if (className) {
            scope.bindings.set(className, {
              kind: 'other',
              wrapReferences: false,
            });
          }
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
            const name = identifierName(syntaxNode(node.id));
            if (name) {
              scope.bindings.set(name, {
                kind: 'other',
                wrapReferences: false,
              });
            }
          }
          const functionScope: Scope = {
            parent: scope,
            bindings: new Map(),
            trustedThisEnv: scope.trustedThisEnv ?? false,
          };
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
          const handlerName =
            node.type === 'FunctionDeclaration'
              ? identifierName(syntaxNode(node.id))
              : identifierName(syntaxNode(node.key));
          const hasWorkerEnvParameter =
            handlerName !== undefined &&
            ['email', 'fetch', 'queue', 'scheduled', 'tail'].includes(
              handlerName
            );
          for (const [parameterIndex, param] of params.entries()) {
            for (const identifier of bindingIdentifiers(param)) {
              const name = identifierName(identifier);
              if (name) {
                functionScope.bindings.set(name, {
                  kind:
                    hasWorkerEnvParameter &&
                    parameterIndex === 1 &&
                    syntaxNode(param)?.type === 'Identifier'
                      ? 'env'
                      : 'other',
                  wrapReferences: false,
                });
              }
            }
          }
          forEachChild(node, (child, childKey) => {
            if (childKey === 'id') {
              return;
            }
            const childScope =
              childKey === 'params' || childKey === 'body'
                ? functionScope
                : scope;
            index(child, childScope, node, childKey);
          });
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
          node.type === 'ImportDefaultSpecifier' ||
          node.type === 'ImportNamespaceSpecifier' ||
          node.type === 'ImportSpecifier'
        ) {
          const localName = identifierName(syntaxNode(node.local));
          if (localName) {
            const importSource = syntaxNode(parent?.source);
            const importedName = identifierName(syntaxNode(node.imported));
            const isTypeOnlyImport =
              parent?.importKind === 'type' || node.importKind === 'type';
            const isClientFactoryImport =
              !isTypeOnlyImport &&
              node.type === 'ImportSpecifier' &&
              importSource?.type === 'StringLiteral' &&
              typeof importSource.value === 'string' &&
              importedName !== undefined &&
              clientFactories.get(importSource.value) === importedName;
            scope.bindings.set(localName, {
              kind: isClientFactoryImport
                ? 'client'
                : node.type === 'ImportSpecifier' &&
                    importedName === 'env' &&
                    importSource?.type === 'StringLiteral' &&
                    importSource.value === 'cloudflare:test'
                  ? 'env'
                  : 'other',
              wrapReferences: false,
            });
          }
        }

        forEachChild(node, (child, childKey) => {
          index(child, scope, node, childKey);
        });
      };

      index(ast, rootScope);

      const routingInjections =
        mayInjectRouting && program
          ? collectRoutingInjections(
              code,
              program,
              durableObjectClassNames,
              nodeScopes,
              rootScope
            )
          : [];

      const isEnvRoot = (value: unknown, scope: Scope): boolean => {
        const node = unwrapExpression(value);
        if (!node) {
          return false;
        }
        if (node.type === 'Identifier' && typeof node.name === 'string') {
          return (
            resolveBinding(nodeScopes.get(node) ?? scope, node.name)?.kind ===
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
          return binding?.kind === 'namespace' || binding?.kind === 'stub'
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
        return name && stubBindingNames.has(name) ? 'stub' : undefined;
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
                  : stubBindingNames.has(name)
                    ? 'stub'
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
                binding.wrapReferences = kind === 'stub';
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

      const wrappers: Wrapper[] = [];
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
              wrappers.push({
                start: node.start,
                end: node.end,
                namespaceCall: options.restoreBrokenStubs
                  ? namespaceCall(code, node, callee, method)
                  : undefined,
              });
            }
          }
        }

        if (
          memberExpressionTypes.has(node.type) &&
          configuredBindingKind(node, nodeScopes.get(node) ?? rootScope) ===
            'stub' &&
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
            binding?.kind === 'stub' &&
            binding.wrapReferences &&
            typeof node.start === 'number' &&
            typeof node.end === 'number'
          ) {
            wrappers.push({ start: node.start, end: node.end });
          }
        }

        forEachChild(node, visit);
      };

      if (mayWrapBindings) {
        visit(ast);
      }
      const uniqueWrappers: Wrapper[] = [];
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
      if (uniqueWrappers.length === 0 && routingInjections.length === 0) {
        return null;
      }

      const transformed = new MagicString(code);
      for (const injection of routingInjections) {
        transformed.prependLeft(injection.at, injection.text);
      }
      if (uniqueWrappers.length > 0) {
        const helperName = unusedName(code, '__doTransformsCreateStub');
        const restoreHelperName = unusedName(
          code,
          '__doTransformsRestorableStub'
        );
        const imports = new Set<string>();
        for (const wrapper of uniqueWrappers) {
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

      return {
        code: transformed.toString(),
        map: transformed.generateMap({ hires: true, source: cleanId }),
      };
    },
  };
}
