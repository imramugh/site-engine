import type { Block, SiteSnapshot } from '@site-engine/contract'
import { deriveRoutes } from './index.js'

export type SearchDocument = { title: string; summary: string; headings: string[]; body: string; url: string }
export type SearchIndex = { version: 1; documents: SearchDocument[] }

function text(block: Block): { headings: string[]; body: string[] } {
  switch (block.type) {
    case 'hero': return { headings: [block.heading], body: [block.body] }
    case 'incidentBar': return { headings: [], body: [block.message] }
    case 'pillarGrid': case 'featureGrid': return { headings: [block.heading, ...block.items.map((item) => item.title)], body: block.items.map((item) => item.body) }
    case 'splitList': return { headings: [block.heading, ...block.items.map((item) => item.title)], body: block.items.map((item) => item.body) }
    case 'chipList': return { headings: block.heading ? [block.heading] : [], body: block.chips }
    case 'testimonials': return { headings: [], body: block.items.filter((item) => item.permissionConfirmed).flatMap((item) => [item.quote, item.attribution, item.role ?? '']) }
    case 'faq': return { headings: [block.heading, ...block.items.map((item) => item.question)], body: block.items.map((item) => item.answer) }
    case 'callout': case 'cta': case 'imageText': return { headings: [block.heading], body: [block.body] }
    case 'richText': return { headings: [], body: [block.body] }
    case 'contact': return { headings: [block.heading], body: [block.body] }
    case 'relatedServices': return { headings: [block.heading], body: [] }
    case 'video': return { headings: [], body: block.transcript ? [block.transcript] : [] }
    default: return { headings: [], body: [] }
  }
}

/** A theme-neutral, public-only document set. deriveRoutes omits drafts and unpublished ancestry. */
export function buildSearchIndex(snapshot: SiteSnapshot): SearchIndex {
  const routes = deriveRoutes(snapshot, snapshot.settings.homepageId).routes
  return { version: 1, documents: routes.map((route) => {
    const values = route.page.blocks.filter((block) => !block.hidden).map(text)
    return { title: route.page.title, summary: route.page.summary, headings: values.flatMap((value) => value.headings), body: values.flatMap((value) => value.body).join('\n'), url: route.canonicalPath }
  }) }
}
