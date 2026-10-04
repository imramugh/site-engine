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

test('ENG-023 Owner rotates a masked credential without a connection claim', async ({ browser }) => {
  const owner = await signedIn(browser, 'synthetic-theme-owner-session-token')
  await owner.page.goto('/admin'); await openMenu(owner.page)
  await owner.page.getByRole('link', { name: 'Integrations' }).click(); await expect(owner.page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible()
  await expect(owner.page.getByText('Provider connection tests are unavailable')).toBeVisible()
  await owner.page.getByLabel('Model').fill('synthetic-model'); await owner.page.getByLabel('Credential').fill('synthetic-browser-credential')
  const saved = owner.page.waitForResponse((response) => response.url().endsWith('/api/integrations') && response.request().method() === 'POST')
  await owner.page.getByRole('button', { name: 'Save credential rotation' }).click(); expect((await saved).status()).toBe(201); await expect(owner.page.getByRole('status')).toContainText('Credential rotation saved.')
  await owner.page.reload(); const body = await owner.page.locator('body').textContent() ?? ''
  expect(body).not.toContain('synthetic-browser-credential'); await expect(owner.page.getByLabel('Configured integrations')).toContainText('configured')
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
