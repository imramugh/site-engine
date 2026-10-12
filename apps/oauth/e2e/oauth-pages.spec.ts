import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const require = createRequire(import.meta.url)
const axeSource = require.resolve('axe-core/axe.min.js')
const origin = 'http://127.0.0.1:4312'

type RegisteredClient = { authorization: string }

async function registerClient(page: Page, name = 'Synthetic assistant', requestedScopes = 'mcp:content:read mcp:content:write mcp:redirects:read mcp:redirects:write mcp:leads:read mcp:leads:write mcp:leads:reply mcp:careers:read mcp:careers:write mcp:careers:reply'): Promise<RegisteredClient> {
  const challenge = createHash('sha256').update(randomBytes(48).toString('base64url')).digest('base64url')
  const registration = await page.request.post(`${origin}/oauth/reg`, { data: {
    client_name: name, redirect_uris: [`${origin}/e2e/callback`], token_endpoint_auth_method: 'none', response_types: ['code'], grant_types: ['authorization_code'], scope: requestedScopes,
  } })
  expect(registration.status()).toBe(201)
  const { client_id } = await registration.json() as { client_id: string }
  return { authorization: `/oauth/auth?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: `${origin}/e2e/callback`, resource: `${origin}/mcp`, scope: requestedScopes, state: 'synthetic-state', code_challenge: challenge, code_challenge_method: 'S256' })}` }
}

async function setSession(page: Page, value = 'staff'): Promise<void> {
  await page.context().addCookies([{ name: 'oauth_e2e_session', value, url: origin, httpOnly: true, sameSite: 'Lax' }])
}

async function reachConsent(page: Page, authorization: string): Promise<void> {
  await page.goto(authorization)
  await expect(page.locator('.oauth-page')).toBeVisible()
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Authorize access', exact: true })).toBeVisible()
}

async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
}

test('ENG-219 recovers an unauthenticated authorization request without exposing its query', async ({ page }, testInfo) => {
  const client = await registerClient(page)
  const response = await page.goto(client.authorization)
  expect(response?.status()).toBe(401)
  await expect(page.getByRole('heading', { name: 'Sign in required', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open sign in', exact: true })).toHaveAttribute('target', '_blank')
  await expect(page.getByRole('link', { name: 'Retry authorization', exact: true })).toBeVisible()
  await expect(page.locator('.oauth-page .oauth-card')).toBeVisible()
  expect(await page.locator('body').innerText()).not.toContain('code_challenge=')
  await expectNoOverflow(page)
  await screenshot(page, testInfo, 'sign-in-required-desktop')
})

test('ENG-219 presents escaped client information and explicit consent controls', async ({ page }, testInfo) => {
  await setSession(page)
  const client = await registerClient(page, '<img src=x onerror=alert(1)> Assistant')
  await reachConsent(page, client.authorization)
  await expect(page.getByRole('heading', { name: 'Authorize access', exact: true })).toBeVisible()
  await expect(page.locator('.oauth-card')).toContainText('<img src=x onerror=alert(1)> Assistant')
  await expect(page.locator('.oauth-card img[onerror]')).toHaveCount(0)
  await expect(page.locator('.oauth-permissions li')).toHaveCount(10)
  await expect(page.locator('.oauth-permissions')).toContainText('View site content.')
  await expect(page.locator('.oauth-permissions')).toContainText('Prepare and send human-confirmed replies to applicants.')
  await page.getByRole('button', { name: 'Allow', exact: true }).focus()
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeFocused()
  for (const control of [page.getByRole('button', { name: 'Allow', exact: true }), page.getByRole('button', { name: 'Deny', exact: true })]) {
    const box = await control.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect(box?.width).toBeGreaterThanOrEqual(44)
  }
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await screenshot(page, testInfo, 'consent-desktop')
})

test('ENG-219 denies consent through the real authorization interaction', async ({ page }) => {
  await setSession(page)
  const client = await registerClient(page)
  await reachConsent(page, client.authorization)
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await page.waitForURL('**/e2e/callback?**')
  const result = new URL(page.url())
  expect(result.searchParams.get('error')).toBe('access_denied')
  expect(result.searchParams.get('state')).toBe('synthetic-state')
})

test('ENG-219 keeps OAuth shells responsive and local-only at desktop and phone widths', async ({ page }, testInfo) => {
  await setSession(page)
  const client = await registerClient(page)
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  for (const width of [1440, 390, 320]) {
    await page.context().clearCookies()
    await setSession(page)
    await page.setViewportSize({ width, height: 900 })
    await reachConsent(page, client.authorization)
    for (const [control, minHeight] of [[page.getByRole('button', { name: 'Allow', exact: true }), 44], [page.getByRole('button', { name: 'Deny', exact: true }), 44], [page.locator('.oauth-details summary'), 24]] as const) {
      const box = await control.boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(minHeight)
    }
    await expectNoOverflow(page)
    await screenshot(page, testInfo, `consent-${width}`)
  }
  expect(requests.every(request => new URL(request).origin === origin)).toBe(true)
})

test('ENG-219 renders malformed provider interaction failures in the branded error shell', async ({ page }) => {
  await setSession(page)
  const secret = 'raw-authorization-query-must-not-render'
  const response = await page.goto(`/oauth/interaction/not-a-valid-interaction?error=${secret}`)
  expect(response?.status()).toBeGreaterThanOrEqual(400)
  await expect(page.locator('.oauth-page .oauth-card')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Unable to continue', exact: true })).toBeVisible()
  expect(await page.locator('body').innerText()).not.toContain(secret)
})

test('ENG-219 renders provider sign-out confirmation and completion in the shared shell', async ({ page }, testInfo) => {
  await setSession(page)
  const client = await registerClient(page, 'Synthetic assistant', 'mcp:content:read')
  await reachConsent(page, client.authorization)
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await page.waitForURL('**/e2e/callback?**')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/oauth/session/end')
  await expect(page.locator('.oauth-page .oauth-card')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign out', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Yes, sign me out', exact: true })).toBeVisible()
  await screenshot(page, testInfo, 'sign-out-confirmation-1440')
  await page.setViewportSize({ width: 390, height: 900 })
  await expectNoOverflow(page)
  await screenshot(page, testInfo, 'sign-out-confirmation-390')
  await page.getByRole('button', { name: 'Yes, sign me out', exact: true }).click()
  await expect(page.locator('.oauth-page .oauth-card')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Signed out', exact: true })).toBeVisible()
})

test('ENG-219 keeps an account-switch authorization interaction in the shared shell', async ({ page }) => {
  await setSession(page, 'staff')
  const firstClient = await registerClient(page, 'First synthetic assistant', 'mcp:content:read')
  await reachConsent(page, firstClient.authorization)
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await page.waitForURL('**/e2e/callback?**')
  await setSession(page, 'other')
  const switchedClient = await registerClient(page, 'Second synthetic assistant', 'mcp:content:read')
  await page.goto(switchedClient.authorization)
  await expect(page.locator('.oauth-page .oauth-card')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Authorize access', exact: true })).toBeVisible()
  await expectNoOverflow(page)
})
