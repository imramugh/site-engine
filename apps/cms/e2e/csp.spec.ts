import { expect, test, type Response } from '@playwright/test'

function csp(response: Response | null) {
  const policy = response?.headers()['content-security-policy']
  if (!policy) throw new Error('CMS document CSP missing')
  return policy
}

test('production CMS nonce CSP hydrates the admin while blocking injected scripts', async ({ page }) => {
  const firstPolicy = csp(await page.goto('/admin/login'))
  const secondPolicy = csp(await page.reload())
  expect(firstPolicy).toMatch(/script-src 'self' 'nonce-[^']+'/)
  expect(/script-src ([^;]+)/.exec(firstPolicy)?.[1]).not.toContain("'unsafe-inline'")
  expect(firstPolicy).not.toContain("'unsafe-eval'")
  expect(firstPolicy.match(/'nonce-([^']+)'/)?.[1]).not.toBe(secondPolicy.match(/'nonce-([^']+)'/)?.[1])
  await expect(page.getByTestId('emergency-sign-in')).toBeEnabled()
  await page.route('**/api/auth/local', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }))
  await page.getByLabel('Work email').fill('staff@example.test')
  await page.getByLabel('Authenticator or recovery code').fill('synthetic-recovery-code')
  await page.getByTestId('emergency-sign-in').click()
  await expect(page.getByTestId('emergency-sign-in-message')).toContainText('Sign-in was not accepted.')

  const results = await page.evaluate(async () => {
    const blocked = (script: HTMLScriptElement) => new Promise<boolean>((resolve) => {
      script.addEventListener('load', () => resolve(false))
      script.addEventListener('error', () => resolve(true))
      document.body.append(script)
      setTimeout(() => resolve(true), 250)
    })
    const inline = document.createElement('script')
    inline.textContent = 'window.__cspInlineInjection = true'
    const external = document.createElement('script')
    external.src = 'data:text/javascript,window.__cspExternalInjection%3Dtrue'
    return {
      inlineBlocked: await blocked(inline),
      externalBlocked: await blocked(external),
      inlineExecuted: (window as Window & { __cspInlineInjection?: boolean }).__cspInlineInjection === true,
      externalExecuted: (window as Window & { __cspExternalInjection?: boolean }).__cspExternalInjection === true,
    }
  })
  expect(results).toEqual({ inlineBlocked: true, externalBlocked: true, inlineExecuted: false, externalExecuted: false })
})
