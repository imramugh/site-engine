import { expect, test, type Browser } from '@playwright/test'
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
async function signedIn(browser: Browser, token: string) { const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true }); await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const }))); return { context, page: await context.newPage() } }
const managementId = '12121212-1212-4212-8212-121212121212'
const response = (own: boolean) => ({ scope: own ? 'own' : 'all', endpoint: `${origin}/mcp`, grants: [{ managementId, clientName: 'Claude Desktop', resource: `${origin}/mcp`, scopes: ['mcp:content:read', 'mcp:content:write'], createdAt: Date.parse('2026-10-01T12:00:00Z'), lastUsedAt: Date.parse('2026-10-05T12:00:00Z'), expiresAt: Date.parse('2026-10-20T12:00:00Z'), person: { name: own ? 'Synthetic Shell Editor' : 'Synthetic Shell Approver', email: own ? 'shell-editor.synthetic@example.test' : 'shell-approver.synthetic@example.test' }, own }] })

test('Owner reviews and revokes connected assistants with accessible desktop and mobile layouts', async ({ browser }) => {
  const owner = await signedIn(browser, 'synthetic-shell-owner-session-token'); let revoked = false
  await owner.page.route('**/api/connected-assistants', async (route) => { if (route.request().method() === 'POST') { expect(await route.request().postDataJSON()).toEqual({ action: 'revoke', managementId }); revoked = true; return route.fulfill({ json: { revoked: true } }) } return route.fulfill({ json: revoked ? { ...response(false), grants: [] } : response(false) }) })
  await owner.page.setViewportSize({ width: 1440, height: 960 }); await owner.page.goto('/integrations?tab=assistants')
  await expect(owner.page.getByRole('heading', { name: 'Connected assistants' })).toBeVisible(); await expect(owner.page.getByText('Claude Desktop')).toBeVisible(); await expect(owner.page.getByText('Synthetic Shell Approver')).toBeVisible(); await expect(owner.page.getByText('Read content')).toBeVisible(); await expect(owner.page.getByText('Edit drafts')).toBeVisible(); await expect(owner.page.getByRole('heading', { name: 'How to connect' })).toBeVisible(); await expect(owner.page.getByText(`${origin}/mcp`)).toBeVisible()
  await owner.page.addScriptTag({ url: '/__e2e/axe.js' }); expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await owner.page.screenshot({ path: 'artifacts/connected-assistants-1440.png', fullPage: true })
  await owner.page.setViewportSize({ width: 390, height: 844 }); expect(await owner.page.locator('main').evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth)).toBe(true); expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([]); await owner.page.screenshot({ path: 'artifacts/connected-assistants-390.png', fullPage: true })
  owner.page.once('dialog', (dialog) => dialog.accept()); await owner.page.getByRole('button', { name: 'Revoke' }).click(); await expect(owner.page.getByRole('status')).toContainText('access revoked'); await expect(owner.page.getByText('No assistants are connected to staff accounts.')).toBeVisible(); await owner.context.close()
})

test('non-Owner account navigation opens only that person’s connected assistants', async ({ browser }) => {
  const editor = await signedIn(browser, 'synthetic-shell-editor-session-token'); await editor.page.route('**/api/connected-assistants', (route) => route.fulfill({ json: response(true) })); await editor.page.goto('/admin'); await editor.page.locator('[data-admin-account-button]').click(); const link = editor.page.getByRole('menuitem', { name: 'My connected assistants' }); await expect(link).toHaveAttribute('href', '/integrations?tab=assistants'); await link.click(); await expect(editor.page).toHaveURL(/\/integrations\?tab=assistants/); await expect(editor.page.getByRole('tab')).toHaveCount(1); await expect(editor.page.getByRole('tab', { name: 'Connected assistants' })).toBeVisible(); await expect(editor.page.getByRole('heading', { name: 'My connected assistants' })).toBeVisible(); await expect(editor.page.locator('[data-assistant-grant]').getByText('Synthetic Shell Editor')).toBeVisible(); await editor.context.close()
})

