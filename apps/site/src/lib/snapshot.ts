import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SiteSnapshotSchema, type SiteSnapshot } from '@site-engine/contract'
import { demoHomepageId, demoSnapshot } from './demo.js'

const input = process.env.SITE_SNAPSHOT_PATH
const rawBase = process.env.SITE_BASE_PATH ?? '/'
export const renderBase = rawBase === '/' ? '/' : `/${rawBase.replace(/^\/+|\/+$/g, '')}/`
export const publicOrigin = new URL(process.env.SITE_PUBLIC_ORIGIN ?? 'https://example.invalid').origin
function load(): SiteSnapshot {
  if (!input) { if (process.env.SITE_PUBLIC_DEMO === 'false') throw new Error('SITE_SNAPSHOT_PATH is required when the public demo is disabled.'); return demoSnapshot }
  try { return SiteSnapshotSchema.parse(JSON.parse(readFileSync(resolve(input), 'utf8'))) } catch (error) { throw new Error(`Unable to read SITE_SNAPSHOT_PATH: ${error instanceof Error ? error.message : 'invalid input'}`) }
}
export const siteSnapshot = load()
export const siteHomepageId = input ? siteSnapshot.settings.homepageId : demoHomepageId
