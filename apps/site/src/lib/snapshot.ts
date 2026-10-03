import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseSiteSnapshot, type SiteSnapshot } from '@site-engine/contract'
import { demoHomepageId, demoSnapshot } from './demo.js'
import { normalizeBasePath, normalizePublicOrigin } from '../../site-config.mjs'

const input = process.env.SITE_SNAPSHOT_PATH
export const renderBase = normalizeBasePath(process.env.SITE_BASE_PATH ?? '/')
export const publicOrigin = normalizePublicOrigin(process.env.SITE_PUBLIC_ORIGIN ?? 'https://example.invalid')
function load(): SiteSnapshot {
  if (!input) { if (process.env.SITE_PUBLIC_DEMO === 'false') throw new Error('SITE_SNAPSHOT_PATH is required when the public demo is disabled.'); return demoSnapshot }
  try { return parseSiteSnapshot(JSON.parse(readFileSync(resolve(input), 'utf8'))) } catch (error) { throw new Error(`Unable to read SITE_SNAPSHOT_PATH: ${error instanceof Error ? error.message : 'invalid input'}`) }
}
export const siteSnapshot = load()
export const siteHomepageId = input ? siteSnapshot.settings.homepageId : demoHomepageId
export const localURL = (href: string) => /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href) ? href : `${renderBase}${href.replace(/^\//, '')}`
