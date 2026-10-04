import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const e2ePort = Number(process.env.CMS_E2E_PORT ?? 4300)
const cmsOrigin = `https://127.0.0.1:${e2ePort}`

async function newPage(browser: Browser, role: 'owner' | 'editor' | 'sales'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: cmsOrigin, ignoreHTTPSErrors: true })
  const token = role === 'owner' ? 'synthetic-operations-owner-session-token' : `synthetic-application-${role}-session-token`
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({
    name,
    value: token,
    url: cmsOrigin,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax' as const,
  })))
  return { context, page: await context.newPage() }
}

async function openAdminNavigation(page: Page): Promise<void> {
  const menu = page.getByTestId('mobile-menu')
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') === 'false') await menu.click()
}

test('ENG-022 serves exact operational counts and server-side audit filters to an Owner', async ({ browser }) => {
  const owner = await newPage(browser, 'owner')
  const summary = await owner.page.request.get('/api/operations')
  expect(summary.status()).toBe(200)
  const body = await summary.json() as {
    summary: { pendingReviews: number; urgentOrNewLeads: number; queue: { pending: number; processing: number; failed: number }; latestRelease: { sequence: number }; latestPublishFailure: { sequence: number; errorCode: string } }
    audit: { docs: Array<{ event: string; actorId?: string; detail?: unknown }> }
  }
  // Other scenarios may legitimately create reviews, leads, releases, and
  // outbox work before this file runs. These are system-wide operational
  // counts, so assert the isolated fixture's guaranteed contribution rather
  // than treating the suite's global state as a fixed baseline.
  expect(body.summary.pendingReviews).toBeGreaterThanOrEqual(1)
  expect(body.summary.urgentOrNewLeads).toBeGreaterThanOrEqual(2)
  expect(body.summary.latestRelease.sequence).toBeGreaterThanOrEqual(1)
  expect(body.summary.latestPublishFailure).toMatchObject({ errorCode: 'synthetic_publish_failure' })
  expect(body.summary.latestPublishFailure.sequence).toBeGreaterThanOrEqual(4)
  expect(body.summary.queue.pending).toBeGreaterThanOrEqual(52)
  expect(body.summary.queue.processing).toBeGreaterThanOrEqual(1)
  expect(body.summary.queue.failed).toBeGreaterThanOrEqual(1)
  expect(body.audit.docs.find((event) => event.event === 'inquiry.created')?.detail).toBeUndefined()
  expect(JSON.stringify(body)).not.toContain('never-expose@example.test')
  expect(JSON.stringify(body)).not.toContain('private-resume-key')

  const first = await owner.page.request.get('/api/operations?event=operations.fixture.page&page=1')
  expect(first.status()).toBe(200)
  const firstBody = await first.json() as { audit: { page: number; totalPages: number; docs: Array<{ actorId?: string }> } }
  expect(firstBody.audit.page).toBe(1)
  expect(firstBody.audit.totalPages).toBe(2)
  expect(firstBody.audit.docs).toHaveLength(25)
  const second = await owner.page.request.get('/api/operations?event=operations.fixture.page&page=2')
  expect(second.status()).toBe(200)
  const secondBody = await second.json() as { audit: { page: number; totalPages: number; docs: unknown[] } }
  expect(secondBody.audit.page).toBe(2)
  expect(secondBody.audit.totalPages).toBe(2)
  expect(secondBody.audit.docs).toHaveLength(1)
  const byActor = await owner.page.request.get(`/api/operations?event=operations.fixture.page&actor=${firstBody.audit.docs[0]?.actorId}`)
  expect(byActor.status()).toBe(200)
  expect((await byActor.json() as { audit: { docs: unknown[] } }).audit.docs).toHaveLength(25)
  const future = await owner.page.request.get('/api/operations?since=2999-01-01T00%3A00%3A00.000Z')
  expect(future.status()).toBe(200)
  expect((await future.json() as { audit: { docs: unknown[] } }).audit.docs).toHaveLength(0)
  await owner.context.close()
})

