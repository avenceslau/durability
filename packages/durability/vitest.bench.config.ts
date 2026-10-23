import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Opt-in load characterization. Not part of `pnpm test`; run via `pnpm bench:load`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.bench.jsonc' },
    }),
  ],
  test: {
    include: ['bench/**/*.bench.ts'],
    disableConsoleIntercept: true,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
