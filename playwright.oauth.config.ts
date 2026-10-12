import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.OAUTH_E2E_PORT ?? '4312')
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './apps/oauth/e2e',
  outputDir: process.env.OAUTH_E2E_OUTPUT_DIR ?? 'artifacts/playwright-oauth/test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright-oauth/report', open: 'never' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'cd apps/oauth && node --import tsx e2e/server.ts',
    url: `${baseURL}/.well-known/oauth-protected-resource/mcp`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
