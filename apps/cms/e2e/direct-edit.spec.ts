import { expect, test, type Browser } from '@playwright/test'

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
async function signedIn(browser: Browser, token: string) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

test('ENG-026 Editor saves a Hero draft, completes a scoped preview, and submits without changing public release', async ({ browser }) => {
  const editor = await signedIn(browser, 'synthetic-application-editor-session-token')
  const before = await editor.page.request.get('/__e2e/publish-state').then(response => response.json()) as { releaseCount: number }
  await editor.page.goto('/direct-edit')
  await expect(editor.page.getByRole('heading', { name: 'Hero draft editor' })).toBeVisible()
  await editor.page.getByLabel('Heading').fill('Browser saved heading')
  await editor.page.getByRole('button', { name: 'Save heading' }).click()
  await expect(editor.page.getByRole('status')).toContainText('Draft saved.')
  await editor.page.getByRole('button', { name: 'Prepare draft preview' }).click()
  await expect(editor.page.getByRole('status')).toContainText('Preparing preview…')
  expect((await editor.page.request.post('/__e2e/direct-preview-worker')).status()).toBe(200)
  const frame = editor.page.frameLocator('iframe[title="Proposed draft preview"]')
  await expect(frame.getByText('Browser saved heading')).toBeVisible()
  await editor.page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(editor.page.getByRole('status')).toContainText('Submitted for review.')
  const after = await editor.page.request.get('/__e2e/publish-state').then(response => response.json()) as { releaseCount: number }
  expect(after.releaseCount).toBe(before.releaseCount)
  const other = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  const protectedPreview = await other.request.get((await editor.page.locator('iframe').getAttribute('src'))!)
  expect(protectedPreview.status()).toBe(401)
  await other.close(); await editor.context.close()
})
