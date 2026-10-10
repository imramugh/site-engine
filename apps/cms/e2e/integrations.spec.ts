import { expect, test, type Browser } from '@playwright/test'
import { createRequire } from 'node:module'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
async function signedIn(browser: Browser, token: string) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}
async function openMenu(page: Awaited<ReturnType<typeof signedIn>>['page']) {
  const menu = page.getByTestId('mobile-menu')
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') === 'false') await menu.click()
}

async function fillProviderConfiguration(page: Awaited<ReturnType<typeof signedIn>>['page'], model: string, credential: string) {
  await page.getByRole('textbox', { name: 'Model', exact: true }).fill(model)
  await page.getByLabel('Credential').fill(credential)
  await page.getByLabel('Input micro-USD per million tokens').fill('1000000')
  await page.getByLabel('Output micro-USD per million tokens').fill('2000000')
  await page.getByLabel('Reviewed pricing source').fill('https://prices.example.test/review')
  await page.getByLabel('Pricing as of').fill('2026-10-04')
}

test('ENG-023 Owner replaces a write-only credential, retains operational card state, and revokes it', async ({ browser }) => {
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  const initialSecret = 'synthetic-initial-credential-01'
  const replacementSecret = 'synthetic-replacement-credential-02'
  try {
    await owner.page.goto('/integrations?tab=ai')
    const card = owner.page.locator('[data-provider="openai"]')
    await expect(card).toContainText('Not connected')
    await expect(card).toContainText('Reviewed model')
    await expect(card).toContainText('Not set')
    await expect(card).toContainText('Last tested')
    await expect(card.getByRole('button', { name: 'Test' })).toBeDisabled()

    await card.getByRole('button', { name: 'Add key' }).click()
    await fillProviderConfiguration(owner.page, 'synthetic-reviewed-model', initialSecret)
    const initialSave = owner.page.waitForResponse((response) => response.url().endsWith('/api/integrations') && response.request().method() === 'POST' && (response.request().postDataJSON() as { action?: string }).action === 'configure')
    await owner.page.getByRole('button', { name: 'Save configuration' }).click()
    const initialResponse = await initialSave
    expect(initialResponse.status()).toBe(201)
    expect(await initialResponse.text()).not.toContain(initialSecret)

    await owner.page.reload()
    const initialHint = await card.locator('code').textContent()
    expect(initialHint).toBeTruthy()
    expect(initialHint).not.toContain(initialSecret)
    await expect(card).toContainText('synthetic-reviewed-model')
    await expect(card).toContainText('Not tested')
    await expect(card.getByRole('button', { name: 'Test' })).toBeEnabled()

    await card.getByRole('button', { name: 'Replace key' }).click()
    await expect(owner.page.getByLabel('Credential')).toHaveValue('')
    await fillProviderConfiguration(owner.page, 'synthetic-reviewed-model', replacementSecret)
    const replacementSave = owner.page.waitForResponse((response) => response.url().endsWith('/api/integrations') && response.request().method() === 'POST' && (response.request().postDataJSON() as { action?: string }).action === 'configure')
    await owner.page.getByRole('button', { name: 'Save configuration' }).click()
    const replacementResponse = await replacementSave
    expect(replacementResponse.status()).toBe(200)
    const replacementBody = await replacementResponse.text()
    expect(replacementBody).not.toContain(initialSecret)
    expect(replacementBody).not.toContain(replacementSecret)

    await owner.page.reload()
    const replacementHint = await card.locator('code').textContent()
    expect(replacementHint).toBeTruthy()
    expect(replacementHint).not.toBe(initialHint)
    const pageBody = await owner.page.locator('body').textContent() ?? ''
    expect(pageBody).not.toContain(initialSecret)
    expect(pageBody).not.toContain(replacementSecret)

    // This only exercises the browser's connection-result rendering. Provider
    // transport and persisted health transitions are covered by isolated backend
    // integration tests; this browser fixture never contacts a provider.
    const current = await owner.page.request.get('/api/integrations')
    expect(current.status()).toBe(200)
    const currentBody = await current.json() as { integrations: Array<Record<string, unknown>> }
    const testedAt = '2026-10-04T12:00:00.000Z'
    const testedIntegrations = currentBody.integrations.map((integration) => integration.provider === 'openai' ? { ...integration, health: 'connected', testedAt } : integration)
    await owner.page.route('**/api/integrations', async (route) => {
      if (route.request().method() === 'POST' && (route.request().postDataJSON() as { action?: string }).action === 'test') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ integration: testedIntegrations.find((integration) => integration.provider === 'openai') }) })
        return
      }
      if (route.request().method() === 'GET') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...currentBody, integrations: testedIntegrations }) })
        return
      }
      await route.fallback()
    })
    await card.getByRole('button', { name: 'Test' }).click()
    await expect(owner.page.getByRole('status')).toContainText('Connection confirmed at Oct 4, 2026, 8:00 a.m. EDT.')
    await expect(card).toContainText('Connected')
    await expect(card).toContainText('Oct 4, 2026, 8:00 a.m. EDT')
    await owner.page.reload()
    await expect(card).toContainText('Connected')
    await expect(card).toContainText('Oct 4, 2026, 8:00 a.m. EDT')
    await owner.page.unroute('**/api/integrations')

    await card.getByRole('button', { name: 'Replace key' }).click()
    owner.page.once('dialog', (dialog) => dialog.accept())
    await owner.page.getByRole('button', { name: 'Revoke credential' }).click()
    await expect(owner.page.getByRole('status')).toContainText('OpenAI credential revoked.')
    await expect(card).toContainText('Not connected')
    await expect(card.getByRole('button', { name: 'Test' })).toBeDisabled()
    await owner.page.reload()
    await expect(card).toContainText('Not connected')
    await expect(card.getByRole('button', { name: 'Test' })).toBeDisabled()
  } finally {
    await owner.context.close()
  }
})

