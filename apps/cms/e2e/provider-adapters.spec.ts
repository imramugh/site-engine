import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const adapters = ['azure-openai', 'amazon-bedrock', 'mistral', 'openai-compatible'] as const
type Adapter = typeof adapters[number]

async function signedIn(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-theme-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

const settings = (provider: Adapter) => provider === 'azure-openai'
  ? { endpoint: 'https://fixture.openai.azure.com', imageInput: true, imageInputTokenLimit: 2000 }
  : provider === 'amazon-bedrock'
    ? { region: 'us-east-1', imageInput: true, imageInputTokenLimit: 2000 }
    : provider === 'mistral'
      ? { imageInput: true, imageInputTokenLimit: 2000 }
      : { endpoint: 'https://compatible.eng027.example.test', imageInput: true, imageInputTokenLimit: 2000 }

const persistedSettings = (provider: Adapter) => provider === 'azure-openai' ? { ...settings(provider), endpoint: 'https://fixture.openai.azure.com/openai/v1' } : settings(provider)
async function configure(page: Page, provider: Adapter, fallbackProvider: Adapter) {
  const secret = `eng027-${provider}-credential-write-only`
  const response = await page.request.post('/api/integrations', {
    headers: { origin, 'content-type': 'application/json' },
    data: { action: 'configure', provider, model: `eng027-${provider}-model`, credential: secret, fallbackProvider, providerSettings: settings(provider), monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 2_000_000, pricingSource: `https://prices.example.test/eng027-${provider}`, pricingAsOf: '2026-10-11' },
  })
  expect([200, 201]).toContain(response.status())
  expect(await response.text()).not.toContain(secret)
}

async function axe(page: Page, selector = 'main') {
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async root => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run(root, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations, selector)).toEqual([])
}

test('ENG-027 encrypts adapter credentials, runs approved fallback with the isolated transport, and rejects text-only image routing', async ({ browser }, testInfo) => {
  const owner = await signedIn(browser)
  try {
    for (let index = 0; index < adapters.length; index += 1) await configure(owner.page, adapters[index]!, adapters[(index + 1) % adapters.length]!)
    const configured = await owner.page.request.get('/api/integrations')
    expect(configured.status()).toBe(200)
    const workspace = await configured.json() as { integrations: Array<{ provider: Adapter; credentialHint: string | null; providerSettings?: unknown }> }
    for (const provider of adapters) {
      const integration = workspace.integrations.find(item => item.provider === provider)
      expect(integration?.credentialHint).toContain('configured')
      expect(JSON.stringify(integration)).not.toContain(`eng027-${provider}-credential-write-only`)
      expect(integration?.providerSettings).toEqual(persistedSettings(provider))
    }

    await owner.page.goto('/integrations?tab=ai')
    const azure = owner.page.locator('article[data-provider="azure-openai"]')
    await azure.getByRole('button', { name: 'Replace key' }).click()
    await owner.page.getByLabel('Endpoint').fill('https://fixture.openai.azure.com')
    await owner.page.getByLabel('Credential').fill('eng027-azure-ui-write-only-credential')
    await expect(owner.page.getByLabel('Reviewed image input capability')).toBeChecked()
    await expect(owner.page.getByLabel('Image input token upper bound for 768×768')).toHaveValue('2000')
    const saved = owner.page.waitForResponse(response => response.url().endsWith('/api/integrations') && response.request().method() === 'POST' && (response.request().postDataJSON() as { action?: string }).action === 'configure')
    await owner.page.getByRole('button', { name: 'Save configuration' }).click()
    expect((await saved).status()).toBe(200)
    await expect(owner.page.getByRole('status')).toContainText('saved')
    expect(await owner.page.locator('body').textContent()).not.toContain('eng027-azure-ui-write-only-credential')

    for (let index = 0; index < adapters.length; index += 1) {
      const provider = adapters[index]!, fallbackProvider = adapters[(index + 1) % adapters.length]!
      const queued = await owner.page.request.post('/api/ai-jobs', { headers: { origin, 'content-type': 'application/json' }, data: { provider, fallbackProvider, input: `ENG027 adapter fixture ${provider}`, maxOutputTokens: 64, idempotencyKey: `eng027-${provider}-fallback-run-0001` } })
      expect(queued.status()).toBe(201)
      const job = await queued.json() as { job: { id: string } }
      const run = await owner.page.request.post('/__e2e/eng027-adapters-run', { data: { jobID: job.job.id } })
      expect(run.status()).toBe(200)
      expect(await run.json()).toMatchObject({ job: { id: job.job.id, state: 'completed', usedProvider: fallbackProvider, fallbackUsed: true }, calls: [provider, fallbackProvider] })
    }

    await owner.page.goto('/ai-jobs')
    await expect(owner.page.getByRole('region', { name: 'AI jobs' })).toContainText('Completed by amazon-bedrock using fallback')
    await expect(owner.page.getByRole('region', { name: 'AI jobs' })).toContainText('ENG027 fallback completed')

    const textOnly = await owner.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'configure', provider: 'mistral', model: 'eng027-mistral-model', credential: 'eng027-text-only-credential', fallbackProvider: 'openai-compatible', providerSettings: { imageInput: false }, monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 2_000_000, pricingSource: 'https://prices.example.test/eng027-mistral', pricingAsOf: '2026-10-11' } })
    expect(textOnly.status()).toBe(200)
    const rejected = await owner.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'configure-ai-default', jobType: 'alt', provider: 'mistral', model: 'eng027-mistral-model', fallbackProvider: 'openai-compatible' } })
    expect(rejected.status()).toBe(400)
    expect(await rejected.text()).toContain('reviewed production vision model')

    await owner.page.goto('/integrations?tab=ai')
    const cards = owner.page.locator('[data-integrations-providers] article')
    await expect(cards).toHaveCount(8)
    for (const width of [1440, 390]) {
      await owner.page.setViewportSize({ width, height: 900 })
      expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      const card = owner.page.locator('article[data-provider="azure-openai"]')
      await card.getByRole('button', { name: /Add key|Replace key/ }).click()
      const dialog = owner.page.locator('[data-integrations-editor]')
      await expect(dialog.getByLabel('Endpoint')).toBeVisible()
      const imageCapability = dialog.getByLabel('Reviewed image input capability')
      await expect(imageCapability).toBeVisible()
      expect(await imageCapability.evaluate((input) => {
        const label = input.closest('label')
        const style = getComputedStyle(input)
        return {
          width: Math.round(input.getBoundingClientRect().width),
          height: Math.round(input.getBoundingClientRect().height),
          minWidth: style.minWidth,
          minHeight: style.minHeight,
          labelDisplay: label ? getComputedStyle(label).display : null,
          labelAlignItems: label ? getComputedStyle(label).alignItems : null,
        }
      })).toEqual({ width: 16, height: 16, minWidth: '16px', minHeight: '16px', labelDisplay: 'flex', labelAlignItems: 'center' })
      await imageCapability.focus()
      await owner.page.keyboard.press('Tab')
      await expect(dialog.getByLabel('Image input token upper bound for 768×768')).toBeVisible()
      await axe(owner.page, '[data-integrations-editor]')
      await dialog.screenshot({ path: testInfo.outputPath(`eng027-adapters-dialog-${width}.png`) })
      await dialog.getByRole('button', { name: 'Close provider configuration' }).click()
      await owner.page.screenshot({ path: testInfo.outputPath(`eng027-adapters-${width}.png`), fullPage: true })
    }
  } finally {
    for (const provider of adapters) await owner.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'revoke', provider } }).catch(() => undefined)
    await owner.context.close()
  }
})
