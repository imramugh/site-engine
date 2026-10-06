import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

async function signedIn(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: 'synthetic-theme-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function cleanupAIRoutingFixture(page: Page) {
  const current = await page.request.get('/api/integrations')
  expect(current.status()).toBe(200)
  const data = await current.json() as { integrations: Array<{ provider: string; credentialConfigured: boolean }> }
  if (data.integrations.find((integration) => integration.provider === 'openai')?.credentialConfigured) {
    const revoked = await page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'revoke', provider: 'openai' } })
    expect(revoked.status()).toBe(200)
  }
  const cleaned = await page.request.post('/__e2e/eng016-ai-routing-cleanup')
  expect(cleaned.status()).toBe(200)
}

test('ENG-016 Owner configures visible AI draft routes with a reviewed vision model', async ({ browser }) => {
  const owner = await signedIn(browser)
  let ownsFixture = false
  try {
    const initial = await owner.page.request.get('/api/integrations')
    expect(initial.status()).toBe(200)
    const initialData = await initial.json() as { integrations: Array<{ provider: string }>; aiJobDefaults: Array<{ jobType: string }> }
    expect(initialData.integrations.find((integration) => integration.provider === 'openai')).toBeUndefined()
    expect(initialData.aiJobDefaults.filter((item) => ['summary', 'meta', 'faq', 'alt'].includes(item.jobType))).toEqual([])
    ownsFixture = true
    await owner.page.goto('/integrations?tab=ai')
    const provider = owner.page.locator('[data-provider="openai"]')
    await provider.getByRole('button', { name: /Add key|Replace key/ }).click()
    await owner.page.getByLabel('Model').fill('gpt-4.1-mini')
    await owner.page.getByLabel('Credential').fill('synthetic-routing-credential')
    await owner.page.getByLabel('Input micro-USD per million tokens').fill('1000000')
    await owner.page.getByLabel('Output micro-USD per million tokens').fill('2000000')
    await owner.page.getByLabel('Reviewed pricing source').fill('https://prices.example.test/vision-review')
    await owner.page.getByLabel('Pricing as of').fill('2026-10-06')
    await owner.page.getByRole('button', { name: 'Save configuration' }).click()
    await expect(owner.page.getByRole('status')).toContainText('saved')

    for (const kind of ['summary', 'meta', 'faq', 'alt']) {
      const row = owner.page.locator(`[data-ai-job-default="${kind}"]`)
      const saved = owner.page.waitForResponse((response) => response.url().endsWith('/api/integrations') && response.request().method() === 'POST' && (response.request().postDataJSON() as { action?: string }).action === 'configure-ai-default')
      await row.getByRole('combobox').selectOption('openai')
      expect((await saved).status()).toBe(200)
      await expect(row).toContainText('gpt-4.1-mini')
    }
    const defaults = await owner.page.request.get('/api/integrations')
    expect(defaults.status()).toBe(200)
    const data = await defaults.json() as { aiJobDefaults: Array<{ jobType: string; provider: string; model: string }> }
    expect(data.aiJobDefaults).toEqual(expect.arrayContaining(['summary', 'meta', 'faq', 'alt'].map((jobType) => expect.objectContaining({ jobType, provider: 'openai', model: 'gpt-4.1-mini' }))))

    for (const width of [1440, 390]) {
      await owner.page.setViewportSize({ width, height: 900 })
      expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      await owner.page.addScriptTag({ path: axeSource })
      expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
    }
  } finally {
    try { if (ownsFixture) await cleanupAIRoutingFixture(owner.page) }
    finally { await owner.context.close() }
  }
})
