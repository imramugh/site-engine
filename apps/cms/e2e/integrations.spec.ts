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

test('ENG-023 Owner rotates a masked credential and explicitly tests a connection', async ({ browser }) => {
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  await owner.page.goto('/admin'); await openMenu(owner.page)
  await owner.page.getByRole('navigation', { name: 'Site', exact: true }).getByRole('link', { name: 'Integrations' }).click(); await expect(owner.page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible()
  await expect(owner.page.getByRole('tab')).toHaveCount(5)
  await expect(owner.page.locator('[data-integrations-providers] article')).toHaveCount(5)
  await expect(owner.page.locator('[data-provider="openai"]')).toContainText('Not connected')
  await owner.page.getByRole('tab', { name: 'AI providers' }).focus(); await owner.page.keyboard.press('ArrowRight'); await expect(owner.page.getByRole('tab', { name: 'Email' })).toBeFocused(); await expect(owner.page.getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true'); await expect(owner.page).toHaveURL(/tab=email/); await expect(owner.page.getByRole('tabpanel')).toContainText('Mailboxes and addresses')
  await owner.page.getByRole('tab', { name: 'Sign-in' }).click(); await expect(owner.page).toHaveURL(/tab=signin/); await expect(owner.page.getByRole('tabpanel')).toContainText('Google'); await expect(owner.page.getByRole('tabpanel')).toContainText('Enabled'); await owner.page.goBack(); await expect(owner.page.getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true'); await owner.page.getByRole('tab', { name: 'Sign-in' }).click()
  await owner.page.getByRole('tab', { name: 'Connected assistants' }).click(); await expect(owner.page.getByRole('tabpanel')).toContainText(/Not configured|Connection service available/)
  await owner.page.getByRole('tab', { name: 'Notifications' }).click(); await expect(owner.page.getByRole('tabpanel')).toContainText('Active incident lead')
  await owner.page.getByRole('tab', { name: 'AI providers' }).click()
  const addOpenAI = owner.page.locator('[data-provider="openai"]').getByRole('button', { name: 'Add key' })
  await addOpenAI.click(); await expect(owner.page.getByLabel('Model', { exact: true })).toBeFocused(); await owner.page.keyboard.press('Shift+Tab'); await expect(owner.page.getByRole('button', { name: 'Close provider configuration' })).toBeFocused(); await owner.page.keyboard.press('Shift+Tab'); await expect(owner.page.getByRole('button', { name: 'Save configuration' })).toBeFocused(); await owner.page.keyboard.press('Escape'); await expect(owner.page.locator('[data-integrations-editor]')).toHaveCount(0); await expect(addOpenAI).toBeFocused(); await addOpenAI.click()
  await owner.page.getByLabel('Model', { exact: true }).fill('synthetic-model'); await owner.page.getByLabel('Credential').fill('synthetic-browser-credential'); await owner.page.getByLabel('Input micro-USD per million tokens').fill('1000000'); await owner.page.getByLabel('Output micro-USD per million tokens').fill('2000000'); await owner.page.getByLabel('Reviewed pricing source').fill('https://prices.example.test/review'); await owner.page.getByLabel('Pricing as of').fill('2026-10-04')
  const saved = owner.page.waitForResponse((response) => response.url().endsWith('/api/integrations') && response.request().method() === 'POST')
  await owner.page.getByRole('button', { name: 'Save configuration' }).click(); expect((await saved).status()).toBe(201); await expect(owner.page.getByRole('status')).toContainText('OpenAI credential and reviewed pricing saved.')
  await owner.page.reload(); const body = await owner.page.locator('body').textContent() ?? ''
  expect(body).not.toContain('synthetic-browser-credential'); await expect(owner.page.locator('[data-provider="openai"]')).toContainText('configured')
  let testRequests = 0
  await owner.page.route('**/api/integrations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const body = route.request().postDataJSON() as { action?: string; credential?: string }
    if (body.action !== 'test') return route.continue()
    expect(body).toEqual({ action: 'test', provider: 'openai' })
    expect(JSON.stringify(body)).not.toContain('synthetic-browser-credential')
    testRequests++
    if (testRequests === 3) { await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'reauthentication required' }) }); return }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ integration: { id: 'mock', provider: 'openai', health: testRequests === 1 ? 'connected' : 'rejected', testedAt: '2026-10-04T12:00:00.000Z', credentialConfigured: true } }) })
  })
  const connectionTest = owner.page.locator('[data-provider="openai"]').getByRole('button', { name: 'Test' })
  await connectionTest.click(); await expect(owner.page.getByRole('status')).toContainText('Connection confirmed at Oct 4, 2026, 8:00 a.m. EDT.')
  await connectionTest.click(); await expect(owner.page.getByRole('status')).toContainText('Connection could not be confirmed at Oct 4, 2026, 8:00 a.m. EDT. Provider details are not displayed.')
  await connectionTest.click(); await expect(owner.page.locator('[data-integrations-status]')).toContainText('A fresh Owner sign-in is required before testing a connection.')
  await owner.page.locator('[data-provider="anthropic"]').getByRole('button', { name: 'Add key' }).click()
  await owner.page.getByLabel('Model', { exact: true }).fill('preserved-model'); await owner.page.getByLabel('Credential').fill('preserved-secret'); await owner.page.getByLabel('Input micro-USD per million tokens').fill('3'); await owner.page.getByLabel('Output micro-USD per million tokens').fill('4'); await owner.page.getByLabel('Reviewed pricing source').fill('https://prices.example.test/anthropic'); await owner.page.getByLabel('Pricing as of').fill('2026-10-04')
  await owner.page.route('**/api/integrations', async (route) => { const request = route.request(); if (request.method() === 'POST' && (request.postDataJSON() as { action?: string }).action === 'configure') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic failure' }) }); return route.fallback() })
  await owner.page.getByRole('button', { name: 'Save configuration' }).click(); await expect(owner.page.locator('[data-integrations-status]')).toContainText('synthetic failure'); await expect(owner.page.getByLabel('Model')).toHaveValue('preserved-model'); await expect(owner.page.getByLabel('Credential')).toHaveValue('preserved-secret')
  await owner.page.getByRole('button', { name: 'Close provider configuration' }).click()
  await owner.page.addScriptTag({ path: axeSource }); expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await owner.context.close()
})

