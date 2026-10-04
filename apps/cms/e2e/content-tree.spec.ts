import { expect, test, type Browser } from '@playwright/test'
import { createRequire } from 'node:module'
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
async function pageFor(browser: Browser, role: 'owner' | 'editor' | 'sales') { const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true }); const token = role === 'owner' ? 'synthetic-operations-owner-session-token' : `synthetic-application-${role}-session-token`; await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const }))); return { context, page: await context.newPage() } }
async function openMenu(page: Awaited<ReturnType<typeof pageFor>>['page']) {
  const button = page.getByTestId('mobile-menu')
  if (await button.isVisible() && await button.getAttribute('aria-expanded') === 'false') {
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
  }
}
test('ENG-006 exposes an accessible editor content tree through the native navigation', async ({ browser }) => {
  test.setTimeout(60_000)
  for (const role of ['owner', 'editor'] as const) { const session = await pageFor(browser, role); await session.page.goto('/admin'); const mobileMenu = session.page.getByTestId('mobile-menu'); await mobileMenu.click(); await expect(mobileMenu).toHaveAttribute('aria-expanded', 'true'); await session.page.keyboard.press('Escape'); await expect(mobileMenu).toHaveAttribute('aria-expanded', 'false'); const skip = session.page.getByRole('link', { name: 'Skip navigation' }); await skip.focus(); await session.page.keyboard.press('Enter'); await expect(session.page.getByRole('main')).toBeFocused(); await openMenu(session.page); const navigation = session.page.getByRole('navigation', { name: 'Workspace' }); const link = navigation.getByRole('link', { name: 'Content tree' }); await link.click(); await expect(session.page).toHaveURL(/\/content-tree$/); await expect(session.page.getByRole('heading', { name: 'Content tree' })).toBeVisible(); const overview = navigation.getByRole('link', { name: 'Overview' }); await overview.focus(); await expect(overview).toBeFocused(); await session.page.addScriptTag({ path: axeSource }); expect(await session.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([]); await session.page.setViewportSize({ width: 390, height: 844 }); await session.page.goto('/admin'); await openMenu(session.page); const mobileLink = session.page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Content tree' }); await mobileLink.click(); await expect(session.page.getByRole('heading', { name: 'Content tree' })).toBeVisible(); await session.context.close() }
  const legacyEditorial = await pageFor(browser, 'owner'); await legacyEditorial.page.goto('/admin/editorial'); await expect(legacyEditorial.page).toHaveURL(/\/editorial$/); await expect(legacyEditorial.page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Editorial review' })).toBeVisible(); await legacyEditorial.context.close()
  const sales = await pageFor(browser, 'sales'); await sales.page.goto('/content-tree'); await expect(sales.page).toHaveURL(/\/admin\/login/); await sales.context.close()
})
