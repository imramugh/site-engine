import { expect, test, type Browser, type Page } from '@playwright/test'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const tokens = { owner: 'synthetic-lead-owner-session-token', editor: 'synthetic-lead-editor-session-token' }

async function signedIn(browser: Browser, role: keyof typeof tokens) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: tokens[role], url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function axe(page: Page) {
  await page.addScriptTag({ url: '/__e2e/axe.js' })
  return page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)
}

test('ENG-019 owner uses the real pipeline, manual intake, controlled detail form, filters, and CSV', async ({ browser }, testInfo) => {
  const owner = await signedIn(browser, 'owner')
  await owner.page.goto('/leads')
  await expect(owner.page.getByRole('heading', { name: 'Lead pipeline', level: 1 })).toBeAttached()
  await expect(owner.page.getByRole('button', { name: 'Pipeline' })).toHaveAttribute('aria-pressed', 'true')
  const proposal = owner.page.getByRole('region', { name: 'Proposal' })
  await expect(proposal.locator('header')).toContainText('51')
  await expect(proposal).toContainText('Showing 6 of 51')
  await owner.page.screenshot({ path: testInfo.outputPath('leads-pipeline-desktop.png'), fullPage: true })
  await expect(owner.page.locator('[data-lead-card][data-urgent="true"]').first()).toContainText('Active incident')

  await owner.page.getByRole('button', { name: '+ Add lead' }).click()
  const dialog = owner.page.getByRole('dialog', { name: 'Add lead' })
  await dialog.getByLabel('Email').fill('manual-lead@example.test')
  await dialog.getByLabel('Name').fill('Manual Lead')
  await dialog.getByLabel('Message').fill('Staff-recorded lead details are shown as plain text.')
  await dialog.getByLabel(/I recorded the contact/).check()
  await dialog.getByRole('button', { name: 'Create manual lead' }).click()
  await expect(owner.page.getByRole('status')).toContainText('staff-recorded consent')
  await expect(dialog).toHaveCount(0)

  await owner.page.getByRole('button', { name: /First editable lead/ }).click()
  const detail = owner.page.getByRole('complementary', { name: 'Lead details' })
  await expect(detail.getByLabel('Notes')).toHaveValue('First lead notes')
  await expect(detail).toContainText('<img src=x onerror=alert(1)> remains visible text.')
  await expect(detail.locator('img')).toHaveCount(0)
  await detail.getByLabel('Notes').fill('Unsaved text that must not cross records')
  await owner.page.getByRole('button', { name: /Second editable lead/ }).click()
  await expect(detail.getByLabel('Notes')).toHaveValue('Second lead notes')
  await detail.getByLabel('Stage').selectOption('proposal')
  await detail.getByLabel('Active assignee').selectOption({ label: 'Synthetic Lead Owner' })
  await detail.getByLabel('Notes').fill('Called the contact.')
  await detail.getByLabel('Next action').fill('Send a scoped proposal.')
  await detail.getByRole('button', { name: 'Save lead details' }).click()
  await expect(owner.page.getByRole('status')).toContainText('Lead details saved')
  await expect(owner.page.getByRole('region', { name: 'Proposal' }).locator('header')).toContainText('52')

  await owner.page.getByRole('button', { name: 'List' }).click()
  await owner.page.getByLabel('Lead filters').getByLabel('Stage').selectOption('proposal')
  await owner.page.getByRole('button', { name: 'Next' }).click()
  await expect(owner.page.getByRole('button', { name: /Second editable lead/ })).toBeVisible()
  const href = await owner.page.getByRole('link', { name: 'Export CSV' }).getAttribute('href')
  const csv = await owner.page.request.get(href ?? '')
  expect(csv.ok()).toBeTruthy()
  expect(csv.headers()['cache-control']).toBe('no-store')
  expect(await csv.text()).toContain('notes-b.synthetic@example.test')

  const list = await owner.page.request.get('/api/leads?stage=proposal&page=1')
  expect(list.headers()['cache-control']).toBe('no-store')
  const body = await list.json()
  expect(body.pipeline.proposal.totalDocs).toBeGreaterThanOrEqual(52)
  expect(body.pipeline.proposal.leads).toHaveLength(6)
  expect(body.leads.every((lead: { stage: string }) => lead.stage === 'proposal')).toBeTruthy()
  expect(body.leads[0]).not.toHaveProperty('idempotencyKey')
  const invalid = await owner.page.request.patch(`/api/leads/${body.leads[0].id}`, { headers: { origin }, data: { stage: 'new' } })
  expect(invalid.status()).toBe(422)
  expect(invalid.headers()['cache-control']).toBe('no-store')

  expect(await axe(owner.page)).toEqual([])
  await owner.page.screenshot({ path: testInfo.outputPath('leads-list-desktop.png'), fullPage: true })
  await owner.context.close()
})

test('ENG-019 remains keyboard-readable at 390px and recovers from a load error', async ({ browser }, testInfo) => {
  const owner = await signedIn(browser, 'owner')
  await owner.page.setViewportSize({ width: 390, height: 844 })
  let failed = false
  await owner.page.route('**/api/leads?*', async (route) => {
    if (!failed) { failed = true; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic temporary failure.' }) }) }
    else await route.continue()
  })
  await owner.page.goto('/leads')
  await expect(owner.page.locator('[data-leads-workspace] [role="alert"]')).toContainText('Synthetic temporary failure')
  await owner.page.unroute('**/api/leads?*')
  await owner.page.getByRole('button', { name: 'Try again' }).click()
  await expect(owner.page.getByRole('region', { name: 'New' })).toBeVisible()
  await owner.page.getByRole('button', { name: /new-lead.synthetic@example.test/ }).focus()
  await owner.page.keyboard.press('Enter')
  await expect(owner.page.getByRole('complementary', { name: 'Lead details' })).toBeVisible()
  expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  expect(await axe(owner.page)).toEqual([])
  await owner.page.screenshot({ path: testInfo.outputPath('leads-pipeline-390.png'), fullPage: true })
  await owner.context.close()
})

test('ENG-019 denies anonymous and non-sales staff without exposing lead data', async ({ browser, request }) => {
  const anonymous = await request.get(`${origin}/api/leads`)
  expect(anonymous.status()).toBe(401)
  expect(anonymous.headers()['cache-control']).toBe('no-store')
  expect(await anonymous.text()).not.toContain('synthetic@example.test')
  const editor = await signedIn(browser, 'editor')
  const denied = await editor.page.request.get('/api/leads')
  expect(denied.status()).toBe(401)
  expect(denied.headers()['cache-control']).toBe('no-store')
  await editor.page.goto('/leads')
  await expect(editor.page).toHaveURL(/\/admin\/login/)
  await editor.context.close()
})
