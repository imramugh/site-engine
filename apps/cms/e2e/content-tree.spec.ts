import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
type Role = 'owner' | 'editor' | 'hiring'

async function pageFor(browser: Browser, role: Role) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  const token = role === 'owner'
    ? 'synthetic-operations-owner-session-token'
    : `synthetic-application-${role}-session-token`
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({
    name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const,
  })))
  return { context, page: await context.newPage() }
}

async function assertNoAxeViolations(page: Page) {
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])
}

test('ENG-003 and ENG-006 give owner and editor a usable filtered content list', async ({ browser }) => {
  for (const role of ['owner', 'editor'] as const) {
    const session = await pageFor(browser, role)
    await session.page.goto('/content-tree')
    await expect(session.page.getByRole('heading', { name: 'Content tree' })).toBeVisible()
    await expect(session.page.locator('[data-content-list]')).toBeVisible()
    await expect(session.page.locator('[data-content-table] tbody tr')).toHaveCount(1)
    await expect(session.page.getByRole('link', { name: /Drafts/ })).toBeVisible()

    const search = session.page.getByRole('textbox', { name: 'Search pages' })
    await search.fill('direct-edit-browser-page')
    await search.press('Enter')
    await expect(session.page).toHaveURL(/q=direct-edit-browser-page/)
    const rowLink = session.page.locator('[data-content-page-link]').first()
    await rowLink.focus()
    await expect(rowLink).toBeFocused()
    await session.page.keyboard.press('Enter')
    await expect(session.page).toHaveURL(/\/admin\/collections\/pages\//)

    await session.page.goto('/content-tree?status=archived')
    await expect(session.page.getByTestId('content-empty')).toContainText('No pages match')
    await assertNoAxeViolations(session.page)

    await session.page.setViewportSize({ width: 390, height: 844 })
    await session.page.goto('/content-tree')
    const scroll = session.page.getByTestId('content-table-scroll')
    await scroll.focus()
    await expect(scroll).toBeFocused()
    expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await assertNoAxeViolations(session.page)
    await session.context.close()
  }
})

test('ENG-006 denies a Hiring session access to content pages', async ({ browser }) => {
  const session = await pageFor(browser, 'hiring')
  await session.page.goto('/content-tree')
  await expect(session.page).toHaveURL(/\/admin\/login/)
  await session.context.close()
})
