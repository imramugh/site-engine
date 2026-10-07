import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { chromium } from '@playwright/test'
import { stabilizeCaptureState } from '../src/index.mjs'

const pageHTML = `<!doctype html><html><head><style>
  html { scroll-behavior: smooth; }
  body { margin: 0; min-height: 2400px; background: #f5f7f9; }
  .skip { position: fixed; left: 0; top: 0; transform: translateY(-120%); }
  .skip:focus-visible { transform: translateY(0); }
  main { display: block; margin-top: 1200px; min-height: 600px; }
</style></head><body><a class="skip" href="#content">Skip to content</a><main id="content" tabindex="-1">Content</main></body></html>`

async function captureFromState(page, state) {
  if (state === 'skip-focused') {
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('.skip').evaluate((element) => document.activeElement === element), true)
    assert.equal(await page.locator('.skip').evaluate((element) => getComputedStyle(element).transform), 'matrix(1, 0, 0, 1, 0, 0)')
  } else {
    await page.evaluate(() => window.scrollTo(0, 800))
    await page.locator('#content').focus()
  }
  await stabilizeCaptureState(page)
  const stateAfterReset = await page.evaluate(() => ({
    scrollX,
    scrollY,
    focused: document.activeElement?.tagName,
    fonts: document.fonts.status,
  }))
  assert.deepEqual(stateAfterReset, { scrollX: 0, scrollY: 0, focused: 'BODY', fonts: 'loaded' })
  return page.screenshot({ fullPage: true })
}

test('capture stabilization keeps skip-link navigation testable and removes focused or scrolled screenshot state', async () => {
  const server = createServer((_, response) => response.end(pageHTML))
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' })

    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('#content').evaluate((element) => document.activeElement === element), true)

    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' })
    const focusedSkipCapture = await captureFromState(page, 'skip-focused')
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' })
    const scrolledCapture = await captureFromState(page, 'scrolled-content-focused')
    assert.deepEqual(focusedSkipCapture, scrolledCapture)
    await context.close()
  } finally {
    await browser.close()
    await new Promise((done) => server.close(done))
  }
})
