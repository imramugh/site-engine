import { expect, type Browser } from '@playwright/test'

export const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
export async function reviewer(browser: Browser) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map(name => ({ name, value: 'synthetic-on-page-reviewer-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}
export async function readyAndApprove(page: Awaited<ReturnType<typeof reviewer>>['page']) {
  const seeded = await page.request.post('/__e2e/warning-only-review'); if (!seeded.ok()) throw new Error(await seeded.text())
  const { id } = await seeded.json() as { id: string }
  await page.goto(`/review/${id}`); await page.getByRole('button', { name: 'Approve and queue publish' }).click()
  await expect(page.getByRole('status')).toContainText('immutable snapshot is queued for publication')
  return id
}
