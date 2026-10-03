import { expect, test, type Page } from '@playwright/test'

const ownerInvite = 'synthetic-browser-owner-invite'

async function signIn(page: Page, identity: 'owner' | 'editor', invite?: string): Promise<string> {
  const start = page.waitForResponse((response) => response.url().startsWith('https://127.0.0.1:4300/api/auth/google') && response.status() === 307)
  const callback = page.waitForRequest((request) => request.url().startsWith('https://127.0.0.1:4300/api/auth/callback/google?'))
  await page.goto(invite ? `/api/auth/google?invite=${invite}` : '/api/auth/google')
  expect((await start).headers()['critical-ch']).toBeUndefined()
  await page.getByRole('button', { name: identity === 'owner' ? 'Sign in as Synthetic Owner' : 'Sign in as Synthetic Editor' }).click()
  const callbackURL = (await callback).url()
  await page.waitForURL(/\/admin(?:\?.*)?$/)
  return callbackURL
}

async function signInLocalOwner(page: Page, recoveryCode = 'synthetic-local-recovery-code-02'): Promise<void> {
  const providerRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith('https://127.0.0.1:4301/')) providerRequests.push(request.url())
  })
  await page.goto('/admin/login')
  await page.locator('#emergency-email').fill('emergency-owner.synthetic@example.test')
  await page.locator('#emergency-code').fill(recoveryCode)
  await page.getByTestId('emergency-sign-in').click()
  await page.waitForURL(/\/admin(?:\?.*)?$/)
  expect(providerRequests).toEqual([])
}

