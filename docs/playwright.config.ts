import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  workers: 2,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:8793',
    ...devices['Desktop Chrome'],
    colorScheme: 'light',
  },
  webServer: {
    command: 'pnpm preview --port 8793',
    url: 'http://localhost:8793',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
