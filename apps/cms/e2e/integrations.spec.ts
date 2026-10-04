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
  const first = page.locator('button.nav-toggler').first()
  await expect(first).toHaveAttribute('aria-label', 'Open Menu')
  // Payload replaces its server navigation state during hydration.
  await expect(page.locator('.template-default--nav-hydrated')).toBeVisible()
  if (await first.getAttribute('aria-label') === 'Open Menu') await first.click()
  await expect(first).toHaveAttribute('aria-label', 'Close Menu')
}

test('ENG-023 Owner rotates a masked credential and explicitly tests a connection', async ({ browser }) => {
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  await owner.page.goto('/admin'); await openMenu(owner.page)
  await owner.page.getByRole('link', { name: 'Integrations' }).click(); await expect(owner.page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible()
  await expect(owner.page.getByText('Provider jobs use encrypted credentials only at execution time')).toBeVisible()
  await owner.page.getByLabel('Model').fill('synthetic-model'); await owner.page.getByLabel('Credential').fill('synthetic-browser-credential'); await owner.page.getByLabel('Input micro-USD per million tokens').fill('1000000'); await owner.page.getByLabel('Output micro-USD per million tokens').fill('2000000'); await owner.page.getByLabel('Reviewed pricing source').fill('https://prices.example.test/review'); await owner.page.getByLabel('Pricing as of').fill('2026-10-04')
  const saved = owner.page.waitForResponse((response) => response.url().endsWith('/api/integrations') && response.request().method() === 'POST')
  await owner.page.getByRole('button', { name: 'Save provider configuration' }).click(); expect((await saved).status()).toBe(201); await expect(owner.page.getByRole('status')).toContainText('Credential rotation and reviewed pricing saved.')
  await owner.page.reload(); const body = await owner.page.locator('body').textContent() ?? ''
  expect(body).not.toContain('synthetic-browser-credential'); await expect(owner.page.getByLabel('Configured integrations')).toContainText('configured')
  let testRequests = 0
  await owner.page.route('**/api/integrations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const body = route.request().postDataJSON() as { action?: string; credential?: string }
    if (body.action !== 'test') return route.continue()
    expect(body).toEqual({ action: 'test', provider: 'openai' })
    expect(JSON.stringify(body)).not.toContain('synthetic-browser-credential')
    testRequests++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ integration: { id: 'mock', provider: 'openai', health: testRequests === 1 ? 'connected' : 'rejected', testedAt: '2026-10-04T12:00:00.000Z', credentialConfigured: true } }) })
  })
  const connectionTest = owner.page.getByLabel('Configured integrations').locator('li').filter({ hasText: /^openai/ }).getByRole('button', { name: 'Test connection' })
  await connectionTest.click(); await expect(owner.page.getByRole('status')).toContainText('Connection confirmed at 2026-10-04T12:00:00.000Z.')
  await connectionTest.click(); await expect(owner.page.getByRole('status')).toContainText('Connection could not be confirmed at 2026-10-04T12:00:00.000Z. Provider details are not displayed.')
  await owner.page.addScriptTag({ path: axeSource }); expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await owner.context.close()
})

test('ENG-023 denies non-Owners and cross-origin credential writes', async ({ browser }) => {
  const editor = await signedIn(browser, 'synthetic-application-editor-session-token')
  expect((await editor.page.request.get('/api/integrations')).status()).toBe(403); await editor.page.goto('/integrations'); await expect(editor.page).toHaveURL(/\/admin\/login/); await editor.context.close()
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  const csrf = await owner.page.request.post('/api/integrations', { headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, data: { action: 'configure', provider: 'openai', model: 'x', credential: 'must-not-persist' } })
  expect(csrf.status()).toBe(403); expect(await csrf.text()).not.toContain('must-not-persist'); await owner.context.close()
})