test('an invited Google identity creates an owner session and loads admin', async ({ page }) => {
  await signIn(page, 'owner', ownerInvite)
  await expect(page).not.toHaveURL(/\/admin\/login/)
  await expect(page.locator('body')).not.toContainText('Synthetic identity provider')
  await expect(page.getByRole('link', { name: 'Pages', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Collections' })).toBeVisible()
  const pageCard = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Pages', exact: true }) })
  await expect(pageCard).toBeVisible()
  expect(await page.locator('html').evaluate((element) => getComputedStyle(element).getPropertyValue('--theme-elevation-0').trim())).not.toBe('')
  const session = (await page.context().cookies()).find((cookie) => cookie.name === '__Host-site_engine_session')
  expect(session).toMatchObject({ secure: true, httpOnly: true, path: '/', sameSite: 'Lax' })
  await page.screenshot({ path: 'artifacts/playwright-cms/owner-admin.png', fullPage: true })
  const response = await page.request.get('/api/users/me')
  expect(response.ok()).toBeTruthy()
  const body = await response.text()
  expect(body).toContain('owner.synthetic@example.test')
  expect(body).not.toContain('synthetic-browser-secret')
  expect(body).not.toContain('synthetic-browser-payload-secret-not-for-production')
})

test('an editor can read only its own profile and anonymous REST stays denied', async ({ browser, page }) => {
  const anonymous = await browser.newContext()
  const anonymousResponse = await anonymous.request.get('https://127.0.0.1:4300/api/users')
  expect(anonymousResponse.status()).toBeGreaterThanOrEqual(400)
  expect(await anonymousResponse.text()).not.toContain('owner.synthetic@example.test')
  await anonymous.close()

  await signIn(page, 'editor')
  const me = await page.request.get('/api/users/me')
  expect(me.ok()).toBeTruthy()
  expect(await me.text()).toContain('editor.synthetic@example.test')
  const users = await page.request.get('/api/users?limit=20')
  expect(users.ok()).toBeTruthy()
  const usersBody = await users.text()
  expect(usersBody).toContain('editor.synthetic@example.test')
  expect(usersBody).not.toContain('owner.synthetic@example.test')
  expect(usersBody).not.toContain('synthetic-browser-secret')
  expect(usersBody).not.toContain('synthetic-encrypted-secret-sentinel')
  expect(usersBody).not.toContain('synthetic-recovery-hash-sentinel')
  await page.goto('/admin')
  const adminHTML = await page.content()
  expect(adminHTML).not.toContain('synthetic-encrypted-secret-sentinel')
  expect(adminHTML).not.toContain('synthetic-recovery-hash-sentinel')
})

test('logout revokes the session, replays are denied, and cross-origin POST is blocked by Next proxy', async ({ page }) => {
  const callbackURL = await signIn(page, 'editor')
  const logoutStatus = await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST' })).status)
  expect(logoutStatus).toBe(204)
  const afterLogout = await page.request.get('/api/users/me')
  const afterLogoutBody = await afterLogout.json() as { user?: unknown }
  expect(afterLogoutBody.user ?? null).toBeNull()
  const protectedAfterLogout = await page.request.get('/api/users')
  expect(protectedAfterLogout.status()).toBeGreaterThanOrEqual(400)

  await page.goto(callbackURL)
  await expect(page.locator('body')).toContainText(/Sign-in browser binding is invalid|Sign-in request expired or was already used/)

  await page.goto('https://127.0.0.1:4301/cross-origin-post')
  await page.getByRole('button', { name: 'Submit cross-origin logout' }).click()
  await expect(page.locator('body')).toContainText('CSRF origin check failed.')
})

test('the login page truthfully reports a disabled provider', async ({ page }) => {
  await page.goto('/admin/login')
  await expect(page.getByText('Microsoft sign-in is not configured.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible()
})

test('emergency owner UI rejects a wrong code and accepts a single-use recovery code', async ({ page }) => {
  await page.goto('/admin/login')
  await page.locator('#emergency-email').fill('emergency-owner.synthetic@example.test')
  await page.locator('#emergency-code').fill('wrong-code')
  await page.getByTestId('emergency-sign-in').click()
  await expect(page.getByTestId('emergency-sign-in-message')).toHaveText('Emergency sign-in was not accepted. Check your email and code, then try again.')
  await page.locator('#emergency-code').fill('synthetic-recovery-code-01')
  await page.getByTestId('emergency-sign-in').click()
  await page.waitForURL(/\/admin(?:\?.*)?$/)
  const me = await page.request.get('/api/users/me')
  expect(await me.text()).toContain('emergency-owner.synthetic@example.test')
  expect(await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST' })).status)).toBe(204)
  await page.goto('/admin/login')
  await page.locator('#emergency-email').fill('emergency-owner.synthetic@example.test')
  await page.locator('#emergency-code').fill('synthetic-recovery-code-01')
  await page.getByTestId('emergency-sign-in').click()
  await expect(page.getByTestId('emergency-sign-in-message')).toHaveText('Emergency sign-in was not accepted. Check your email and code, then try again.')
})

test('a locally provisioned owner uses the authenticator without OIDC, browses collections, and is disabled authoritatively', async ({ page }) => {
  await signInLocalOwner(page)
  await expect(page.getByRole('heading', { name: 'Collections' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Pages', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sections', exact: true })).toBeVisible()

  const me = await page.request.get('/api/users/me')
  expect(me.ok()).toBeTruthy()
  const meBody = await me.json() as { user?: { email?: string; provider?: unknown; providerIssuer?: unknown; providerSubject?: unknown } }
  expect(meBody.user?.email).toBe('emergency-owner.synthetic@example.test')
  expect(meBody.user?.provider).toBeNull()
  expect(meBody.user?.providerIssuer).toBeNull()
  expect(meBody.user?.providerSubject).toBeNull()

  for (const collection of ['pages', 'sections']) {
    const response = await page.goto(`/admin/collections/${collection}`)
    expect(response?.ok()).toBeTruthy()
    await expect(page).toHaveURL(new RegExp(`/admin/collections/${collection}(?:\\?.*)?$`))
  }

  const oldSession = (await page.context().cookies()).find((cookie) => cookie.name === '__Host-site_engine_session')
  expect(oldSession?.value).toBeTruthy()
  const logoutRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('logout')) logoutRequests.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  const logout = page.getByRole('link', { name: 'Log out' })
  await page.getByRole('button', { name: 'Open Menu' }).click()
  await logout.click()
  await page.waitForURL(/\/admin\/login/)
  expect(logoutRequests).toContain('POST /api/auth/logout')
  const replayedSession = await page.request.get('/api/users/me', { headers: { cookie: `${oldSession!.name}=${oldSession!.value}` } })
  expect((await replayedSession.json() as { user?: unknown }).user ?? null).toBeNull()

  await signInLocalOwner(page, 'synthetic-local-recovery-code-03')
  const disabled = await page.request.post('/__e2e/local-owner/disable')
  expect(disabled.status()).toBe(204)
  const disabledMe = await page.request.get('/api/users/me')
  expect((await disabledMe.json() as { user?: unknown }).user ?? null).toBeNull()
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin\/login/)
})
