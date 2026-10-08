import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { chromium } from '@playwright/test'
import { stabilizeCaptureState, stabilizeVideoCaptureState } from '../src/index.mjs'

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

test('video capture stabilization paints a playable offscreen video in the full-page capture', async () => {
  const [video, poster] = await Promise.all([
    readFile(new URL('../harness/public/media/sample-video.webm', import.meta.url)),
    readFile(new URL('../harness/public/media/sample-poster.svg', import.meta.url)),
  ])
  const server = createServer((request, response) => {
    if (request.url === '/media/sample-video.webm') return response.writeHead(200, { 'content-type': 'video/webm' }).end(video)
    if (request.url === '/media/sample-poster.svg') return response.writeHead(200, { 'content-type': 'image/svg+xml' }).end(poster)
    response.end(`<!doctype html><style>
    html { scroll-behavior: smooth; }
    body { margin: 0; min-height: 2600px; background: #f5f7f9; }
    video { display: block; margin-top: 1900px; width: 320px; height: 180px; }
  </style><video controls muted poster="/media/sample-poster.svg"><source src="/media/sample-video.webm" type="video/webm"></video>`)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } })
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' })
    const before = await page.locator('video').evaluate((video) => video.getBoundingClientRect().top)
    assert.ok(before > 900)
    await page.locator('video').evaluate(async (video) => {
      const waitFor = (event) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 10_000)
        video.addEventListener(event, () => { clearTimeout(timer); resolve() }, { once: true })
      })
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await waitFor('canplay')
      await video.play()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      video.pause()
      if (video.currentTime !== 0) {
        const seeked = waitFor('seeked')
        video.currentTime = 0
        await seeked
      }
      video.removeAttribute('controls')
    })
    await stabilizeVideoCaptureState(page)
    const after = await page.locator('video').evaluate((video) => ({ top: video.getBoundingClientRect().top, width: video.clientWidth, height: video.clientHeight }))
    assert.ok(after.top >= 0 && after.top < 900)
    assert.deepEqual({ width: after.width, height: after.height }, { width: 320, height: 180 })
    await stabilizeCaptureState(page)
    assert.equal(await page.evaluate(() => scrollY), 0)
    const visibleCapture = await page.screenshot({ fullPage: true })
    await page.locator('video').evaluate((video) => { video.style.visibility = 'hidden' })
    const hiddenCapture = await page.screenshot({ fullPage: true })
    assert.notDeepEqual(visibleCapture, hiddenCapture)
  } finally {
    await browser.close()
    await new Promise((done) => server.close(done))
  }
})
