// End-to-end smoke only; unit tests run under Vitest (`npm test`). `npm run test:e2e` builds dist/ first.
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PORT) || 8765;

export default defineConfig({
  testDir: 'test/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  webServer: {
    command: 'node test/fixtures/serve.mjs',
    url: `http://127.0.0.1:${PORT}/fields.html`,
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
