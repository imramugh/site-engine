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
  for (const provider of ['openai', 'anthropic'] as const) {
    if (data.integrations.find((integration) => integration.provider === provider)?.credentialConfigured) {
      const revoked = await page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'revoke', provider } })
      expect(revoked.status()).toBe(200)
    }
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
    await owner.page.getByRole('textbox', { name: 'Model', exact: true }).fill('gpt-4.1-mini')
    await owner.page.getByLabel('Credential').fill('synthetic-routing-credential')
    await owner.page.getByLabel('Input micro-USD per million tokens').fill('1000000')
    await owner.page.getByLabel('Output micro-USD per million tokens').fill('2000000')
    await owner.page.getByLabel('Reviewed pricing source').fill('https://prices.example.test/vision-review')
    await owner.page.getByLabel('Pricing as of').fill('2026-10-06')
    await owner.page.getByRole('button', { name: 'Save configuration' }).click()
    await expect(owner.page.getByRole('status')).toContainText('saved')
    const fallbackProvider = owner.page.locator('[data-provider="anthropic"]')
    await fallbackProvider.getByRole('button', { name: /Add key|Replace key/ }).click()
    await owner.page.getByRole('textbox', { name: 'Model', exact: true }).fill('claude-reviewed')
    await owner.page.getByLabel('Credential').fill('synthetic-routing-fallback-credential')
    await owner.page.getByLabel('Input micro-USD per million tokens').fill('1000000')
    await owner.page.getByLabel('Output micro-USD per million tokens').fill('2000000')
    await owner.page.getByLabel('Reviewed pricing source').fill('https://prices.example.test/routing-fallback-review')
    await owner.page.getByLabel('Pricing as of').fill('2026-10-06')
    await owner.page.getByRole('button', { name: 'Save configuration' }).click()
    await expect(owner.page.getByRole('status')).toContainText('saved')

    for (const kind of ['summary', 'meta', 'faq', 'alt']) {
      const row = owner.page.locator(`[data-ai-job-default="${kind}"]`)
      const saved = owner.page.waitForResponse((response) => response.url().endsWith('/api/integrations') && response.request().method() === 'POST' && (response.request().postDataJSON() as { action?: string }).action === 'configure-ai-default')
      await row.getByLabel(`${kind} provider`).selectOption('openai')
      expect((await saved).status()).toBe(200)
      await expect(row).toContainText('gpt-4.1-mini')
    }
    const summary = owner.page.locator('[data-ai-job-default="summary"]')
    const fallbackSaved = owner.page.waitForResponse((response) => response.url().endsWith('/api/integrations') && response.request().method() === 'POST' && (response.request().postDataJSON() as { action?: string }).action === 'configure-ai-default')
    await summary.getByLabel('summary fallback provider').selectOption('anthropic')
    expect((await fallbackSaved).status()).toBe(200)
    const leadReply = owner.page.locator('[data-ai-job-default="lead-reply"]')
    const leadReplySaved = owner.page.waitForResponse((response) => response.url().endsWith('/api/integrations') && response.request().method() === 'POST' && (response.request().postDataJSON() as { action?: string }).action === 'configure-ai-default')
    await leadReply.getByLabel('lead-reply provider').selectOption('openai')
    expect((await leadReplySaved).status()).toBe(200)
    await owner.page.reload()
    await expect(summary.getByLabel('summary fallback provider')).toHaveValue('anthropic')
    await expect(leadReply.getByLabel('lead-reply reviewed model')).toHaveValue('gpt-4.1-mini')
    const invalidFallback = await owner.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'configure-ai-default', jobType: 'summary', provider: 'openai', model: 'gpt-4.1-mini', fallbackProvider: 'google-gemini' } })
    expect(invalidFallback.status()).toBe(400)
    await owner.page.reload()
    await expect(summary.getByLabel('summary fallback provider')).toHaveValue('anthropic')
    const defaults = await owner.page.request.get('/api/integrations')
    expect(defaults.status()).toBe(200)
    const data = await defaults.json() as { aiJobDefaults: Array<{ jobType: string; provider: string; model: string; fallbackProvider: string | null }> }
    expect(data.aiJobDefaults).toEqual(expect.arrayContaining(['meta', 'faq', 'alt'].map((jobType) => expect.objectContaining({ jobType, provider: 'openai', model: 'gpt-4.1-mini' }))))
    expect(data.aiJobDefaults).toEqual(expect.arrayContaining([expect.objectContaining({ jobType: 'summary', provider: 'openai', model: 'gpt-4.1-mini', fallbackProvider: 'anthropic' }), expect.objectContaining({ jobType: 'lead-reply', provider: 'openai', model: 'gpt-4.1-mini', fallbackProvider: null })]))

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


