import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import { TOTP } from 'otpauth'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const issuerOrigin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300) + 1}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const owner = { email: 'local-auth-owner.synthetic@example.test', recoveryCodes: ['synthetic-local-auth-owner-code-01', 'synthetic-local-auth-owner-code-02'] }

type Invitation = { id: string; inviteURL: string }

async function localSignIn(page: Page, recoveryCode: string): Promise<void> {
  await page.goto('/admin/login')
  await page.getByTestId('local-auth-email').fill(owner.email)
  await page.getByTestId('local-auth-code').fill(recoveryCode)
  await page.getByTestId('emergency-sign-in').click()
  await page.waitForURL(/\/admin(?:\?.*)?$/)
}

async function createOwner(browser: Browser, recoveryCode: string) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  const page = await context.newPage()
  await localSignIn(page, recoveryCode)
  return { context, page }
}

async function invite(page: Page, email: string, roles: string[] = ['editor']): Promise<Invitation> {
  await page.goto('/users')
  await page.getByRole('button', { name: '+ Invite person' }).click()
  await page.getByTestId('invite-email').fill(email)
  for (const role of roles) await page.getByRole('checkbox', { name: new RegExp(role, 'i') }).check()
  const response = page.waitForResponse((item) => item.url().endsWith('/api/users/workspace') && item.request().method() === 'POST')
  await page.getByTestId('invite-create').click()
  expect((await response).status()).toBe(201)
  const inviteURL = await page.getByTestId('invitation-link').inputValue()
  const workspace = await page.request.get('/api/users/workspace')
  expect(workspace.ok()).toBeTruthy()
  const data = await workspace.json() as { invitations: Array<{ id: string; email: string }> }
  const created = data.invitations.find((item) => item.email === email)
  expect(created).toBeTruthy()
  return { id: created!.id, inviteURL }
}

function enrollmentCode(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret')
  expect(secret).toBeTruthy()
  return new TOTP({ secret: secret! }).generate()
}

function invalidEnrollmentCode(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret')
  expect(secret).toBeTruthy()
  const totp = new TOTP({ secret: secret!, algorithm: 'SHA1', digits: 6, period: 30 })
  const valid = new Set([-1, 0, 1].map((window) => totp.generate({ timestamp: Date.now() + window * 30_000 })))
  let invalid = '000000'
  while (valid.has(invalid)) invalid = String((Number(invalid) + 1) % 1_000_000).padStart(6, '0')
  return invalid
}

async function axe(page: Page): Promise<void> {
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
}

async function wholeDocumentAxe(page: Page): Promise<void> {
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
}

const localPost = (page: Page, path: string, data: unknown) => page.request.post(path, { headers: { origin }, data })

test('Owner can invite a local Editor who enrolls from QR or manual key, receives recovery codes once, and signs in locally', async ({ browser }) => {
  test.setTimeout(90_000)
  const ownerSession = await createOwner(browser, owner.recoveryCodes[0])
  const providerRequests: string[] = []
  ownerSession.page.on('request', (request) => {
    if (request.url().startsWith(issuerOrigin)) providerRequests.push(request.url())
  })
  const invitation = await invite(ownerSession.page, 'enrolled-editor.synthetic@example.test')
  expect(invitation.inviteURL).toMatch(/\/admin\/enroll#invite=/)
  expect(providerRequests).toEqual([])

  const initialHTML = await ownerSession.page.request.get('/admin/enroll')
  expect(initialHTML.ok()).toBeTruthy()
  expect(await initialHTML.text()).not.toContain('otpauth://')

  const enrollee = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  const page = await enrollee.newPage()
  page.on('request', (request) => {
    if (request.url().startsWith(issuerOrigin)) providerRequests.push(request.url())
  })
  const preparedResponse = page.waitForResponse((response) => response.url().endsWith('/api/auth/enroll') && response.request().method() === 'POST')
  await page.goto(invitation.inviteURL)
  const prepared = await (await preparedResponse).json() as { otpauthURI: string }
  await expect(page).toHaveTitle('Set up your authenticator | Site Engine')
  await expect(page.getByTestId('enrollment-qr')).toHaveAttribute('alt', 'QR code for your authenticator app')
  await page.getByText('Set up manually instead').click()
  const manualKey = await page.getByTestId('enrollment-manual-key').textContent()
  expect(manualKey).toBe(new URL(prepared.otpauthURI).searchParams.get('secret'))
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await wholeDocumentAxe(page)
    await page.screenshot({ path: `artifacts/playwright-cms/local-enrollment-${size.width}.png`, fullPage: true })
  }
  await page.getByTestId('enrollment-name').fill('Enrolled Editor')
  await page.getByTestId('enrollment-code').fill(enrollmentCode(prepared.otpauthURI))
  await page.getByTestId('enrollment-confirm').click()
  await expect(page.getByTestId('recovery-codes')).toBeVisible()
  const recoveryCode = await page.getByTestId('recovery-code').first().textContent()
  expect(recoveryCode).toMatch(/^[A-Za-z0-9_-]{6,}$/)
  await expect(page.getByTestId('finish-enrollment')).toBeDisabled()
  await page.getByTestId('recovery-acknowledge').check()
  await page.getByTestId('finish-enrollment').click()
  await page.waitForURL(/\/admin(?:\?.*)?$/)

  const nonOwner = await page.request.get('/api/users/workspace')
  expect(nonOwner.status()).toBe(403)
  await page.request.post('/api/auth/logout')
  await page.goto('/admin/login')
  await page.getByTestId('local-auth-email').fill('enrolled-editor.synthetic@example.test')
  await page.getByTestId('local-auth-code').fill(recoveryCode!)
  await page.getByTestId('emergency-sign-in').click()
  await page.waitForURL(/\/admin(?:\?.*)?$/)
  await page.request.post('/api/auth/logout')
  const replay = await page.request.post('/api/auth/local', { data: { email: 'enrolled-editor.synthetic@example.test', code: recoveryCode } })
  expect(replay.status()).toBe(403)
  expect(providerRequests).toEqual([])
  await enrollee.close()
  await ownerSession.context.close()
})

