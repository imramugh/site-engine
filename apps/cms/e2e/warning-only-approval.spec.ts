import { expect, test } from '@playwright/test'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`

test('a warning-only readiness report remains visible and approval queues publication', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: 'synthetic-on-page-reviewer-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  const seeded = await page.request.post('/__e2e/warning-only-review')
  expect(seeded.ok(), await seeded.text()).toBeTruthy()
  const { id } = await seeded.json() as { id: string }
  const detail = await page.request.get(`/api/editorial/review/${id}`)
  expect(detail.ok(), await detail.text()).toBeTruthy()
  const { review } = await detail.json()
  const report = review.quality.proof.report
  expect(report.publishable).toBe(true)
  expect(report.blockers).toEqual([])
  expect(report.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'STYLE_BANNED_PHRASE', message: expect.stringContaining('forbidden synthetic phrase') })]))
  await page.goto(`/review/${id}`)
  // Other published fixture pages can contribute advisory findings. Verify the
  // complete stored report is displayed without making its total depend on
  // which unrelated browser journeys have published earlier in this suite.
  await expect(page.getByText(`${report.warnings.length} advisory warning${report.warnings.length === 1 ? '' : 's'}`, { exact: true })).toBeVisible()
  await expect(page.locator('details').filter({ hasText: 'Content uses banned phrase' })).toContainText('forbidden synthetic phrase')
  const approve = page.getByRole('button', { name: 'Approve and queue publish' })
  await expect(approve).toBeEnabled()
  await approve.click()
  await expect(page.getByRole('status')).toContainText('queued')
  await context.close()
})
