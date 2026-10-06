import { buildSearchIndex } from '@site-engine/engine'
import { crawlerMode } from '../lib/crawler-config.js'
import { renderBase, siteSnapshot } from '../lib/snapshot.js'

export const prerender = true

export function GET() {
  // Preview artifacts may contain an approved candidate, but are never a public search source.
  const index = crawlerMode(renderBase) === 'public' && siteSnapshot.settings.searchEnabled ? buildSearchIndex(siteSnapshot) : { version: 1, documents: [] }
  return new Response(JSON.stringify(index), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' } })
}
