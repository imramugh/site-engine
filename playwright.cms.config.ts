import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './apps/cms/e2e',
  outputDir: 'artifacts/playwright-cms/test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // OIDC invitations are single-use; rebuilding the ephemeral database is the
  // only valid retry, so a same-process retry would create a false failure.
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright-cms/report', open: 'never' }]],
  use: {
    baseURL: 'https://127.0.0.1:4300',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'corepack pnpm@12.8.1 --filter @site-engine/cms exec tsx e2e/server.ts',
    url: 'http://127.0.0.1:4303',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