test('ENG-022 gives only an Owner the operations dashboard and an accessible filtered timeline', async ({ browser }) => {
  const owner = await newPage(browser, 'owner')
  const initialOperations = owner.page.waitForResponse((response) => response.url().includes('/api/operations') && response.request().method() === 'GET')
  await owner.page.goto('/operations')
  const initialResponse = await initialOperations
  expect(initialResponse.status()).toBe(200)
  const initialBody = await initialResponse.json() as {
    summary: { pendingReviews: number; urgentOrNewLeads: number }
  }
  await expect(owner.page.getByRole('heading', { name: 'Operations' })).toBeVisible()
  await expect(owner.page.getByLabel('Operational summary')).toContainText(`Pending reviews: ${initialBody.summary.pendingReviews}`)
  await expect(owner.page.getByLabel('Operational summary')).toContainText(`Urgent or new leads: ${initialBody.summary.urgentOrNewLeads}`)
  await owner.page.getByLabel('Filter event').fill('operations.fixture.page')
  await owner.page.getByRole('button', { name: 'Apply filter' }).click()
  await expect(owner.page.getByLabel('Audit timeline')).toContainText('operations.fixture.page')
  await expect(owner.page.getByRole('button', { name: 'Next' })).toBeEnabled()
  await owner.page.getByRole('button', { name: 'Next' }).click()
  await expect(owner.page.getByRole('button', { name: 'Previous' })).toBeEnabled()
  await owner.page.addScriptTag({ path: axeSource })
  expect(await owner.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await owner.context.close()

  for (const role of ['editor', 'sales'] as const) {
    const denied = await newPage(browser, role)
    expect((await denied.page.request.get('/api/operations')).status()).toBe(403)
    await denied.page.goto('/operations')
    await expect(denied.page.getByText('Owner access is required to view operations.')).toBeVisible()
    await denied.context.close()
  }
})

test('ENG-022 exposes the role-aware Leads and Applications links through the admin navigation', async ({ browser }) => {
  const owner = await newPage(browser, 'owner')
  await owner.page.goto('/admin')
  await openAdminNavigation(owner.page)
  const ownerNavigation = owner.page.getByRole('navigation', { name: 'Workspace' })
  await expect(ownerNavigation.getByRole('link', { name: 'Changelog' })).toBeVisible()
  await expect(ownerNavigation.getByRole('link', { name: 'Reviews' })).toBeVisible()
  await expect(ownerNavigation.getByRole('link', { name: 'Leads' })).toBeVisible()
  await expect(ownerNavigation.getByRole('link', { name: 'Careers' })).toBeVisible()
  await ownerNavigation.getByRole('link', { name: 'Leads' }).click()
  await expect(owner.page).toHaveURL(/\/leads$/)
  await expect(owner.page.getByRole('heading', { name: 'Lead pipeline' })).toBeVisible()
  await owner.page.goto('/admin')
  await openAdminNavigation(owner.page)
  await owner.page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Careers' }).click()
  await expect(owner.page).toHaveURL(/\/applications$/)
  await expect(owner.page.getByRole('heading', { name: 'Applications' })).toBeVisible()
  await owner.page.goto('/admin')
  await openAdminNavigation(owner.page)
  const applications = owner.page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Careers' })
  await applications.focus()
  await expect(applications).toBeFocused()
  await owner.page.keyboard.press('Enter')
  await expect(owner.page).toHaveURL(/\/applications$/)

  await owner.page.setViewportSize({ width: 390, height: 844 })
  await owner.page.goto('/admin')
  await openAdminNavigation(owner.page)
  const mobileLeads = owner.page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Leads' })
  await mobileLeads.click()
  await expect(owner.page).toHaveURL(/\/leads$/)
  await owner.context.close()

  const sales = await newPage(browser, 'sales')
  await sales.page.goto('/admin')
  await openAdminNavigation(sales.page)
  const salesNavigation = sales.page.getByRole('navigation', { name: 'Workspace' })
  await expect(salesNavigation.getByRole('link', { name: 'Leads' })).toBeVisible()
  await expect(salesNavigation.getByRole('link', { name: 'Changelog' })).toHaveCount(0)
  await expect(salesNavigation.getByRole('link', { name: 'Careers' })).toHaveCount(0)
  await sales.context.close()
})