test('ENG-023 provider configuration keeps dialog, rejection, reauthentication, and accessibility behavior', async ({ browser }) => {
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  try {
    await owner.page.goto('/admin')
    await openMenu(owner.page)
    await owner.page.getByRole('navigation', { name: 'Site', exact: true }).getByRole('link', { name: 'Integrations' }).click()
    await expect(owner.page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible()
    await expect(owner.page.getByRole('tab')).toHaveCount(5)
    await expect(owner.page.locator('[data-integrations-providers] article')).toHaveCount(4)

    await owner.page.getByRole('tab', { name: 'AI providers' }).focus()
    await owner.page.keyboard.press('ArrowRight')
    await expect(owner.page.getByRole('tab', { name: 'Email' })).toBeFocused()
    await expect(owner.page.getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true')
    await expect(owner.page).toHaveURL(/tab=email/)
    await expect(owner.page.getByRole('tabpanel')).toContainText('Mailboxes and addresses')
    await owner.page.getByRole('tab', { name: 'Sign-in' }).click()
    await expect(owner.page).toHaveURL(/tab=signin/)
    await expect(owner.page.getByRole('tabpanel')).toContainText('Authenticator app')
    await owner.page.goBack()
    await expect(owner.page.getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true')
    await owner.page.getByRole('tab', { name: 'AI providers' }).click()

    const openAI = owner.page.locator('[data-provider="openai"]')
    const configure = openAI.getByRole('button', { name: /Add key|Replace key/ })
    await configure.click()
    await expect(owner.page.getByRole('textbox', { name: 'Model', exact: true })).toBeFocused()
    await owner.page.keyboard.press('Shift+Tab')
    await expect(owner.page.getByRole('button', { name: 'Close provider configuration' })).toBeFocused()
    await owner.page.keyboard.press('Shift+Tab')
    await expect(owner.page.getByRole('button', { name: 'Save configuration' })).toBeFocused()
    await owner.page.keyboard.press('Escape')
    await expect(owner.page.locator('[data-integrations-editor]')).toHaveCount(0)
    await expect(configure).toBeFocused()

    await configure.click()
    await fillProviderConfiguration(owner.page, 'synthetic-dialog-model', 'synthetic-dialog-credential')
    const saved = owner.page.waitForResponse((response) => response.url().endsWith('/api/integrations') && response.request().method() === 'POST' && (response.request().postDataJSON() as { action?: string }).action === 'configure')
    await owner.page.getByRole('button', { name: 'Save configuration' }).click()
    expect([200, 201]).toContain((await saved).status())
    await owner.page.reload()
    const body = await owner.page.locator('body').textContent() ?? ''
    expect(body).not.toContain('synthetic-dialog-credential')
    await expect(openAI).toContainText('synthetic-dialog-model')

    let testRequests = 0
    await owner.page.route('**/api/integrations', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const body = route.request().postDataJSON() as { action?: string; credential?: string }
      if (body.action !== 'test') return route.continue()
      expect(body).toEqual({ action: 'test', provider: 'openai' })
      expect(JSON.stringify(body)).not.toContain('synthetic-dialog-credential')
      testRequests += 1
      if (testRequests === 3) {
        await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'reauthentication required' }) })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ integration: { id: 'mock', provider: 'openai', health: testRequests === 1 ? 'connected' : 'rejected', testedAt: '2026-10-04T12:00:00.000Z', credentialConfigured: true } }) })
    })
    const connectionTest = openAI.getByRole('button', { name: 'Test' })
    await connectionTest.click()
    await expect(owner.page.getByRole('status')).toContainText('Connection confirmed at Oct 4, 2026, 8:00 a.m. EDT.')
    await connectionTest.click()
    await expect(owner.page.getByRole('status')).toContainText('Connection could not be confirmed at Oct 4, 2026, 8:00 a.m. EDT. Provider details are not displayed.')
    await connectionTest.click()
    await expect(owner.page.locator('[data-integrations-status]')).toContainText('A fresh Owner sign-in is required before testing a connection.')

    await owner.page.locator('[data-provider="anthropic"]').getByRole('button', { name: 'Add key' }).click()
    await fillProviderConfiguration(owner.page, 'preserved-model', 'preserved-secret')
    await owner.page.route('**/api/integrations', async (route) => {
      const request = route.request()
      if (request.method() === 'POST' && (request.postDataJSON() as { action?: string }).action === 'configure') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic failure' }) })
        return
      }
      await route.fallback()
    })
    await owner.page.getByRole('button', { name: 'Save configuration' }).click()
    await expect(owner.page.locator('[data-integrations-status]')).toContainText('synthetic failure')
    await expect(owner.page.getByRole('textbox', { name: 'Model', exact: true })).toHaveValue('preserved-model')
    await expect(owner.page.getByLabel('Credential')).toHaveValue('preserved-secret')
    await owner.page.getByRole('button', { name: 'Close provider configuration' }).click()
    await owner.page.unroute('**/api/integrations')

    await owner.page.addScriptTag({ path: axeSource })
    expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  } finally {
    await owner.page.unroute('**/api/integrations')
    await owner.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'revoke', provider: 'openai' } }).catch(() => undefined)
    await owner.context.close()
  }
})