test('assistant panel reports an unavailable protected API without an empty-success state', async ({ browser }) => {
  const owner = await signedIn(browser, 'synthetic-shell-owner-session-token')
  await owner.page.route('**/api/connected-assistants', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Assistant service is unavailable.' }) }))
  await owner.page.goto('/integrations?tab=assistants')
  await expect(owner.page.locator('[data-assistant-status]')).toBeVisible()
  await expect(owner.page.locator('[data-assistant-list] header [data-assistant-count]')).toHaveText('Unavailable')
  await expect(owner.page.getByText('No assistants are connected to staff accounts.')).toHaveCount(0)
  await owner.context.close()
})

test('ENG-017 Owner persists MCP phone privacy from Connected assistants and non-Owners cannot read it', async ({ browser }) => {
  const owner = await signedIn(browser, 'synthetic-shell-owner-session-token')
  await owner.page.route('**/api/connected-assistants', (route) => route.fulfill({ json: response(false) }))
  await owner.page.goto('/integrations?tab=assistants')
  const toggle = owner.page.getByLabel('Hide lead phone numbers')
  await expect(toggle).toBeChecked()
  const save = owner.page.waitForResponse((entry) => entry.url().endsWith('/api/mcp-privacy') && entry.request().method() === 'PUT')
  await toggle.uncheck(); expect((await save).status()).toBe(200)
  await expect(owner.page.getByRole('status')).toContainText('available to authorized lead readers')
  await owner.page.reload(); await expect(owner.page.getByLabel('Hide lead phone numbers')).not.toBeChecked()
  const ownerPolicy = await owner.page.request.get('/api/mcp-privacy'); expect(ownerPolicy.status()).toBe(200); expect(await ownerPolicy.json()).toEqual({ hidePhone: false })
  const restore = owner.page.waitForResponse((entry) => entry.url().endsWith('/api/mcp-privacy') && entry.request().method() === 'PUT')
  await owner.page.getByLabel('Hide lead phone numbers').check(); expect((await restore).status()).toBe(200)
  const csrf = await owner.page.request.put('/api/mcp-privacy', { headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, data: { hidePhone: false } })
  expect(csrf.status()).toBe(403); expect(await csrf.text()).not.toContain('phone')
  const editor = await signedIn(browser, 'synthetic-shell-editor-session-token')
  expect((await editor.page.request.get('/api/mcp-privacy')).status()).toBe(403)
  expect((await editor.page.request.put('/api/mcp-privacy', { headers: { origin, 'content-type': 'application/json' }, data: { hidePhone: false } })).status()).toBe(403)
  await Promise.all([owner.context.close(), editor.context.close()])
})

test('ENG-017 retries a failed MCP privacy read and restores the saved value after a failed write', async ({ browser }) => {
  const owner = await signedIn(browser, 'synthetic-shell-owner-session-token'); let reads = 0; let writes = 0
  await owner.page.route('**/api/connected-assistants', (route) => route.fulfill({ json: response(false) }))
  await owner.page.route('**/api/mcp-privacy', async (route) => {
    if (route.request().method() === 'GET') { reads += 1; return reads === 1 ? route.fulfill({ status: 503, json: { error: 'unavailable' } }) : route.fulfill({ json: { hidePhone: true } }) }
    writes += 1
    // Leave the controlled input changed long enough for the browser to issue
    // its real write before the unavailable response restores saved state.
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    return route.fulfill({ status: 503, json: { error: 'unavailable' } })
  })
  await owner.page.goto('/integrations?tab=assistants'); await expect(owner.page.locator('[data-assistant-status]')).toContainText('unavailable')
  await owner.page.getByRole('button', { name: 'Retry' }).click(); await expect(owner.page.getByLabel('Hide lead phone numbers')).toBeChecked()
  await owner.page.getByLabel('Hide lead phone numbers').uncheck(); await expect.poll(() => writes).toBe(1); await expect(owner.page.locator('[data-assistant-status]')).toContainText('unavailable'); await expect(owner.page.getByLabel('Hide lead phone numbers')).toBeChecked()
  await owner.context.close()
})
