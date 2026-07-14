import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { parse as parseJavaScript } from '@babel/parser';
import { parse as parseJsonc } from 'jsonc-parser';
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
  start?: number | null;
  end?: number | null;
  [key: string]: unknown;
};

function syntaxNode(value: unknown): SyntaxNode | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return undefined;
  }
  return value as SyntaxNode;
}

function propertyName(node: SyntaxNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === 'Identifier' && typeof node.name === 'string') {
    return node.name;
  }
  if (node.type === 'StringLiteral' && typeof node.value === 'string') {
    return node.value;
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
    configResolved(config: ResolvedConfig) {
      const wranglerPath = resolve(
        config.root,
        options.wrangler ?? 'wrangler.jsonc'
      );
      const wrangler = parseJsonc(readFileSync(wranglerPath, 'utf8')) as {
        name?: string;
        main?: string;
        durable_objects?: {
          bindings?: Array<{ name?: string; class_name?: string }>;
        };
        services?: Array<{
          binding?: string;
          service?: string;
          entrypoint?: string;
        }>;
      };
      const durableObjectBindings = wrangler.durable_objects?.bindings ?? [];
      const serviceBindings = wrangler.services ?? [];
      durableObjectBindingNames = new Set(
        durableObjectBindings.flatMap((binding) =>
          typeof binding.name === 'string' ? [binding.name] : []
        )
      );
      serviceBindingNames = new Set(
        serviceBindings.flatMap((binding) =>
          typeof binding.binding === 'string' ? [binding.binding] : []
        )
      );

      if (options.types === false || !wrangler.main) {
        return;
      }

      const typesPath = resolve(
        config.root,
        options.types ??
          `${dirname(wrangler.main)}/do-transforms.generated.d.ts`
      );
      const mainPath = resolve(config.root, wrangler.main);
      let modulePath = relative(dirname(typesPath), mainPath)
        .split('\\')
        .join('/');
      modulePath = modulePath.slice(0, -extname(modulePath).length);
      if (!modulePath.startsWith('.')) {
        modulePath = `./${modulePath}`;
      }
      const serviceTypeEntries = serviceBindings.flatMap((binding) =>
        binding.service === wrangler.name &&
        typeof binding.binding === 'string' &&
        typeof binding.entrypoint === 'string'
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
      const globalServiceDeclarations = serviceTypeEntries
        .map(
          ({ binding, entrypoint }) =>
            `    ${binding}: TransformStub<\n      Service<typeof import('${modulePath}').${entrypoint}>\n    >;`
        )
        .join('\n');
      const cloudflareServiceDeclarations = serviceTypeEntries
        .map(
          ({ binding, entrypoint }) =>
            `      ${binding}: TransformStub<\n        Service<typeof import('${modulePath}').${entrypoint}>\n      >;`
        )
        .join('\n');
      const contents = `import type { TransformStub } from '@durability/transforms';\n\ndeclare global {\n  interface DurableObjectNamespace<\n    T extends Rpc.DurableObjectBranded | undefined = undefined,\n  > {\n    get(\n      id: DurableObjectId,\n      options?: DurableObjectNamespaceGetDurableObjectOptions\n    ): TransformStub<DurableObjectStub<T>>;\n    getByName(\n      name: string,\n      options?: DurableObjectNamespaceGetDurableObjectOptions\n    ): TransformStub<DurableObjectStub<T>>;\n  }\n\n  interface Env {\n${globalServiceDeclarations}\n  }\n\n  namespace Cloudflare {\n    interface Env {\n${cloudflareServiceDeclarations}\n    }\n  }\n}\n\nexport {};\n`;

      writeFileSync(typesPath, contents);
    },
    transform(code, id) {
      const cleanId = id.split('?')[0];
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
      const wrappers: Array<{ start: number; end: number }> = [];

      const visit = (value: unknown): void => {
        const node = syntaxNode(value);
        if (!node) {
          return;
        }

        if (node.type === 'CallExpression') {
          const callee = syntaxNode(node.callee);
          const namespaceMethod =
            callee?.type === 'MemberExpression' ||
            callee?.type === 'OptionalMemberExpression'
              ? propertyName(syntaxNode(callee.property))
              : undefined;
          const namespace = syntaxNode(callee?.object);
          const bindingName =
            namespace?.type === 'MemberExpression' ||
            namespace?.type === 'OptionalMemberExpression'
              ? propertyName(syntaxNode(namespace.property))
              : undefined;

          if (
            (namespaceMethod === 'get' || namespaceMethod === 'getByName') &&
            bindingName &&
            durableObjectBindingNames.has(bindingName) &&
            typeof node.start === 'number' &&
            typeof node.end === 'number'
          ) {
            wrappers.push({ start: node.start, end: node.end });
          }
        }

        if (
          (node.type === 'MemberExpression' ||
            node.type === 'OptionalMemberExpression') &&
          serviceBindingNames.has(
            propertyName(syntaxNode(node.property)) ?? ''
          ) &&
          typeof node.start === 'number' &&
          typeof node.end === 'number'
        ) {
          wrappers.push({ start: node.start, end: node.end });
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
      if (wrappers.length === 0) {
        return null;
      }

      const transformed = new MagicString(code);
      for (const wrapper of wrappers) {
        transformed.prependLeft(wrapper.start, '__doTransformsCreateStub(');
        transformed.appendRight(wrapper.end, ')');
      }
      const importOffset = code.startsWith('#!') ? code.indexOf('\n') + 1 : 0;
      transformed.prependLeft(
        importOffset,
        `import { createTransformStub as __doTransformsCreateStub } from '@durability/transforms';\n`
      );

      return {
        code: transformed.toString(),
        map: transformed.generateMap({ hires: true, source: cleanId }),
      };
    },
  };
}
