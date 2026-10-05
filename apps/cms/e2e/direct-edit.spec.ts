import { expect, test, type Browser, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

const origin = `https://127.0.0.1:${Number(process.env.CMS_E2E_PORT ?? 4300)}`
async function signedIn(browser: Browser, token: string) {
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  await context.addCookies(['site_engine_session', '__Host-site_engine_session'].map((name) => ({ name, value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' as const })))
  return { context, page: await context.newPage() }
}

async function renderQueuedPreview(page: Page, action: () => Promise<void>) {
  const queued = page.waitForResponse((response) => response.url().endsWith('/api/editorial/direct-edit/preview') && response.request().method() === 'POST' && response.status() === 200)
  await action()
  await queued
  const worker = await page.request.post('/__e2e/direct-preview-worker')
  expect(worker.status(), await worker.text()).toBe(200)
  await expect(page.getByRole('status')).toContainText('Saved draft preview is ready.', { timeout: 120_000 })
}

test('ENG-026 types in the actual rendered Hero and keeps the public release immutable', async ({ browser }) => {
  test.setTimeout(150_000)
  const editor = await signedIn(browser, 'synthetic-application-editor-session-token')
  const before = await editor.page.request.get('/__e2e/publish-state').then(response => response.json()) as { releaseCount: number }
  await editor.page.goto('/direct-edit')
  await expect(editor.page.getByRole('heading', { name: 'On-page text editor' })).toBeVisible()
  await editor.page.locator('main').getByLabel('Page').selectOption({ label: 'Direct edit browser page' })
  await editor.page.locator('main').getByLabel('Change set').selectOption({ label: 'Browser Editor draft (open)' })
  await editor.page.setViewportSize({ width: 1440, height: 900 })

  await renderQueuedPreview(editor.page, () => editor.page.getByRole('button', { name: 'Prepare saved preview' }).click())
  await editor.page.getByRole('button', { name: 'Enter Edit mode' }).click()
  const frame = editor.page.frameLocator('iframe[title="Editable saved draft preview"]')
  await expect(frame.locator('[data-block-id]').first()).toHaveAttribute('data-block-id', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')
  await expect(frame.getByRole('navigation').locator('[data-direct-edit-field]')).toHaveCount(0)
  const heading = frame.getByRole('heading', { name: 'Browser original heading' })
  await heading.click()
  await expect(heading).toHaveAttribute('contenteditable', 'plaintext-only')
  await heading.fill('x'.repeat(121))
  await expect(editor.page.getByLabel('Direct edit checks').getByText('121 of 120 characters')).toBeVisible()
  await expect(editor.page.getByRole('button', { name: 'Save rendered text' })).toBeDisabled()
  await heading.press('Escape')
  await expect(heading).toHaveText('Browser original heading')

  await heading.click()
  await heading.evaluate((node) => {
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', 'Browser <b>saved</b> heading')
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
  })
  await expect(heading).toHaveText('Browser <b>saved</b> heading')
  await expect(heading.locator('b')).toHaveCount(0)
  await expect(editor.page.getByText('You have unsaved rendered text.')).toBeVisible()
  let warned = false
  editor.page.once('dialog', async (dialog) => { warned = true; await dialog.dismiss() })
  await editor.page.reload({ timeout: 3_000 }).catch(() => undefined)
  expect(warned).toBe(true)
  await expect(editor.page.getByText('You have unsaved rendered text.')).toBeVisible()

  let headingRequest: Record<string, unknown> | undefined
  editor.page.on('request', (request) => {
    if (request.url().endsWith('/api/editorial/direct-edit') && request.method() === 'POST') headingRequest = request.postDataJSON() as Record<string, unknown>
  })
  await renderQueuedPreview(editor.page, () => editor.page.getByRole('button', { name: 'Save rendered text' }).click())
  const savedFrame = editor.page.frameLocator('iframe[title="Editable saved draft preview"]')
  await expect(savedFrame.getByRole('heading', { name: 'Browser <b>saved</b> heading' })).toBeVisible()
  await expect(savedFrame.locator('h1 b')).toHaveCount(0)
  const stale = await editor.page.request.post('/api/editorial/direct-edit', { headers: { origin, 'content-type': 'application/json' }, data: { ...headingRequest, value: 'Stale competing heading' } })
  expect(stale.status(), await stale.text()).toBe(409)

  await editor.page.getByRole('button', { name: 'Enter Edit mode' }).click()
  const body = savedFrame.getByText('Browser original body.', { exact: true })
  await body.click()
  await body.fill('Browser saved body typed in the rendered page.')
  await renderQueuedPreview(editor.page, () => editor.page.getByRole('button', { name: 'Save rendered text' }).click())
  const finalFrame = editor.page.frameLocator('iframe[title="Editable saved draft preview"]')
  await expect(finalFrame.getByText('Browser saved body typed in the rendered page.', { exact: true })).toBeVisible()

  await editor.page.route('**/api/editorial/direct-edit/preview', (route) => route.abort())
  await editor.page.getByRole('button', { name: 'Prepare saved preview' }).click()
  await expect(editor.page.getByRole('status')).toContainText('Preview provider is unavailable.')
  await expect(editor.page.getByRole('button', { name: 'Enter Edit mode' })).toBeDisabled()
  await editor.page.unroute('**/api/editorial/direct-edit/preview')
  await renderQueuedPreview(editor.page, () => editor.page.getByRole('button', { name: 'Prepare saved preview' }).click())

  await editor.page.addScriptTag({ path: axeSource })
  expect(await editor.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])
  await editor.page.screenshot({ path: 'artifacts/direct-edit-1440.png', fullPage: true })
  await editor.page.setViewportSize({ width: 390, height: 844 })
  await editor.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(await editor.page.locator('main').evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth)).toBe(true)
  expect(await editor.page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])
  await editor.page.screenshot({ path: 'artifacts/direct-edit-390.png', fullPage: true })
  const previewURL = await editor.page.locator('iframe').getAttribute('src')
  expect(previewURL).toMatch(/^\/preview\/changes\/[0-9a-f-]+\/proposed\/direct-edit-browser\/direct-edit-browser-page$/)
  const ownedPreview = await editor.page.request.get(previewURL!)
  expect(ownedPreview.status()).toBe(200)
  expect(await ownedPreview.text()).toContain('Browser &lt;b&gt;saved&lt;/b&gt; heading')
  await editor.page.getByRole('button', { name: 'Submit for review' }).click()
  await expect(editor.page.getByRole('status')).toContainText('Submitted for review.')
  expect((await editor.page.request.get('/__e2e/publish-state').then(response => response.json()) as { releaseCount: number }).releaseCount).toBe(before.releaseCount)
  const other = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  expect((await other.request.get(previewURL!)).status()).toBe(401)
  expect((await editor.page.request.get(previewURL!)).status()).toBe(403)
  await other.close(); await editor.context.close()
})
