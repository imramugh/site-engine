import { getPayload } from 'payload'
import config from '../../../payload.config'
import { withPayloadTransaction } from '../../../src/auth-transaction'
import { hasRole } from '../../../src/access'
import { buildContentTree, canonicalContentPath, type ContentTreeNode, type ContentTreePage, type ContentTreeSection } from '../../../src/content-tree'
import { serverSessionStrategy } from '../../../src/identity'
import { canonicalHash } from '../../../src/publishing'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
const editableStates = ['open', 'changes-requested']

type Actor = { id: string; roles?: string[]; disabled?: boolean }
type Document = Record<string, unknown> & { id: string }

function sameOrigin(request: Request) {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}
function idOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
}
function ownedSet(set: Document, actor: Actor, expectedRevision: unknown) {
  return editableStates.includes(String(set.state)) && idOf(set.actor) === actor.id && Number(set.revision) === expectedRevision
}
function settingsValue(doc?: Document) {
  return {
    siteName: String(doc?.siteName ?? ''),
    homepageId: idOf(doc?.homepageId) ?? null,
    defaultLocale: doc?.defaultLocale === 'en-CA' ? 'en-CA' : 'en',
    organizationType: doc?.organizationType === 'professional-service' ? 'professional-service' : doc?.organizationType === 'organization' ? 'organization' : null,
    logo: idOf(doc?.logo) ?? null,
    contactEmail: typeof doc?.contactEmail === 'string' ? doc.contactEmail : null,
    contactPhone: typeof doc?.contactPhone === 'string' ? doc.contactPhone : null,
    seoDescription: typeof doc?.seoDescription === 'string' ? doc.seoDescription : null,
    searchEnabled: doc?.searchEnabled === true,
  }
}
function guideValue(doc?: Document) {
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return {
    bannedPhrases: strings(doc?.bannedPhrases), preferredTerms: strings(doc?.preferredTerms),
    canadianSpelling: doc?.canadianSpelling === 'warn' ? 'warn' : 'off',
    maximumSentenceWords: Number(doc?.maximumSentenceWords ?? 30), minimumReadingEase: Number(doc?.minimumReadingEase ?? 30),
  }
}
function redirectValue(doc: Document) { return { from: String(doc.from ?? ''), to: String(doc.to ?? ''), status: 301 } }

async function context(payload: Awaited<ReturnType<typeof getPayload>>, actor: Actor) {
  const [settingsResult, guideResult, sets, redirects, sectionsResult, pagesResult, assetsResult] = await Promise.all([
    payload.find({ collection: 'site-settings', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, user: actor as never, overrideAccess: false }),
    payload.find({ collection: 'style-guides', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, user: actor as never, overrideAccess: false }),
    payload.find({ collection: 'change-sets', where: { and: [{ actor: { equals: actor.id } }, { state: { in: editableStates } }] }, sort: '-updatedAt', limit: 50, depth: 0, user: actor as never, overrideAccess: false }),
    payload.find({ collection: 'redirects', sort: 'from', limit: 0, pagination: false, depth: 0, draft: true, user: actor as never, overrideAccess: false }),
    payload.find({ collection: 'sections', sort: 'name', limit: 0, pagination: false, depth: 0, draft: true, user: actor as never, overrideAccess: false }),
    payload.find({ collection: 'pages', sort: 'title', limit: 0, pagination: false, depth: 0, draft: true, user: actor as never, overrideAccess: false }),
    payload.find({ collection: 'assets', sort: 'alt', limit: 0, pagination: false, depth: 0, draft: true, user: actor as never, overrideAccess: false }),
  ])
  const settingsDoc = settingsResult.docs[0] as unknown as Document | undefined
  const guideDoc = guideResult.docs[0] as unknown as Document | undefined
  const settings = settingsValue(settingsDoc); const guide = guideValue(guideDoc)
  const sections = sectionsResult.docs as unknown as ContentTreeSection[]
  const pages = pagesResult.docs as unknown as ContentTreePage[]
  const homepageID = settings.homepageId ?? undefined
  const tree = buildContentTree(sections, pages)
  const flatten = (nodes: ContentTreeNode[], depth = 0): Array<{ id: string; title: string; path: string | null; depth: number }> => nodes.flatMap(node => [{ id: node.page.id, title: node.page.title, path: canonicalContentPath(node.page, pages, sections, homepageID) ?? null, depth }, ...flatten(node.children, depth + 1)])
  const navigation = tree.sections.map(group => ({
    id: group.section.id, name: group.section.name,
    pages: flatten([...group.roots, ...group.unplaced]).filter(item => pages.find(page => page.id === item.id)?._status !== 'archived'),
  }))
  return {
    settings, settingsHash: canonicalHash(settings), guide, guideHash: canonicalHash(guide),
    changeSets: sets.docs.map(set => ({ id: set.id, name: set.name, state: set.state, revision: set.revision })),
    redirects: (redirects.docs as unknown as Document[]).map(doc => ({ id: doc.id, ...redirectValue(doc), hitCount: Number(doc.hitCount ?? 0), lastHitAt: doc.lastHitAt ?? null, hash: canonicalHash(redirectValue(doc)) })),
    navigation,
    references: { pages: pages.filter(page => page._status !== 'archived').map(page => ({ id: page.id, title: page.title })), assets: assetsResult.docs.map(asset => ({ id: asset.id, label: asset.alt || asset.filename || asset.id })) },
  }
}

