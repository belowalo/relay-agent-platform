import { defineConfig } from '@playwright/test';
const port = Number(process.env.PLAYWRIGHT_PORT || process.env.RELAY_BROWSER_TEST_PORT || 14322);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid PLAYWRIGHT_PORT');
const external = process.env.PLAYWRIGHT_BASE_URL;
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: external || `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    headless: true,
  },
  webServer: external
    ? undefined
    : {
        command: 'node server/index.js',
        url: `http://127.0.0.1:${port}/api/health`,
        reuseExistingServer: false,
        env: {
          PORT: String(port),
          RELAY_PROFILE: 'local',
          DATA_DIR: `./test-results/browser-data-${port}`,
          EMBEDDING_CACHE_DIR: './data/models',
        },
      },
  reporter: [['list'], ['json', { outputFile: 'test-results/browser-report.json' }]],
});
