import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { resolve } from 'node:path';
import { build, defineConfig } from 'vite';
import { doTransforms } from './src/vite';

export default defineConfig({
  plugins: [
    doTransforms({ wrangler: './wrangler.test.jsonc' }),
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
});