test('ENG-023 five-tab workspace remains usable at desktop and mobile sizes', async ({ browser }, testInfo) => {
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  await owner.page.setViewportSize({ width: 1440, height: 900 }); await owner.page.goto('/integrations')
  const cards = owner.page.locator('[data-integrations-providers] article'); await expect(cards).toHaveCount(4)
  const tops = await cards.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top))); expect(new Set(tops).size).toBe(1)
  if (process.env.CMS_PRIVATE_BRAND === '1') {
    await owner.page.evaluate(() => document.fonts.ready)
    expect(await owner.page.locator('link[href*="admin-branding.css"]').count()).toBe(1)
    for (const locator of [owner.page.locator('[data-integrations-workspace]'), cards.first().locator('strong').first(), owner.page.getByRole('tab', { name: 'AI providers' })]) {
      expect(await locator.evaluate((node) => getComputedStyle(node).fontFamily)).toContain('IBM Plex Sans')
    }
  }
  for (const tab of ['Email', 'Sign-in', 'Connected assistants', 'Notifications', 'AI providers']) { await owner.page.getByRole('tab', { name: tab, exact: true }).click(); await expect(owner.page.getByRole('tabpanel')).toBeVisible() }
  await owner.page.getByRole('tab', { name: 'Sign-in' }).click()
  await expect(owner.page.locator('[data-integrations-status][role="alert"]')).toHaveCount(0)
  const signin = owner.page.locator('[data-signin-methods]'); await expect(signin.locator('article')).toHaveCount(1)
  await expect(signin.locator('[data-signin-method="local"]')).toContainText('Last used'); await expect(signin.locator('[data-signin-method="local"]')).toContainText('15 minutes')
  await owner.page.addScriptTag({ path: axeSource }); expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await owner.page.screenshot({ path: testInfo.outputPath('sign-in-details-1440.png'), fullPage: true })
  await owner.page.setViewportSize({ width: 390, height: 844 }); await owner.page.getByRole('tab', { name: 'Sign-in' }).click()
  expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const boxes = await signin.locator('article').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width)); expect(boxes.every((width) => width > 300 && width <= 366)).toBe(true)
  expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await owner.page.screenshot({ path: testInfo.outputPath('sign-in-details-390.png'), fullPage: true })
  await owner.page.getByRole('tab', { name: 'AI providers' }).click(); const providerBoxes = await cards.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width)); expect(providerBoxes.every((width) => width > 300 && width <= 366)).toBe(true)
  await owner.context.close()
})

