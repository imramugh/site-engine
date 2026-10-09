import { expect, test, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

async function fillSignIn(page: Page) {
  await page.getByLabel('Work email').fill('staff@example.test')
  await page.getByLabel('Authenticator or recovery code').fill('synthetic-recovery-code')
}

for (const width of [1440, 390, 320]) {
  test(`staff login is readable and keyboard accessible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/admin/login')
    await expect(page.locator('[data-admin-login]')).toBeVisible()
    await expect(page).toHaveTitle(/^Staff sign in \| /)
    await expect(page.getByRole('heading', { name: 'Staff sign in', exact: true })).toHaveCount(1)
    await expect(page.getByRole('heading', { name: 'Authenticator sign-in' })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const email = page.getByLabel('Work email')
    const code = page.getByLabel('Authenticator or recovery code')
    const submit = page.getByTestId('emergency-sign-in')
    await page.keyboard.press('Tab')
    await expect(email).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(code).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(submit).toBeFocused()
    for (const control of [email, code, submit]) {
      const box = await control.boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(44)
      expect(box!.width).toBeGreaterThanOrEqual(44)
    }
    expect((await code.boundingBox())!.y).toBeGreaterThan((await email.boundingBox())!.y + (await email.boundingBox())!.height)
    await expect(code).toHaveAttribute('aria-describedby', 'emergency-code-help')
    await expect(page.locator('#emergency-code-help')).toBeVisible()
    await page.addScriptTag({ path: axeSource })
    expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] },
    })).violations)).toEqual([])
  })
}

for (const failure of [
  { status: 401, message: 'Sign-in was not accepted.' },
  { status: 429, message: 'Sign-in is temporarily locked.' },
  { status: 0, message: 'Sign-in is unavailable.' },
]) {
  test(`staff login explains ${failure.status || 'network'} failures and clears the code`, async ({ page }) => {
    await page.goto('/admin/login')
    await page.route('**/api/auth/local', route => failure.status
      ? route.fulfill({ status: failure.status, contentType: 'application/json', body: '{}' })
      : route.abort('failed'))
    await fillSignIn(page)
    await page.getByTestId('emergency-sign-in').click()
    await expect(page.getByTestId('emergency-sign-in-message')).toContainText(failure.message)
    await expect(page.getByLabel('Authenticator or recovery code')).toHaveValue('')
    await expect(page.getByLabel('Work email')).toHaveValue('staff@example.test')
    await expect(page.getByTestId('emergency-sign-in')).toBeEnabled()
  })
}

test('staff login prevents duplicate submissions while authentication is pending', async ({ page }) => {
  await page.goto('/admin/login')
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  let requests = 0
  await page.route('**/api/auth/local', async route => {
    requests++
    await pending
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' })
  })
  await fillSignIn(page)
  await page.getByTestId('emergency-sign-in').click()
  try {
    await expect(page.getByTestId('emergency-sign-in')).toHaveText('Signing in…')
    await expect(page.getByTestId('emergency-sign-in')).toBeDisabled()
    await expect(page.getByLabel('Work email')).toBeDisabled()
    await expect(page.getByLabel('Authenticator or recovery code')).toBeDisabled()
    expect(requests).toBe(1)
  } finally { finish() }
  await expect(page.getByTestId('emergency-sign-in')).toBeEnabled()
})

for (const continuation of [
  { query: 'returnTo=https%3A%2F%2Fexternal.example', destination: '/admin' },
  { query: 'returnTo=%2F%2Fexternal.example', destination: '/admin' },
  { query: 'returnTo=%2Foauth%2Finteraction%2Fapproved', destination: '/oauth/interaction/approved' },
  { query: 'resume=%2Foauth%2Finteraction%2Fresumed', destination: '/oauth/interaction/resumed' },
]) {
  test(`staff login safely continues from ${continuation.query}`, async ({ page }) => {
    await page.goto(`/admin/login?${continuation.query}`)
    const origin = new URL(page.url()).origin
    await page.route('**/api/auth/local', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
    // A minimal destination proves navigation without creating a fake authenticated session.
    await page.route(`${origin}${continuation.destination}`, route => route.fulfill({ contentType: 'text/html', body: '<main>Destination</main>' }))
    await fillSignIn(page)
    await page.getByTestId('emergency-sign-in').click()
    await page.waitForURL(`${origin}${continuation.destination}`)
  })
}
