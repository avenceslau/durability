import { defineConfig } from 'vitest/config';

// `DURABILITY_DEV=1` builds the package in dev mode and logs every operation.
export default defineConfig({
  define:
    process.env['DURABILITY_DEV'] === '1' ? { __DURABILITY_DEV__: 'true' } : {},
  test: {
    include: ['src/**/*.test.ts'],
  },
});
