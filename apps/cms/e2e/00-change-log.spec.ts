import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

async function owner(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: 'synthetic-operations-owner-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function approver(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: 'synthetic-shell-approver-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function currentRelease(page: Page): Promise<Locator> {
  await page.goto('/operations?period=all&type=editorial')
  const row = page.locator('[data-change-log-row]').filter({ hasText: 'Change log current release approved for publishing' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'View', exact: true }).click()
  await expect(row).toContainText('Reviewed changes')
  await expect(row.locator('ins')).toContainText('A current published summary that the reviewed rollback browser flow restores.')
  await expect(row.locator('del')).not.toHaveText('Previous values')
  return row
}

async function prepareRollback(page: Page, row: Locator) {
  page.once('dialog', (dialog) => dialog.accept())
  const response = page.waitForResponse((value) => value.url().endsWith('/api/operations') && value.request().method() === 'POST')
  await row.getByRole('button', { name: 'Prepare rollback for review' }).click()
  const result = await response
  expect(result.status(), await result.text()).toBe(201)
}

test('ENG-010 prepares selected and whole latest-release rollback drafts for normal review', async ({ browser }) => {
  const session = await owner(browser)
  const selectedRow = await currentRelease(session.page)
  const scope = selectedRow.getByLabel('Rollback scope')
  await expect(scope).toBeEnabled()
  await scope.selectOption({ index: 1 })
  await expect(scope).not.toHaveValue('release')
  await prepareRollback(session.page, selectedRow)
  await expect(session.page.getByRole('status')).toContainText('Rollback change from release #56 is ready for editorial review.')

  await session.page.getByRole('link', { name: 'Open editorial review' }).click()
  const selectedDetail = session.page.getByRole('region', { name: 'Change set detail', exact: true })
  await expect(selectedDetail).toContainText('Rollback change from release #56')
  const selectedChanges = selectedDetail.getByRole('region', { name: 'Captured changes', exact: true })
  await expect(selectedChanges).toContainText('A current published summary that the reviewed rollback browser flow restores.')
  await expect(selectedChanges.locator('article')).toHaveCount(1)
  const discard = session.page.waitForResponse((value) => value.url().endsWith('/api/editorial/discard') && value.request().method() === 'POST')
  await selectedDetail.getByRole('button', { name: 'Discard', exact: true }).click()
  expect((await discard).status()).toBe(200)
  await expect(session.page.getByRole('status')).toContainText('Change set updated.')

  const wholeRow = await currentRelease(session.page)
  const wholeScope = wholeRow.getByLabel('Rollback scope')
  await wholeScope.selectOption('release')
  await expect(wholeScope).toHaveValue('release')
  await prepareRollback(session.page, wholeRow)
  await expect(session.page.getByRole('status')).toContainText('Rollback release #56 is ready for editorial review.')
  await session.page.getByRole('link', { name: 'Open editorial review' }).click()
  const wholeDetail = session.page.getByRole('region', { name: 'Change set detail', exact: true })
  await expect(wholeDetail).toContainText('Rollback release #56')
  const wholeChanges = wholeDetail.getByRole('region', { name: 'Captured changes', exact: true })
  await expect(wholeChanges).toContainText('A current published summary that the reviewed rollback browser flow restores.')
  await expect(wholeChanges.locator('article')).toHaveCount(1)
  await expect(wholeDetail.getByRole('button', { name: 'Submit for review', exact: true })).toBeVisible()
  const discardWhole = session.page.waitForResponse((value) => value.url().endsWith('/api/editorial/discard') && value.request().method() === 'POST')
  await wholeDetail.getByRole('button', { name: 'Discard', exact: true }).click()
  expect((await discardWhole).status()).toBe(200)
  await session.context.close()
})

test('ENG-010 allows an Approver to inspect Operations and prepare a selected rollback without Owner retention access', async ({ browser }) => {
  const session = await approver(browser)
  try {
    await session.page.goto('/editorial')
    await session.page.getByRole('link', { name: 'Operations', exact: true }).click()
    await expect(session.page).toHaveURL(/\/operations/)
    await expect(session.page.getByRole('heading', { name: /Operations|Change log/i })).toBeVisible()
    await expect(session.page.getByText(/Retention/i)).toHaveCount(0)
    const row = await currentRelease(session.page)
    await row.getByRole('link', { name: 'Open build log', exact: true }).click()
    await expect(session.page.getByRole('region', { name: 'Build log' })).toBeVisible()
    await session.page.goBack()
    const selected = await currentRelease(session.page)
    await selected.getByLabel('Rollback scope').selectOption({ index: 1 })
    await prepareRollback(session.page, selected)
    await expect(session.page.getByRole('status')).toContainText('Rollback change from release #56 is ready for editorial review.')
    await session.page.getByRole('link', { name: 'Open editorial review' }).click()
    const detail = session.page.getByRole('region', { name: 'Change set detail', exact: true })
    const discarded = session.page.waitForResponse((value) => value.url().endsWith('/api/editorial/discard') && value.request().method() === 'POST')
    await detail.getByRole('button', { name: 'Discard', exact: true }).click()
    expect((await discarded).status()).toBe(200)
  } finally { await session.context.close() }
})

test('ENG-022 Change log remains readable and accessible at desktop and mobile sizes', async ({ browser }) => {
  const session = await owner(browser)
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await session.page.setViewportSize(size)
    await session.page.goto('/operations?period=all')
    expect(await session.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await expect(session.page.locator('[data-change-log-filters]')).toBeVisible()
    await session.page.addScriptTag({ path: axeSource })
    expect(await session.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
    await session.page.screenshot({ path: `test-results/change-log-${process.env.CMS_PRIVATE_BRAND === '1' ? 'private' : 'neutral'}-${size.width}.png`, fullPage: true })
  }
  await session.context.close()
})
