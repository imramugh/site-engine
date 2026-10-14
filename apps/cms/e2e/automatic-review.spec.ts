import { expect, test, type Browser } from '@playwright/test'
import { randomUUID } from 'node:crypto'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const appearance = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' }

async function signedIn(browser: Browser, token: string) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

test('a submitted review prepares, checks, regenerates its exact selection, and can be rejected without changing the public release', async ({ browser }) => {
  test.setTimeout(240_000)
  const reviewer = await signedIn(browser, 'synthetic-on-page-reviewer-session-token')
  const anonymous = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  const marker = randomUUID().slice(0, 8)
  const headers = { origin, 'content-type': 'application/json' }
  const publicPath = '/on-page-review/review-target'

  try {
    const publicBefore = await anonymous.request.get(publicPath)
    expect(publicBefore.ok()).toBeTruthy()
    const publicBeforeHTML = await publicBefore.text()

    const created = await reviewer.page.request.post('/api/editorial/create', { headers, data: { name: `Automatic review ${marker}` } })
    expect(created.ok(), await created.text()).toBeTruthy()
    const set = await created.json() as { id: string }
    const changeHeaders = { ...headers, 'x-site-engine-change-set': set.id }
    const section = await reviewer.page.request.post('/api/sections', { headers: changeHeaders, data: { name: `Automatic review section ${marker}`, summary: 'Synthetic section for browser acceptance of automatic review preparation.', slug: `automatic-review-${marker}`, allowedTemplates: ['landing'] } })
    expect(section.status(), await section.text()).toBe(201)
    const sectionID = (await section.json() as { doc: { id: string } }).doc.id
    const primaryPage = await reviewer.page.request.post('/api/pages?draft=true', { headers: changeHeaders, data: { title: `Automatic review primary page ${marker}`, summary: 'Synthetic page used only by the automatic review browser acceptance test.', slug: 'primary-review-target', sectionId: sectionID, template: 'landing', blocks: [{ id: randomUUID(), type: 'hero', heading: `Automatic review heading ${marker}`, body: 'The protected comparison must render this proposed page before a reviewer can decide.', hidden: false, appearance }] } })
    expect(primaryPage.status(), await primaryPage.text()).toBe(201)
    const secondaryPage = await reviewer.page.request.post('/api/pages?draft=true', { headers: changeHeaders, data: { title: `Automatic review secondary page ${marker}`, summary: 'A second synthetic page makes a valid subset selection observable.', slug: 'secondary-review-target', sectionId: sectionID, template: 'landing', blocks: [{ id: randomUUID(), type: 'hero', heading: `Automatic review secondary heading ${marker}`, body: 'The reviewer may exclude this page while retaining the section and primary page.', hidden: false, appearance }] } })
    expect(secondaryPage.status(), await secondaryPage.text()).toBe(201)
    const submitted = await reviewer.page.request.post('/api/editorial/submit', { headers, data: { id: set.id } })
    expect(submitted.ok(), await submitted.text()).toBeTruthy()

    let prepareAttempts = 0
    await reviewer.page.route('**/api/editorial/prepare-preview', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      prepareAttempts += 1
      if (prepareAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic preparation transport failure.' }) })
      return route.continue()
    })
    await reviewer.page.goto(`/editorial?changeSet=${set.id}`)
    await expect(reviewer.page.locator(`[data-editorial-queue-item][data-change-set-id="${set.id}"]`)).toBeVisible()
    const retryComparison = reviewer.page.getByRole('button', { name: 'Retry comparison', exact: true })
    await expect(retryComparison).toBeEnabled({ timeout: 30_000 })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(prepareAttempts).toBe(1)

    await retryComparison.click()
    await expect.poll(() => prepareAttempts).toBe(2)
    await expect(reviewer.page.getByRole('button', { name: 'Prepare comparison', exact: true })).toHaveCount(0)
    await expect(reviewer.page.getByRole('button', { name: 'Run readiness checks', exact: true })).toHaveCount(0)

    let qualityAttempts = 0
    await reviewer.page.route('**/api/editorial/run-quality', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      qualityAttempts += 1
      if (qualityAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic readiness transport failure.' }) })
      return route.continue()
    })
    const rendered = await reviewer.page.request.post('/__e2e/direct-preview-worker')
    expect(rendered.ok(), await rendered.text()).toBeTruthy()
    await expect(reviewer.page.getByTitle('Live comparison', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(reviewer.page.getByTitle('Proposed comparison', { exact: true })).toBeVisible()
    const retryReadiness = reviewer.page.getByRole('button', { name: 'Retry readiness checks', exact: true })
    await expect(retryReadiness).toBeEnabled({ timeout: 30_000 })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(qualityAttempts).toBe(1)
    await retryReadiness.click()
    await expect.poll(() => qualityAttempts).toBe(2)

    const approve = reviewer.page.getByRole('button', { name: 'Approve and publish', exact: true })
    await expect(approve).toBeEnabled({ timeout: 30_000 })
    await expect(reviewer.page.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled()

    const secondaryChoice = reviewer.page.getByLabel(`Include Page Automatic review secondary page ${marker}`)
    await expect(secondaryChoice).toBeChecked()
    await secondaryChoice.uncheck()
    await expect(approve).toBeDisabled()
    await expect.poll(() => prepareAttempts).toBe(3)
    const rerendered = await reviewer.page.request.post('/__e2e/direct-preview-worker')
    expect(rerendered.ok(), await rerendered.text()).toBeTruthy()
    await expect(approve).toBeEnabled({ timeout: 30_000 })

    await secondaryChoice.check()
    await expect(approve).toBeDisabled()
    await expect.poll(() => prepareAttempts).toBe(4)
    const restored = await reviewer.page.request.post('/__e2e/direct-preview-worker')
    expect(restored.ok(), await restored.text()).toBeTruthy()
    await expect(approve).toBeEnabled({ timeout: 30_000 })

    await reviewer.page.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect(reviewer.page.locator('[data-editorial-detail] [data-editorial-state="rejected"]')).toBeVisible()
    const publicAfter = await anonymous.request.get(publicPath)
    expect(publicAfter.ok()).toBeTruthy()
    expect(await publicAfter.text()).toBe(publicBeforeHTML)
  } finally {
    await Promise.all([reviewer.context.close(), anonymous.close()])
  }
})
