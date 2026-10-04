import { expect, test, type Browser } from '@playwright/test'
import { createRequire } from 'node:module'
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

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
  await editor.page.locator('main').getByLabel('Page').selectOption({ label: 'Direct edit browser page' })
  await editor.page.locator('main').getByLabel('Change set').selectOption({ label: 'Browser Editor draft (open)' })
  await editor.page.setViewportSize({ width: 1440, height: 900 })
  await editor.page.getByLabel('Heading').fill('Browser saved heading')
  await editor.page.getByLabel('Body').fill('Browser saved body after heading save.')
  await editor.page.getByRole('button', { name: 'Save heading' }).click()
  await expect(editor.page.getByRole('status')).toContainText('Draft saved.')
  await expect(editor.page.getByLabel('Body')).toHaveValue('Browser saved body after heading save.')
  await expect(editor.page.getByText('You have unsaved Hero changes.')).toBeVisible()
  await expect(editor.page.getByRole('button', { name: 'Submit for review' })).toBeDisabled()
  await editor.page.getByRole('button', { name: 'Save body' }).click()
  await expect(editor.page.getByRole('status')).toContainText('Draft saved.')
  await expect(editor.page.getByText('You have unsaved Hero changes.')).toBeHidden()
  await expect(editor.page.getByRole('button', { name: 'Submit for review' })).toBeEnabled()
  const queued = editor.page.waitForResponse((response) => response.url().endsWith('/api/editorial/direct-edit/preview') && response.request().method() === 'POST' && response.status() === 200)
  await editor.page.getByRole('button', { name: 'Prepare preview' }).click()
  await queued
  await expect(editor.page.getByRole('status')).toContainText('Preparing preview…')
  const worker = await editor.page.request.post('/__e2e/direct-preview-worker'); expect(worker.status(), await worker.text()).toBe(200)
  const frame = editor.page.frameLocator('iframe[title="Proposed draft preview"]')
  await expect(frame.getByText('Browser saved heading')).toBeVisible()
  await expect(frame.getByText('Browser saved body after heading save.')).toBeVisible()
  await editor.page.addScriptTag({ path: axeSource })
  expect(await editor.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])
  await editor.page.screenshot({ path: 'artifacts/direct-edit-1440.png', fullPage: true })
  await editor.page.setViewportSize({ width: 390, height: 844 })
  expect(await editor.page.locator('main').evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth)).toBe(true)
  expect(await editor.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])
  await editor.page.screenshot({ path: 'artifacts/direct-edit-390.png', fullPage: true })
  const previewURL = await editor.page.locator('iframe').getAttribute('src')
  expect(previewURL).toMatch(/^\/preview\/changes\/[0-9a-f-]+\/proposed\/direct-edit-browser\/direct-edit-browser-page$/)
  const ownedPreview = await editor.page.request.get(previewURL!)
  expect(ownedPreview.status()).toBe(200)
  expect(await ownedPreview.text()).toContain('Browser saved heading')
  await editor.page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(editor.page.getByRole('status')).toContainText('Submitted for review.')
  const after = await editor.page.request.get('/__e2e/publish-state').then(response => response.json()) as { releaseCount: number }
  expect(after.releaseCount).toBe(before.releaseCount)
  const other = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  const protectedPreview = await other.request.get(previewURL!)
  expect(protectedPreview.status()).toBe(401)
  const submittedPreview = await editor.page.request.get(previewURL!)
  expect(submittedPreview.status()).toBe(403)
  await other.close(); await editor.context.close()
})
