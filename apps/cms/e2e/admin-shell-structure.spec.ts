import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
type EditorialRole = 'owner' | 'editor' | 'approver'

async function pageFor(browser: Browser, role: 'owner' | 'sales' | 'hiring') {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  const token = role === 'owner' ? 'synthetic-operations-owner-session-token' : `synthetic-application-${role}-session-token`
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function installAxe(page: Page) {
  await page.addScriptTag({ path: axeSource })
  return page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run()).violations)
}

async function shellPageFor(browser: Browser, role: EditorialRole) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  const token = `synthetic-shell-${role}-session-token`
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function expectFullDocumentAxePass(page: Page) {
  const violations = await installAxe(page)
  expect(violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    targets: nodes.map(node => node.target),
  }))).toEqual([])
}

test('ENG-006 renders the role-aware admin shell at desktop and mobile widths', async ({ browser }) => {
  const owner = await pageFor(browser, 'owner')
  await owner.page.setViewportSize({ width: 1440, height: 900 })
  await owner.page.goto('/admin')

  const sidebar = owner.page.locator('[data-admin-sidebar]')
  await expect(sidebar).toBeVisible()
  await expect(sidebar).toHaveCSS('width', '240px')
  await expect(owner.page.locator('[data-admin-header]')).toBeVisible()
  await expect(owner.page.locator('[data-admin-page-title]')).toHaveText('Dashboard')
  await expect(owner.page.locator('[data-admin-view-site]')).toHaveAttribute('href', '/')
  const brand = owner.page.locator('[data-admin-brand]')
  const brandInitials = brand.locator(':scope > span')
  await expect(brand).toHaveAccessibleName('SW Site workspace')
  await expect(brandInitials).toHaveText('SW')
  const initialGeometry = await brandInitials.evaluate((element) => {
    const style = getComputedStyle(element)
    return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height), rootSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize), position: style.position }
  })
  expect(initialGeometry.width).toBe(2.25 * initialGeometry.rootSize)
  expect(initialGeometry.height).toBe(2.25 * initialGeometry.rootSize)
  expect(initialGeometry.position).toBe('static')
  await expect(brand.locator(':scope > strong')).toHaveText('Site workspace')
  await expect(owner.page.locator('[data-admin-primary] a[href="/leads"]')).toHaveAccessibleName('Leads')
  await expect(owner.page.locator('[data-admin-primary] a[href="/applications"]')).toHaveAccessibleName('Careers')
  await expect(owner.page.locator('[data-admin-primary] a[href="/editorial"]')).toHaveAccessibleName('Reviews')
  await expect(owner.page.locator('[data-admin-primary] [data-admin-nav-item] > span:not([data-admin-nav-badge])')).toHaveText(['Dashboard', 'Content', 'Block gallery', 'Media', 'Leads', 'Careers', 'Reviews', 'Change log'])
  await expect(owner.page.locator('[data-admin-secondary] [data-admin-nav-item] > span:not([data-admin-nav-badge])')).toHaveText(['Site', 'Integrations', 'Users'])
  await expect(owner.page.locator('[data-admin-nav-separator]')).toHaveCount(1)
  await owner.page.locator('[data-admin-account-button]').click()
  await expect(owner.page.getByRole('menuitem', { name: 'Sign out', exact: true })).toHaveAttribute('type', 'button')
  await owner.page.screenshot({ path: 'artifacts/playwright-cms/admin-shell-1440.png', fullPage: true })
  expect(await installAxe(owner.page)).toEqual([])

  await owner.page.setViewportSize({ width: 390, height: 844 })
  const menu = owner.page.getByTestId('mobile-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAccessibleName('Menu: open navigation')
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await expect(owner.page.locator('[data-admin-navigation]')).toBeHidden()
  await menu.click()
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  await expect(menu).toHaveAccessibleName('Close navigation')
  await expect(owner.page.locator('[data-admin-navigation]')).toBeVisible()
  await expect(brand).toHaveAccessibleName('SW Site workspace')
  await expect(brandInitials).toBeVisible()
  await expect(owner.page.locator('[data-admin-sidebar]')).toHaveCSS('width', '390px')
  await owner.page.keyboard.press('Escape')
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await expect(menu).toBeFocused()
  await owner.page.screenshot({ path: 'artifacts/playwright-cms/admin-shell-390.png', fullPage: true })
  await menu.click()
  expect(await installAxe(owner.page)).toEqual([])
  await owner.context.close()

  const sales = await pageFor(browser, 'sales')
  await sales.page.goto('/admin')
  await expect(sales.page.locator('[data-admin-primary] [data-admin-nav-item] > span:not([data-admin-nav-badge])')).toHaveText(['Dashboard', 'Leads'])
  await expect(sales.page.locator('[data-admin-secondary]')).toHaveCount(0)
  await sales.page.goto('/content-tree')
  await expect(sales.page).toHaveURL(/\/admin\/login/)
  await sales.context.close()

  const hiring = await pageFor(browser, 'hiring')
  await hiring.page.goto('/admin')
  await expect(hiring.page.locator('[data-admin-primary] [data-admin-nav-item] > span:not([data-admin-nav-badge])')).toHaveText(['Dashboard', 'Careers'])
  await hiring.context.close()
})

test('ENG-006 keeps neutral shell and feature styles accessible across editorial roles and viewports', async ({ browser }) => {
  test.setTimeout(90_000)
  for (const role of ['owner', 'editor', 'approver'] as const) {
    const session = await shellPageFor(browser, role)
    await session.page.setViewportSize({ width: 1440, height: 900 })
    await session.page.goto('/admin')
    await expect(session.page.locator('[data-admin-account-role]')).toHaveText(role)

    const desktopStyles = await session.page.evaluate(() => {
      const main = document.querySelector('main')!
      const card = document.querySelector('[data-dashboard-metric]')!
      const input = document.querySelector('[data-admin-search] input')!
      const style = (element: Element) => getComputedStyle(element)
      return {
        mainPaddingLeft: Number.parseFloat(style(main).paddingLeft),
        cardRadius: Number.parseFloat(style(card).borderRadius),
        cardBackground: style(card).backgroundColor,
        cardBorderStyle: style(card).borderStyle,
        inputHeight: Number.parseFloat(style(input).height),
        inputMargin: style(input).margin,
      }
    })
    expect(desktopStyles.mainPaddingLeft).toBeGreaterThan(0)
    expect(desktopStyles.cardRadius).toBeGreaterThan(0)
    expect(desktopStyles.cardBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(desktopStyles.cardBorderStyle).toBe('solid')
    expect(desktopStyles.inputHeight).toBeGreaterThanOrEqual(32)
    expect(desktopStyles.inputHeight).toBeLessThan(60)
    expect(desktopStyles.inputMargin).toBe('0px')
    await expectFullDocumentAxePass(session.page)

    await session.page.setViewportSize({ width: 390, height: 844 })
    const menu = session.page.getByTestId('mobile-menu')
    await menu.click()
    await expect(session.page.locator('[data-admin-navigation]')).toBeVisible()
    const mobileButton = await menu.evaluate((element) => {
      const style = getComputedStyle(element)
      return { height: Number.parseFloat(style.height), background: style.backgroundColor }
    })
    expect(mobileButton.height).toBeGreaterThanOrEqual(36)
    expect(mobileButton.background).toBe('rgba(0, 0, 0, 0)')
    await expectFullDocumentAxePass(session.page)
    await session.context.close()
  }
})
