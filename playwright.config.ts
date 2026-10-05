import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:14322',
    viewport: { width: 1440, height: 1000 },
    headless: true,
  },
  webServer: {
    command: 'node server/index.js',
    url: 'http://127.0.0.1:14322/api/health',
    reuseExistingServer: false,
    env: {
      PORT: '14322',
      DATA_DIR: './test-results/browser-data',
      EMBEDDING_CACHE_DIR: './data/models',
    },
  },
  reporter: 'list',
});
