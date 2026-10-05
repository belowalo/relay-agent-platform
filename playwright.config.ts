import { defineConfig } from '@playwright/test';
const browserPort = process.env.RELAY_BROWSER_TEST_PORT || '14322';
const browserOrigin = `http://127.0.0.1:${browserPort}`;
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: browserOrigin,
    viewport: { width: 1440, height: 1000 },
    headless: true,
  },
  webServer: {
    command: 'node server/index.js',
    url: browserOrigin + '/api/health',
    reuseExistingServer: false,
    env: {
      PORT: browserPort,
      DATA_DIR: './test-results/browser-data',
      EMBEDDING_CACHE_DIR: './data/models',
    },
  },
  reporter: 'list',
});
