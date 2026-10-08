import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { chromium } from '@playwright/test'
import { collectMotionState, hasEffectiveReducedMotion } from '../src/index.mjs'

test('reduced-motion conformance accepts static and paused effects', () => {
  assert.equal(hasEffectiveReducedMotion({ motion: 'reduce', animations: [] }), true)
  assert.equal(hasEffectiveReducedMotion({
    motion: 'reduce',
    animations: [{ pending: false, playState: 'paused' }, { pending: false, playState: 'finished' }, { pending: false, playState: 'idle' }],
  }), true)
})

test('reduced-motion conformance rejects active or pending effects', () => {
  assert.equal(hasEffectiveReducedMotion({ motion: 'reduce', animations: [{ pending: false, playState: 'running' }] }), false)
  assert.equal(hasEffectiveReducedMotion({ motion: 'reduce', animations: [{ pending: true, playState: 'paused' }] }), false)
  assert.equal(hasEffectiveReducedMotion({ motion: 'allow', animations: [] }), false)
})

test('motion collection sees static, descendant, and pseudo-element effects', async () => {
  const server = createServer((_, response) => response.end(`<!doctype html>
    <html data-motion="reduce"><style>
      @keyframes shift { to { opacity: .5 } }
      [data-motion-effect].paused { animation: shift 1s infinite paused; }
      [data-motion-effect].running span { animation: shift 1s infinite running; }
      [data-motion-effect].pseudo::before { content: ''; display: block; animation: shift 1s infinite running; }
    </style><body>
      <div data-motion-effect class="none">static</div>
      <div data-motion-effect class="paused">paused</div>
      <div data-motion-effect class="running"><span>descendant</span></div>
      <div data-motion-effect class="pseudo">pseudo</div>
    </body></html>`))
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' })
    await page.locator('.running, .pseudo').evaluateAll((elements) => elements.forEach((element) => element.remove()))
    let state = await page.evaluate(collectMotionState)
    assert.equal(hasEffectiveReducedMotion(state), true, 'animation: none and paused effects are static')

    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div data-motion-effect class="running"><span>descendant</span></div>'))
    state = await page.evaluate(collectMotionState)
    assert.equal(hasEffectiveReducedMotion(state), false, 'a running descendant fails reduced-motion conformance')

    await page.locator('.running').evaluate((element) => element.remove())
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div data-motion-effect class="pseudo">pseudo</div>'))
    state = await page.evaluate(collectMotionState)
    assert.equal(state.animations.some((animation) => animation.pseudoElement === '::before'), true)
    assert.equal(hasEffectiveReducedMotion(state), false, 'a running pseudo-element fails reduced-motion conformance')
  } finally {
    await browser.close()
    await new Promise((done) => server.close(done))
  }
})