test('ENG-023 Owner routes each task only through configured reviewed models and preserves fallbacks', async ({ browser }) => {
  const owner = await signedIn(browser)
  type RoutedDefault = { jobType: string; provider: string; model: string; fallbackProvider: string | null }
  const integrations = [
    { id: 'openai', provider: 'openai', model: 'gpt-4.1-mini', fallbackProvider: 'anthropic', monthlyCapMicroUsd: null, monthlyUsageMicroUsd: 0, usageMonth: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, pricingSource: 'https://prices.example.test/openai', pricingAsOf: '2026-10-08T00:00:00.000Z', health: 'connected', testedAt: null, credentialConfigured: true, credentialHint: '••••openai' },
    { id: 'anthropic', provider: 'anthropic', model: 'claude-reviewed', fallbackProvider: null, monthlyCapMicroUsd: null, monthlyUsageMicroUsd: 0, usageMonth: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, pricingSource: 'https://prices.example.test/anthropic', pricingAsOf: '2026-10-08T00:00:00.000Z', health: 'connected', testedAt: null, credentialConfigured: true, credentialHint: '••••anthropic' },
    { id: 'openrouter', provider: 'openrouter', model: 'router-reviewed', fallbackProvider: null, monthlyCapMicroUsd: null, monthlyUsageMicroUsd: 0, usageMonth: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, pricingSource: 'https://prices.example.test/openrouter', pricingAsOf: '2026-10-08T00:00:00.000Z', health: 'connected', testedAt: null, credentialConfigured: true, credentialHint: '••••router' },
  ]
  const defaults: RoutedDefault[] = [{ jobType: 'summary', provider: 'anthropic', model: 'claude-reviewed', fallbackProvider: 'openai' }]
  const requests: RoutedDefault[] = []
  const credentialRequests: Array<{ provider?: string; fallbackProvider?: string | null }> = []
  let rejectNext = false
  await owner.page.route('**/api/integrations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ integrations, aiJobDefaults: defaults, capabilities: { identity: { local: { configured: true, users: 1, lastUsedAt: null, sensitiveReauthMinutes: 15 } }, assistants: { oauthConfigured: false, endpoint: null }, email: { workerConfigured: false }, notifications: { queued: 0, delivered: 0, failed: 0 } } }) })
      return
    }
    const body = route.request().postDataJSON() as { action?: string } & RoutedDefault
    if (body.action === 'configure') {
      credentialRequests.push({ provider: body.provider, fallbackProvider: body.fallbackProvider })
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ integration: integrations.find((item) => item.provider === body.provider) }) })
      return
    }
    if (body.action !== 'configure-ai-default') return route.continue()
    requests.push({ jobType: body.jobType, provider: body.provider, model: body.model, fallbackProvider: body.fallbackProvider })
    if (rejectNext) { await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'The selected fallback is unavailable.' }) }); return }
    const index = defaults.findIndex((item) => item.jobType === body.jobType)
    if (index >= 0) defaults[index] = { jobType: body.jobType, provider: body.provider, model: body.model, fallbackProvider: body.fallbackProvider }
    else defaults.push({ jobType: body.jobType, provider: body.provider, model: body.model, fallbackProvider: body.fallbackProvider })
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ aiJobDefault: defaults.find((item) => item.jobType === body.jobType) }) })
  })
  try {
    await owner.page.goto('/integrations?tab=ai')
    const openAI = owner.page.locator('[data-provider="openai"]')
    await openAI.getByRole('button', { name: 'Replace key' }).click()
    await owner.page.getByRole('textbox', { name: 'Model', exact: true }).fill('gpt-4.1-mini')
    await owner.page.getByLabel('Credential').fill('replacement-credential')
    await owner.page.getByLabel('Input micro-USD per million tokens').fill('1')
    await owner.page.getByLabel('Output micro-USD per million tokens').fill('1')
    await owner.page.getByLabel('Reviewed pricing source').fill('https://prices.example.test/openai')
    await owner.page.getByLabel('Pricing as of').fill('2026-10-08')
    await owner.page.getByRole('button', { name: 'Save configuration' }).click()
    await expect.poll(() => credentialRequests.length).toBe(1)
    expect(credentialRequests[0]).toEqual({ provider: 'openai', fallbackProvider: 'anthropic' })
    const summary = owner.page.locator('[data-ai-job-default="summary"]')
    const leadReply = owner.page.locator('[data-ai-job-default="lead-reply"]')
    await expect(leadReply).toContainText('Lead reply')
    await expect(summary.getByLabel('summary provider')).toHaveValue('anthropic')
    await expect(summary.getByLabel('summary reviewed model')).toHaveValue('claude-reviewed')
    await expect(summary.getByLabel('summary fallback provider')).toHaveValue('openai')
    await expect(summary.getByLabel('summary provider').locator('option')).toHaveText(['Select provider', 'OpenAI', 'Anthropic', 'OpenRouter'])

    await summary.getByLabel('summary provider').selectOption('openrouter')
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toEqual({ jobType: 'summary', provider: 'openrouter', model: 'router-reviewed', fallbackProvider: 'openai' })
    await expect(summary.getByLabel('summary reviewed model')).toHaveValue('router-reviewed')
    await expect(summary.getByLabel('summary fallback provider')).toHaveValue('openai')

    await summary.getByLabel('summary fallback provider').selectOption('anthropic')
    await expect.poll(() => requests.length).toBe(2)
    expect(requests[1]).toEqual({ jobType: 'summary', provider: 'openrouter', model: 'router-reviewed', fallbackProvider: 'anthropic' })
    await owner.page.reload()
    await expect(summary.getByLabel('summary fallback provider')).toHaveValue('anthropic')

    rejectNext = true
    await summary.getByLabel('summary fallback provider').selectOption('openai')
    await expect(owner.page.locator('[data-integrations-status]')).toContainText('The selected fallback is unavailable.')
    await expect(summary.getByLabel('summary fallback provider')).toHaveValue('anthropic')
  } finally {
    await owner.context.close()
  }
})
