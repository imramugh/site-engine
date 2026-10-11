import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Page } from '@playwright/test'

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')

/** Inject Axe through Playwright's automation channel. CSP remains enabled. */
export async function installAxe(page: Page): Promise<void> {
  await page.evaluate(axeSource)
}
