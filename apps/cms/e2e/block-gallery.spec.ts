import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
test('ENG-018 lets an Owner browse accessible blocks and insert a template-filtered draft recipe', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-operations-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  const created = await page.request.post(`${origin}/api/editorial/create`, { headers: { origin, 'content-type': 'application/json' }, data: { name: 'Browser gallery recipe' } })
  expect(created.ok()).toBe(true)
  await page.goto('/admin'); const menu = page.locator('button.nav-toggler:visible'); if (await menu.getAttribute('aria-label') === 'Open Menu') { await menu.click(); await expect(menu).toHaveAttribute('aria-label', 'Close Menu') }
  await page.locator('a[href="/block-gallery"]:visible').click()
  await expect(page.getByRole('heading', { name: 'Block gallery' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Supported blocks' })).toBeVisible()
  await page.addScriptTag({ path: axeSource }); expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])
  await page.getByLabel('Draft page').selectOption({ index: 0 })
  await page.getByRole('checkbox', { name: 'hero' }).check()
  await page.getByRole('button', { name: 'Insert draft recipe' }).click()
  await expect(page.getByRole('status')).toContainText('captured')
  await context.close()
})