test('ENG-023 five-tab workspace remains usable at desktop and mobile sizes', async ({ browser }, testInfo) => {
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  await owner.page.setViewportSize({ width: 1440, height: 900 }); await owner.page.goto('/integrations')
  const cards = owner.page.locator('[data-integrations-providers] article'); await expect(cards).toHaveCount(5)
  const tops = await cards.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top))); expect(new Set(tops).size).toBe(2)
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
  const signin = owner.page.locator('[data-signin-methods]'); await expect(signin.locator('article')).toHaveCount(3)
  await expect(signin.locator('[data-signin-method="google"]')).toContainText('Invitation only'); await expect(signin.locator('[data-signin-method="google"]')).toContainText(/assigned manually/i)
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

test('ENG-023 denies non-Owners and cross-origin credential writes', async ({ browser }) => {
  const editor = await signedIn(browser, 'synthetic-application-editor-session-token')
  expect((await editor.page.request.get('/api/integrations')).status()).toBe(403); await editor.page.goto('/integrations'); const onlyTab = editor.page.getByRole('tab', { name: 'Connected assistants', exact: true }); await expect(editor.page.getByRole('tab')).toHaveCount(1); await expect(onlyTab).toBeVisible(); await onlyTab.focus(); for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) { await editor.page.keyboard.press(key); await expect(onlyTab).toBeFocused(); await expect(onlyTab).toHaveAttribute('aria-selected', 'true') }; await expect(editor.page).toHaveURL(/tab=assistants/); await editor.context.close()
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  const csrf = await owner.page.request.post('/api/integrations', { headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, data: { action: 'configure', provider: 'openai', model: 'x', credential: 'must-not-persist' } })
  expect(csrf.status()).toBe(403); expect(await csrf.text()).not.toContain('must-not-persist'); await owner.context.close()
})