test('ENG-022 Owner persists notification routing and private urgent contacts', async ({ browser }, testInfo) => {
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  await owner.page.setViewportSize({ width: 1440, height: 900 }); await owner.page.goto('/integrations?tab=notifications')
  const panel = owner.page.locator('[data-notification-preferences]'); await expect(panel).toBeVisible(); await expect(panel.locator('fieldset')).toHaveCount(6)
  await expect(panel).toContainText('No event source is available yet.'); await expect(panel).toContainText('Notification messages are queued.')
  await expect(panel.getByRole('link', { name: 'Email tab' })).toHaveAttribute('href', '/integrations?tab=email'); await expect(panel.getByRole('link', { name: 'Site › Business details' })).toHaveAttribute('href', '/site')
  await expect(panel.locator('[data-notification-sidebar="sms"]')).toContainText('Not connected'); await expect(panel.locator('[data-notification-sidebar="templates"]')).toContainText('Templates are not yet configurable')
  const lead = panel.locator('fieldset').filter({ has: owner.page.getByText('New lead', { exact: true }) }); await lead.locator('summary').first().click(); await lead.getByLabel('Sales').uncheck()
  const saved = owner.page.waitForResponse((response) => response.url().endsWith('/api/notification-settings') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: 'Save preferences' }).click(); expect((await saved).status()).toBe(200); await expect(panel.getByRole('status')).toContainText('Notification preferences saved.')
  await owner.page.reload(); await expect(owner.page.locator('[data-notification-preferences] fieldset').filter({ has: owner.page.getByText('New lead', { exact: true }) }).getByLabel('Sales')).not.toBeChecked()
  const contacts = [{ name: 'Browser incident contact', email: 'incident-browser@example.test', mobile: '+1 416 555 0199', enabled: true }]
  await owner.page.goto('/site'); await owner.page.getByText('Urgent alert contacts Email and mobile', { exact: true }).click()
  const urgent = owner.page.locator('[data-urgent-contacts]'); await expect(urgent).toBeVisible(); await urgent.getByRole('button', { name: 'Add contact', exact: true }).click()
  await urgent.getByLabel('Name', { exact: true }).fill(contacts[0]!.name); await urgent.getByLabel('Email', { exact: true }).fill(contacts[0]!.email); await urgent.getByLabel('Mobile number', { exact: true }).fill(contacts[0]!.mobile)
  expect(await urgent.getByLabel('Email', { exact: true }).evaluate((input: HTMLInputElement) => input.form?.id)).toBe('private-urgent-contacts')
  const contactSave = owner.page.waitForResponse(response => response.url().endsWith('/api/urgent-contacts') && response.request().method() === 'POST')
  await urgent.getByRole('button', { name: 'Save urgent contacts', exact: true }).click(); expect((await contactSave).status()).toBe(200); await expect(urgent.getByRole('status')).toContainText('Urgent contacts saved.')
  await owner.page.reload(); await owner.page.getByText('Urgent alert contacts Email and mobile', { exact: true }).click(); await expect(urgent.getByLabel('Email', { exact: true })).toHaveValue(contacts[0]!.email)
  for (const width of [1440, 390]) { await owner.page.setViewportSize({ width, height: 900 }); expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await owner.page.addScriptTag({ path: axeSource }); expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([]); await owner.page.screenshot({ path: testInfo.outputPath(`site-urgent-contacts-${width}.png`), fullPage: true }) }
  await owner.page.setViewportSize({ width: 1440, height: 900 }); await owner.page.goto('/integrations?tab=notifications'); await expect(panel).toBeVisible()
  const reloaded = await owner.page.request.get('/api/urgent-contacts'); expect(reloaded.status()).toBe(200); expect(await reloaded.json()).toMatchObject({ contacts })
  await owner.page.screenshot({ path: testInfo.outputPath('notifications-1440.png'), fullPage: true })
  await owner.page.setViewportSize({ width: 390, height: 844 }); expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await owner.page.screenshot({ path: testInfo.outputPath('notifications-390.png'), fullPage: true })
  await owner.page.addScriptTag({ path: axeSource }); expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await owner.context.close()
})

