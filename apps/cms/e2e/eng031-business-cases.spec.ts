import { expect, test, type Browser } from '@playwright/test'
import { createRequire } from 'node:module'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

async function ownerContext(browser: Browser, token: string) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

function localDateTime(value: Date): string {
  const part = (number: number) => String(number).padStart(2, '0')
  return `${value.getFullYear()}-${part(value.getMonth() + 1)}-${part(value.getDate())}T${part(value.getHours())}:${part(value.getMinutes())}`
}

test('ENG-031 schedules an approved business case and keeps an invalidated approval private with a staff reason', async ({ browser }) => {
  test.setTimeout(120_000)
  const reviewer = await ownerContext(browser, 'synthetic-eng031-reviewer-session-token')
  const observer = await ownerContext(browser, 'synthetic-on-page-reviewer-session-token')
  const editor = await ownerContext(browser, 'synthetic-on-page-editor-session-token')
  let changeSetID: string | undefined
  try {
    const seeded = await reviewer.page.request.post('/__e2e/eng031-business-case')
    expect(seeded.status(), await seeded.text()).toBe(200)
    const businessCase = await seeded.json() as { id: string; listingPath: string; articlePath: string }
    changeSetID = businessCase.id

    await reviewer.page.goto(`/editorial?changeSet=${businessCase.id}`)
    await expect(reviewer.page.getByText('Scheduled business-case review', { exact: true })).toBeVisible()
    const proposed = reviewer.page.frameLocator('iframe[title="Proposed comparison"]')
    const proposedMain = proposed.locator('main')
    await expect(proposedMain.getByRole('heading', { name: 'Insights', exact: true })).toBeVisible()
    const caseLink = proposedMain.getByRole('link', { name: 'Scheduled case study', exact: true })
    await expect(caseLink).toHaveCount(1)
    await expect(proposedMain.getByText('Case study', { exact: true })).toHaveCount(1)
    await caseLink.click()
    await expect(proposed.getByRole('heading', { name: 'Scheduled case study', exact: true })).toBeVisible()
    await expect(proposed.getByRole('region', { name: 'Case study details', exact: true })).toContainText('Synthetic services')
    const scheduledFor = localDateTime(new Date(Date.now() + 5 * 60_000))
    await reviewer.page.locator('input[type="datetime-local"]').fill(scheduledFor)
    await reviewer.page.getByRole('button', { name: 'Approve and schedule publish', exact: true }).click()
    await expect(reviewer.page.getByRole('status')).toContainText('Approved immutable snapshot scheduled for UTC dispatch.')
    await expect(reviewer.page.getByLabel('Scheduled publications')).toContainText('Scheduled')

    const deniedSchedules = await editor.page.request.get('/api/editorial/schedules/list')
    expect(deniedSchedules.status()).toBe(403)

    const disabled = await reviewer.page.request.post('/__e2e/eng031-business-case/disable-approver')
    expect(disabled.status(), await disabled.text()).toBe(204)
    const dispatched = await reviewer.page.request.post('/__e2e/eng031-business-case/dispatch')
    expect(dispatched.status(), await dispatched.text()).toBe(200)
    expect(await dispatched.json()).toMatchObject({ enqueued: 0, skipped: 1 })

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await observer.page.setViewportSize(viewport)
      await observer.page.goto('/editorial')
      const schedules = observer.page.getByLabel('Scheduled publications')
      await expect(schedules).toContainText('Needs review')
      await expect(schedules.getByText('approving reviewer no longer has authorization')).toBeVisible()
      await schedules.getByText('Technical details', { exact: true }).click()
      await expect(schedules).toContainText('Dispatch status: APPROVAL_AUTHORITY_REVOKED')
      expect(await observer.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      await observer.page.addScriptTag({ path: axeSource })
      expect(await observer.page.evaluate(async () => (await (window as any).axe.run('main')).violations)).toEqual([])
    }
  } finally {
    if (changeSetID) {
      const cleanup = await observer.page.request.post(`/__e2e/eng031-business-case/cleanup?changeSet=${changeSetID}`)
      expect(cleanup.status(), await cleanup.text()).toBe(200)
    }
    await Promise.all([reviewer.context.close(), observer.context.close(), editor.context.close()])
  }
})
