import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// `DURABILITY_DEV=1` builds the package in dev mode and logs every operation.
export default defineConfig({
  define:
    process.env['DURABILITY_DEV'] === '1' ? { __DURABILITY_DEV__: 'true' } : {},
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
    }),
  ],
  test: {
    include: ['tests/**/*.worker.test.ts'],
  },
});
