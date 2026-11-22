import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 600_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:18081',
    trace: 'retain-on-failure',
  },
});
