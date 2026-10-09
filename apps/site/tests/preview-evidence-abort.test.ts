import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { expect, it, vi } from 'vitest'
import { captureEvidence } from '../scripts/run-preview-worker.mjs'

it('aborts a real browser stalled on font readiness and closes its loopback server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-capture-abort-'))
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const controller = new AbortController()
  let disconnected = false
  let captureOrigin = ''
  let markReady!: () => void
  const ready = new Promise<void>(resolve => { markReady = resolve })
  const originalLaunch = chromium.launch.bind(chromium)
  const launch = vi.spyOn(chromium, 'launch').mockImplementation(async options => {
    const browser = await originalLaunch(options)
    browser.on('disconnected', () => { disconnected = true })
    const newContext = browser.newContext.bind(browser)
    vi.spyOn(browser, 'newContext').mockImplementation(async options => {
      const context = await newContext(options)
      context.on('page', page => page.on('console', message => {
        if (message.text() === 'synthetic-font-stall-ready') {
          captureOrigin = new URL(page.url()).origin
          markReady()
        }
      }))
      return context
    })
    return browser
  })
  try {
    for (const side of ['live', 'proposed']) {
      await mkdir(join(root, side))
      await writeFile(join(root, side, 'index.html'), '<!doctype html><html><body><h1>Capture abort fixture</h1><script>Object.defineProperty(document.fonts,"ready",{value:new Promise(()=>{})});console.log("synthetic-font-stall-ready")</script></body></html>')
    }
    const snapshot = structuredClone(neutralFixture)
    const pending = captureEvidence(root, { job: { id }, live: snapshot, proposed: snapshot, includedChangeKeys: [`pages:${snapshot.pages[0]!.id}`] }, controller.signal)
    // Attach the rejection assertion before triggering the abort.
    const rejected = expect(pending).rejects.toThrow()
    await ready
    await new Promise(resolve => setTimeout(resolve, 700))
    const abortedAt = Date.now()
    controller.abort()
    await rejected
    expect(Date.now() - abortedAt).toBeLessThan(3000)
    expect(disconnected).toBe(true)
    await expect(fetch(captureOrigin)).rejects.toThrow()
    await expect(readFile(join(root, 'evidence-manifest.json'))).rejects.toThrow()
  } finally {
    controller.abort()
    launch.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
