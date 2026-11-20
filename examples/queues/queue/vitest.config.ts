import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    // The tests run a whole queue against local Durable Objects, KV and R2.
    // The heaviest, a redrive of 240 dead letters, takes over half a minute
    // on a slow CI machine.
    testTimeout: 120_000,
  },
});