test('ENG-023 denies non-Owner integration mutations without changing configuration', async ({ browser }) => {
  const editor = await signedIn(browser, 'synthetic-application-editor-session-token')
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  const state = async () => {
    const response = await owner.page.request.get('/api/integrations')
    expect(response.status()).toBe(200)
    const body = await response.json() as { integrations: unknown; aiJobDefaults: unknown }
    return { integrations: body.integrations, aiJobDefaults: body.aiJobDefaults }
  }
  try {
    expect((await editor.page.request.get('/api/integrations')).status()).toBe(403)
    await editor.page.goto('/integrations')
    const onlyTab = editor.page.getByRole('tab', { name: 'Connected assistants', exact: true })
    await expect(editor.page.getByRole('tab')).toHaveCount(1)
    await expect(onlyTab).toBeVisible()
    await onlyTab.focus()
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      await editor.page.keyboard.press(key)
      await expect(onlyTab).toBeFocused()
      await expect(onlyTab).toHaveAttribute('aria-selected', 'true')
    }
    await expect(editor.page).toHaveURL(/tab=assistants/)

    const before = await state()
    const requests = [
      { action: 'configure', provider: 'openai', model: 'forbidden-model', credential: 'must-not-persist', fallbackProvider: null, monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, pricingSource: 'https://prices.example.test/forbidden', pricingAsOf: '2026-10-04' },
      { action: 'test', provider: 'openai' },
      { action: 'revoke', provider: 'openai' },
      { action: 'configure-ai-default', jobType: 'summary', provider: 'openai', model: 'forbidden-model', fallbackProvider: null },
    ]
    for (const data of requests) {
      const response = await editor.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data })
      expect(response.status(), await response.text()).toBe(403)
      expect(await state()).toEqual(before)
    }

    const csrf = await owner.page.request.post('/api/integrations', { headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, data: requests[0] })
    expect(csrf.status()).toBe(403)
    expect(await csrf.text()).not.toContain('must-not-persist')
    expect(await state()).toEqual(before)
  } finally {
    await editor.context.close()
    await owner.context.close()
  }
})
