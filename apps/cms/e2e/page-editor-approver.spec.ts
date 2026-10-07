import { expect, test, type Browser } from '@playwright/test'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const pageID = 'abababab-abab-4bab-8bab-ababababab01'

async function signedIn(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({
    name,
    value: 'synthetic-page-editor-approver-session-token',
    url: origin,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax' as const,
  })))
  return { context, page: await context.newPage() }
}

test('ENG-006 lets an Approver save, render, and submit an owned page draft without publishing', async ({ browser }) => {
  test.setTimeout(120_000)
  const approver = await signedIn(browser)
  const before = await approver.page.request.get('/__e2e/publish-state').then((response) => response.json()) as { releaseCount: number }

  await approver.page.goto('/content-tree?q=Approver%20page%20editor%20target')
  await expect(approver.page.getByRole('link', { name: '+ New page', exact: true })).toHaveCount(0)
  await expect(approver.page.locator('[data-admin-nav-item][href="/block-gallery"]')).toHaveCount(0)
  await expect(approver.page.locator('[data-admin-nav-item][href="/media"]')).toHaveCount(0)
  await approver.page.getByRole('link', { name: /Approver page editor target/ }).click()
  await expect(approver.page).toHaveURL(`/content-editor/${pageID}`)

  await approver.page.getByText('Page fields', { exact: false }).first().click()
  await approver.page.getByLabel('Title', { exact: true }).fill('Approver saved page title')
  const hero = approver.page.locator('[data-page-editor-block]').first()
  await hero.locator('summary').click()
  await hero.getByRole('textbox', { name: 'Body', exact: true }).fill('Approver saved body rendered by Astro.')
  await expect(approver.page.getByRole('button', { name: 'Submit for review' })).toBeDisabled()

  const queued = approver.page.waitForResponse((response) => response.url().endsWith('/api/editorial/direct-edit/preview') && response.request().method() === 'POST' && response.status() === 200)
  await approver.page.getByRole('button', { name: 'Check draft' }).click()
  await expect(approver.page.getByRole('status')).toContainText('Draft checks are ready')
  await approver.page.getByRole('button', { name: 'Save draft' }).click()
  await queued
  const worker = await approver.page.request.post('/__e2e/direct-preview-worker')
  expect(worker.status(), await worker.text()).toBe(200)
  await expect(approver.page.getByRole('status')).toContainText('Saved draft preview is ready.', { timeout: 120_000 })

  const preview = approver.page.frameLocator('iframe[title="Saved page draft preview"]')
  await expect(preview.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Approver saved page title', exact: true })).toBeVisible()
  await expect(preview.getByText('Approver saved body rendered by Astro.')).toBeVisible()
  const previewURL = await approver.page.getByTitle('Saved page draft preview').getAttribute('src')
  expect(previewURL).toMatch(/^\/preview\/changes\/[0-9a-f-]+\/proposed\/direct-edit-browser\/approver-page-editor$/)

  await approver.page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(approver.page.getByRole('status')).toContainText('Submitted for review.')
  const after = await approver.page.request.get('/__e2e/publish-state').then((response) => response.json()) as { releaseCount: number }
  expect(after.releaseCount).toBe(before.releaseCount)
  expect((await approver.page.request.get(previewURL!)).status()).toBe(403)
  await approver.context.close()
})