test('Owner saves and reloads durable AI job routing', async ({ browser }, testInfo) => {
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  await owner.page.goto('/integrations')
  const configured = await owner.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'configure', provider: 'openai', model: 'gpt-4.1-mini', credential: 'synthetic-routing-credential', fallbackProvider: null, monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, pricingSource: 'https://prices.example.test/routing', pricingAsOf: '2026-10-06T00:00:00.000Z' } })
  expect(configured.status()).toBe(201)
  await owner.page.reload()
  const row = owner.page.locator('[data-ai-job-route="summary"]')
  await expect(row).toContainText('Page summaries')
  const saved = owner.page.waitForResponse(response => response.url().endsWith('/api/integrations') && response.request().method() === 'POST')
  await row.getByLabel('Page summaries provider').selectOption('openai'); expect((await saved).status()).toBe(200)
  await expect(row.getByLabel('Page summaries model')).toHaveValue('gpt-4.1-mini')
  const fallbackConfig = await owner.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'configure', provider: 'anthropic', model: 'browser-fallback-model', credential: 'synthetic-fallback-credential', fallbackProvider: null, monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, pricingSource: 'https://prices.example.test/fallback', pricingAsOf: '2026-10-06T00:00:00.000Z' } }); expect(fallbackConfig.status()).toBe(201)
  const fallbackSaved = owner.page.waitForResponse(response => response.url().endsWith('/api/integrations') && response.request().method() === 'POST')
  await row.getByLabel('Page summaries fallback').selectOption('anthropic'); expect((await fallbackSaved).status()).toBe(200)
  await owner.page.reload(); const reloaded = owner.page.locator('[data-ai-job-route="summary"]'); await expect(reloaded.getByLabel('Page summaries provider')).toHaveValue('openai'); await expect(reloaded.getByLabel('Page summaries model')).toHaveValue('gpt-4.1-mini'); await expect(reloaded.getByLabel('Page summaries fallback')).toHaveValue('anthropic')
  const rejected = await owner.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'configure-ai-default', jobType: 'faq', provider: 'openai', model: 'unreviewed-model', fallbackProvider: null } }); expect(rejected.status()).toBe(400)
  const unsupportedAlt = await owner.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'configure-ai-default', jobType: 'alt', provider: 'anthropic', model: 'browser-fallback-model', fallbackProvider: null } }); expect(unsupportedAlt.status()).toBe(400); await expect(unsupportedAlt.json()).resolves.toMatchObject({ error: expect.stringContaining('production vision model') })
  const testOnlyAlt = await owner.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'configure-ai-default', jobType: 'alt', provider: 'openai', model: 'gpt-test', fallbackProvider: null } }); expect(testOnlyAlt.status()).toBe(400)
  const duplicateFallback = await owner.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'configure-ai-default', jobType: 'faq', provider: 'openai', model: 'gpt-4.1-mini', fallbackProvider: 'openai' } }); expect(duplicateFallback.status()).toBe(400)
  const altRow = owner.page.locator('[data-ai-job-route="alt"]'); await expect(altRow.getByLabel('Image alt text provider').locator('option')).toHaveCount(2); await expect(altRow.getByLabel('Image alt text provider')).toHaveText(/OpenAI/)
  for (const width of [1440, 390]) { await owner.page.setViewportSize({ width, height: 900 }); const rows = owner.page.locator('[data-ai-job-route]'); await expect(rows).toHaveCount(5); expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await owner.page.screenshot({ path: testInfo.outputPath(`routing-${width}.png`), fullPage: true }) }
  await reloaded.getByLabel('Page summaries provider').focus(); await owner.page.keyboard.press('Tab'); await expect(reloaded.getByLabel('Page summaries model')).toBeFocused(); await owner.page.addScriptTag({ path: axeSource }); expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('[data-integrations-routing]', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  const editor = await signedIn(browser, 'synthetic-application-editor-session-token')
  expect((await editor.page.request.post('/api/integrations', { headers: { origin, 'content-type': 'application/json' }, data: { action: 'configure-ai-default', jobType: 'summary', provider: 'openai', model: 'synthetic', fallbackProvider: null } })).status()).toBe(403)
  await Promise.all([owner.context.close(), editor.context.close()])
})
