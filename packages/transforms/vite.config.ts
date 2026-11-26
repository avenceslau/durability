import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { resolve } from 'node:path';
import { build } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
import { doTransforms } from './src/vite';

// The plugin tests load the real Wrangler package, which only runs in Node.
const nodeTests = ['tests/vite.test.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: nodeTests,
        },
      },
      {
        test: {
          name: 'workers',
          exclude: [...configDefaults.exclude, ...nodeTests],
        },
        plugins: [
          doTransforms({
            wrangler: './wrangler.test.jsonc',
            restoreBrokenStubs: true,
            cacheEntrypoints: true,
          }),
          cloudflareTest(async () => {
            const result = await build({
              configFile: false,
              build: {
                write: false,
                rollupOptions: {
                  external: ['cloudflare:workers'],
                  preserveEntrySignatures: 'strict',
                  input: resolve(
                    import.meta.dirname,
                    'tests/cross-worker-service.ts'
                  ),
                },
              },
            });

            const outputs = Array.isArray(result) ? result : [result];

            const serviceModule = outputs
              .flatMap((output) => ('output' in output ? output.output : []))
              .find((output) => output.type === 'chunk');

            if (serviceModule === undefined) {
              throw new Error('Cross-worker service bundle was not generated');
            }

            return {
              wrangler: { configPath: './wrangler.test.jsonc' },
              // Exports are found by reading the main module without Vite
              // plugins, so they miss the generated cache entrypoint.
              additionalExports: { CacheDOReads: 'WorkerEntrypoint' },
              miniflare: {
                workers: [
                  {
                    name: 'do-transforms-cross-worker',
                    compatibilityDate: '2026-07-07',
                    modules: [
                      {
                        type: 'ESModule',
                        path: 'cross-worker-service.mjs',
                        contents: serviceModule.code,
                      },
                    ],
                  },
                ],
              },
            };
          }),
        ],
      },
    ],
  },
});