async function body(request: Request) {
  const size = Number(request.headers.get('content-length') ?? 0)
  if (size > 32768) throw new Error('Request body is too large.')
  const text = await request.text(); if (Buffer.byteLength(text, 'utf8') > 32768) throw new Error('Request body is too large.')
  const parsed = JSON.parse(text) as Record<string, unknown>
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request.')
  return parsed
}
function cleanStrings(value: unknown, maxItems = 100) {
  if (!Array.isArray(value) || value.length > maxItems || !value.every(item => typeof item === 'string' && item.trim().length <= 120)) throw new Error('Guidance must be a list of short text entries.')
  return [...new Set(value.map(item => (item as string).trim()).filter(Boolean))]
}

export async function GET(request: Request) {
  try {
    const payload = await getPayload({ config }); const actor = (await serverSessionStrategy.authenticate({ headers: request.headers, payload })).user as Actor | null
    if (!hasRole(actor as never, ['owner'])) return Response.json({ error: 'Owner access required.' }, { status: 403, headers: noStore })
    return Response.json(await context(payload, actor!), { headers: noStore })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Unable to load Site.' }, { status: 400, headers: noStore }) }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const payload = await getPayload({ config }); const actor = (await serverSessionStrategy.authenticate({ headers: request.headers, payload })).user as Actor | null
    if (!hasRole(actor as never, ['owner'])) return Response.json({ error: 'Owner access required.' }, { status: 403, headers: noStore })
    const input = await body(request)
    if (typeof input.changeSetID !== 'string' || !Number.isInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) throw new Error('Choose a current owned change set.')
    await withPayloadTransaction(payload, async req => {
      req.user = actor as never; req.headers = new Headers(request.headers); req.headers.set('x-site-engine-change-set', input.changeSetID as string)
      const set = await payload.findByID({ collection: 'change-sets', id: input.changeSetID as string, depth: 0, overrideAccess: true, req }) as unknown as Document
      if (!ownedSet(set, actor!, input.expectedRevision)) throw new Error('The selected change set changed or is not owned by this account.')
      if (input.action === 'settings') {
        const current = (await payload.find({ collection: 'site-settings', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req })).docs[0] as unknown as Document | undefined
        if (input.expectedHash !== canonicalHash(settingsValue(current))) throw new Error('Site details changed. Reload before saving.')
        const value = input.value as Record<string, unknown>
        if (!value || Object.keys(value).some(key => !['siteName','homepageId','defaultLocale','organizationType','logo','contactEmail','contactPhone','seoDescription','searchEnabled'].includes(key))) throw new Error('Unsupported site setting.')
        const data = { ...value, key: 'active' }
        if (current) await payload.update({ collection: 'site-settings', id: current.id, data, draft: true, overrideAccess: false, user: actor as never, req })
        else await payload.create({ collection: 'site-settings', data, draft: true, overrideAccess: false, user: actor as never, req })
      } else if (input.action === 'guide') {
        const current = (await payload.find({ collection: 'style-guides', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req })).docs[0] as unknown as Document | undefined
        if (input.expectedHash !== canonicalHash(guideValue(current))) throw new Error('Search and writing guidance changed. Reload before saving.')
        const value = input.value as Record<string, unknown>
        if (!value || Object.keys(value).some(key => !['bannedPhrases','preferredTerms','canadianSpelling','maximumSentenceWords','minimumReadingEase'].includes(key))) throw new Error('Unsupported style setting.')
        if (!['off', 'warn'].includes(String(value.canadianSpelling)) || !Number.isInteger(value.maximumSentenceWords) || Number(value.maximumSentenceWords) < 5 || Number(value.maximumSentenceWords) > 100 || !Number.isInteger(value.minimumReadingEase) || Number(value.minimumReadingEase) < 0 || Number(value.minimumReadingEase) > 121) throw new Error('Writing guidance values are outside the supported range.')
        const data = { key: 'active', bannedPhrases: cleanStrings(value.bannedPhrases), preferredTerms: cleanStrings(value.preferredTerms), canadianSpelling: value.canadianSpelling as 'off' | 'warn', maximumSentenceWords: Number(value.maximumSentenceWords), minimumReadingEase: Number(value.minimumReadingEase) }
        if (current) await payload.update({ collection: 'style-guides', id: current.id, data, draft: true, overrideAccess: false, user: actor as never, req })
        else await payload.create({ collection: 'style-guides', data, draft: true, overrideAccess: false, user: actor as never, req })
      } else if (input.action === 'redirect') {
        const value = input.value as Record<string, unknown>; if (!value || typeof value.from !== 'string' || typeof value.to !== 'string') throw new Error('Both redirect paths are required.')
        const current = typeof input.id === 'string' ? await payload.findByID({ collection: 'redirects', id: input.id, depth: 0, draft: true, overrideAccess: true, req }) as unknown as Document : undefined
        if (current && input.expectedHash !== canonicalHash(redirectValue(current))) throw new Error('This redirect changed. Reload before saving.')
        if (current) await payload.update({ collection: 'redirects', id: current.id, data: { from: value.from, to: value.to }, draft: true, overrideAccess: false, user: actor as never, req })
        else await payload.create({ collection: 'redirects', data: { from: value.from, to: value.to, status: 301 }, draft: true, overrideAccess: false, user: actor as never, req })
      } else throw new Error('Unsupported Site action.')
    })
    return Response.json(await context(payload, actor!), { headers: noStore })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Site update failed.' }, { status: 400, headers: noStore }) }
}
