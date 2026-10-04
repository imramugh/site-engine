import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js')

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/api/auth/google')
  await page.getByRole('button', { name: 'Sign in as Synthetic Editor' }).click()
  await page.waitForURL(/\/admin/)
}

test('ENG-014 accepts a real authenticated PNG multipart upload and refuses SVG or anonymous access', async ({ browser, page }) => {
  test.setTimeout(90_000)
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true })
  expect((await anonymous.request.post('/api/assets')).status()).toBeGreaterThanOrEqual(400)
  await anonymous.close()
  await signIn(page)
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32; canvas.getContext('2d')!.fillRect(0, 0, 32, 32)
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
    const submit = async (name: string, type: string, alt: string) => { const form = new FormData(); form.set('_payload', JSON.stringify({ alt })); const body = type === 'image/svg+xml' ? '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' : png; form.set('file', new File([body], name, { type })); const response = await fetch('/api/assets', { method: 'POST', body: form }); return { status: response.status, text: await response.text() } }
    return { png: await submit('synthetic.png', 'image/png', 'Synthetic HTTP image'), svg: await submit('active.svg', 'image/svg+xml', 'Rejected SVG') }
  })
  expect(result.png.status, result.png.text).toBe(201)
  expect(result.png.text).toContain('heroAvif')
  expect(result.svg.status).toBeGreaterThanOrEqual(400)
})

test('ENG-014 media workspace provides an accessible grid, metadata detail, and safe lifecycle state', async ({ page }) => {
  await signIn(page)
  await page.goto('/media')
  await expect(page.getByRole('heading', { name: 'Media' })).toBeVisible()
  await page.addScriptTag({ path: axeSource })
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])
  await expect(page.getByRole('button', { name: /synthetic\.png/ })).toBeVisible()
  await page.getByRole('button', { name: /synthetic\.png/ }).click()
  await page.locator('textarea').fill('Synthetic workspace image')
  await page.getByRole('button', { name: 'Save metadata' }).click()
  await expect(page.getByRole('status')).toContainText('Metadata saved')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.locator('main').evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth)).toBe(true)
  expect(await page.evaluate(async () => (await (window as unknown as { axe: typeof import('axe-core') }).axe.run('main')).violations)).toEqual([])
  await page.screenshot({ path: 'artifacts/media-390.png', fullPage: true })
})
