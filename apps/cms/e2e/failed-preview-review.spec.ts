import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

test('reviewer sees a failed structured-data preview diagnostic and cannot approve it', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: 'synthetic-on-page-reviewer-session-token', url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  const page = await context.newPage()
  const seeded = await page.request.post('/__e2e/failed-preview-review')
  if (!seeded.ok()) throw new Error(await seeded.text())
  const { id, status } = await seeded.json() as { id: string; status: string }
  expect(status).toBe('failed')
  await page.goto(`/review/${id}`)
  await expect(page.getByRole('alert').filter({ hasText: 'Generated structured data' })).toContainText('Generated structured data')
  await expect(page.getByText('STRUCTURED_DATA_INVALID · structuredData.12345678-1234-4234-8234-1234567890ab · 12345678-1234-4234-8234-1234567890ac')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Return to Reviews' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0)
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] } })).violations)).toEqual([])
  await context.close()
})
