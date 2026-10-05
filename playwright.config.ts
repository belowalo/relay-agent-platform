import { defineConfig } from '@playwright/test';
const port = process.env.PLAYWRIGHT_PORT || '14322';
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 1000 },
    headless: true,
  },
  webServer: {
    command: 'node server/index.js',
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    env: {
      PORT: port,
      DATA_DIR: './test-results/browser-data',
      EMBEDDING_CACHE_DIR: './data/models',
    },
  },
  reporter: 'list',
});
