import { dirname, resolve } from 'node:path';
import { parse as parseJavaScript } from '@babel/parser';
import MagicString from 'magic-string';
import type { Plugin, ResolvedConfig } from 'vite';
import { markConfiguredBindings } from './binding-kinds.js';
import { writeBindingDeclarations } from './declarations.js';
import { collectRoutingInjections } from './routing.js';
import { clientFactories, indexScopes } from './scopes.js';
import { syntaxNode } from './syntax.js';
import { loadWranglerProject, type WranglerBindings } from './wrangler.js';
import { applyWrappers, findWrappers } from './wrap.js';

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
  let bindings: WranglerBindings = {
    durableObjectBindingNames: new Set(),
    stubBindingNames: new Set(),
    durableObjectClassNames: new Set(),
  };

  return {
    name: 'do-transforms',
    enforce: 'pre',
    async configResolved(config: ResolvedConfig) {
      const wranglerPath = resolve(
        config.root,
        options.wrangler ?? 'wrangler.jsonc'
      );
      const project = await loadWranglerProject(wranglerPath);
      bindings = project.bindings;

      if (options.types === false || !project.config.main) {
        return;
      }

      const mainPath = resolve(dirname(wranglerPath), project.config.main);
      const typesPath = options.types
        ? resolve(config.root, options.types)
        : resolve(dirname(mainPath), 'do-transforms.generated.d.ts');
      await writeBindingDeclarations(project, mainPath, typesPath);
    },
    transform(code, id) {
      const cleanId = id.split('?')[0] ?? id;
      const mayWrapBindings =
        bindings.durableObjectBindingNames.size > 0 ||
        bindings.stubBindingNames.size > 0;
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
      const scopes = indexScopes(ast);

      const routingInjections =
        mayInjectRouting && program
          ? collectRoutingInjections(
              code,
              program,
              bindings.durableObjectClassNames,
              scopes.nodeScopes,
              scopes.rootScope
            )
          : [];

      markConfiguredBindings(scopes, bindings);
      const wrappers = mayWrapBindings
        ? findWrappers(
            {
              code,
              scopes,
              bindings,
              restoreBrokenStubs: options.restoreBrokenStubs,
            },
            ast
          )
        : [];
      if (wrappers.length === 0 && routingInjections.length === 0) {
        return null;
      }

      const transformed = new MagicString(code);
      for (const injection of routingInjections) {
        transformed.prependLeft(injection.at, injection.text);
      }
      if (wrappers.length > 0) {
        applyWrappers(transformed, code, wrappers);
      }

      return {
        code: transformed.toString(),
        map: transformed.generateMap({ hires: true, source: cleanId }),
      };
    },
  };
}