test('local enrollment rejects an invalid code and expired, revoked, and consumed invitations without contacting an identity provider', async ({ browser }) => {
  const ownerSession = await createOwner(browser, owner.recoveryCodes[1])
  const invalid = await invite(ownerSession.page, 'invalid-code.synthetic@example.test')
  const invalidToken = new URL(invalid.inviteURL).hash.slice('#invite='.length)
  const prepared = await localPost(ownerSession.page, '/api/auth/enroll', { action: 'prepare', token: invalidToken })
  expect(prepared.ok()).toBeTruthy()
  const preparedBody = await prepared.json() as { otpauthURI: string }
  const invalidCode = await localPost(ownerSession.page, '/api/auth/enroll', { action: 'confirm', token: invalidToken, name: 'Invalid Code', code: invalidEnrollmentCode(preparedBody.otpauthURI) })
  expect(invalidCode.status()).toBe(403)
  const enrollingContext = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  const confirmed = await enrollingContext.request.post('/api/auth/enroll', { headers: { origin }, data: { action: 'confirm', token: invalidToken, name: 'Confirmed Editor', code: enrollmentCode(preparedBody.otpauthURI) } })
  expect(confirmed.ok()).toBeTruthy()
  await enrollingContext.close()
  expect((await localPost(ownerSession.page, '/api/auth/enroll', { action: 'prepare', token: invalidToken })).status()).toBe(403)

  const revoked = await invite(ownerSession.page, 'revoked-invite.synthetic@example.test')
  const revokedToken = new URL(revoked.inviteURL).hash.slice('#invite='.length)
  const revoke = await localPost(ownerSession.page, '/api/users/workspace', { action: 'revoke-invitation', id: revoked.id })
  expect(revoke.ok()).toBeTruthy()
  expect((await localPost(ownerSession.page, '/api/auth/enroll', { action: 'prepare', token: revokedToken })).status()).toBe(403)

  const expired = await invite(ownerSession.page, 'expired-invite.synthetic@example.test')
  const expiredToken = new URL(expired.inviteURL).hash.slice('#invite='.length)
  expect((await ownerSession.page.request.post(`/__e2e/invitations/${expired.id}/expire`)).status()).toBe(204)
  expect((await localPost(ownerSession.page, '/api/auth/enroll', { action: 'prepare', token: expiredToken })).status()).toBe(403)
  await ownerSession.context.close()
})

test('local sign-in and enrollment are accessible on desktop and 390px screens', async ({ browser }) => {
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: size })
    const page = await context.newPage()
    await page.goto('/admin/login')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await axe(page)
    await page.screenshot({ path: `artifacts/playwright-cms/local-login-${size.width}.png`, fullPage: true })
    await context.close()
  }
})
