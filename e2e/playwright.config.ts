import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (Phase 6H): the real web app, API and worker on their own ports, against the
 * local infrastructure (PostgreSQL, Redis, S3), with a fake OpenAI endpoint. Needs a built API
 * (`pnpm --filter @insightai/api build`), migrated database and `npx playwright install chromium`.
 */
const API_PORT = 3200;
const WEB_PORT = 5180;
const LLM_PORT = 18080;

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: '../test-results/e2e',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/fake-openai.mjs',
      cwd: '..',
      url: `http://127.0.0.1:${LLM_PORT}/health`,
      env: { FAKE_OPENAI_PORT: String(LLM_PORT) },
      reuseExistingServer: false,
    },
    {
      command: 'node e2e/backend.mjs',
      cwd: '..',
      url: `http://localhost:${API_PORT}/health/live`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        PORT: String(API_PORT),
        QUEUE_PREFIX: 'insightai-e2e',
        RATE_LIMIT_ENABLED: 'false',
        LOG_LEVEL: 'warn',
        OPENAI_API_KEY: 'e2e-fake-key',
        OPENAI_MODEL: 'e2e-fake',
        OPENAI_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
      },
    },
    {
      command: `pnpm --filter @insightai/web exec vite --port ${WEB_PORT} --strictPort`,
      cwd: '..',
      url: `http://localhost:${WEB_PORT}`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { VITE_API_PROXY_TARGET: `http://localhost:${API_PORT}` },
    },
  ],
});
