import { getPayload } from 'payload'
import config from '../../../payload.config'
import { withPayloadTransaction } from '../../../src/auth-transaction'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../src/sqlite'
import { hasRole } from '../../../src/access'
import { buildContentTree, canonicalContentPath, type ContentTreeNode, type ContentTreePage, type ContentTreeSection } from '../../../src/content-tree'
import { serverSessionStrategy } from '../../../src/identity'
import { canonicalHash } from '../../../src/publishing'
import { loadInitialPreviewBaseline, previewThemeContext } from '../../../src/review-preview'

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
  const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const address = object(doc?.address); const incident = object(doc?.incident); const logos = object(doc?.logos); const navigation = object(doc?.navigation); const crawlerPolicy = object(doc?.crawlerPolicy)
  const logoIDs = Object.fromEntries(['primaryLight','primaryDark','fullLockupLight','fullLockupDark','symbolLight','symbolDark'].map(field => [field, idOf(logos?.[field]) ?? null]))
  return {
    siteName: String(doc?.siteName ?? ''),
    legalName: typeof doc?.legalName === 'string' ? doc.legalName : null,
    homepageId: idOf(doc?.homepageId) ?? null,
    defaultLocale: doc?.defaultLocale === 'en-CA' ? 'en-CA' : 'en',
    organizationType: doc?.organizationType === 'professional-service' ? 'professional-service' : doc?.organizationType === 'organization' ? 'organization' : null,
    logo: idOf(doc?.logo) ?? null,
    logos: Object.values(logoIDs).some(Boolean) ? logoIDs : null,
    contactEmail: typeof doc?.contactEmail === 'string' ? doc.contactEmail : null,
    contactPhone: typeof doc?.contactPhone === 'string' ? doc.contactPhone : null,
    address: address && typeof address.streetAddress === 'string' ? { streetAddress: address.streetAddress, addressLocality: address.addressLocality, addressRegion: address.addressRegion, postalCode: address.postalCode, addressCountry: address.addressCountry } : null,
    linkedIn: typeof doc?.linkedIn === 'string' ? doc.linkedIn : null,
    incident: incident && typeof incident.label === 'string' ? { label: incident.label, guidance: incident.guidance } : null,
    navigation: navigation ?? null,
    seoDescription: typeof doc?.seoDescription === 'string' ? doc.seoDescription : null,
    searchEnabled: doc?.searchEnabled === true,
    crawlerPolicy: crawlerPolicy && ['searchEngines', 'aiSearchAndAnswers', 'aiModelTraining'].every(field => typeof crawlerPolicy[field] === 'boolean') ? {
      searchEngines: crawlerPolicy.searchEngines === true,
      aiSearchAndAnswers: crawlerPolicy.aiSearchAndAnswers === true,
      aiModelTraining: crawlerPolicy.aiModelTraining === true,
    } : null,
  }
}
function guideValue(doc?: Document) {
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const terms = (value: unknown) => Array.isArray(value) ? value.flatMap(item => item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).avoid === 'string' && typeof (item as Record<string, unknown>).prefer === 'string' ? [{ avoid: String((item as Record<string, unknown>).avoid), prefer: String((item as Record<string, unknown>).prefer) }] : []) : []
  return {
    bannedPhrases: strings(doc?.bannedPhrases), preferredTerms: terms(doc?.preferredTerms),
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
  const sections = sectionsResult.docs as unknown as Array<ContentTreeSection & { pageIds?: Array<string | { id?: string }> }>
  const pages = pagesResult.docs as unknown as ContentTreePage[]
  const homepageID = settings.homepageId ?? undefined
  const tree = buildContentTree(sections, pages)
  const themeContext = await previewThemeContext({ payload, changeSets: sets.docs as unknown as Document[], initialBaseline: await loadInitialPreviewBaseline() })
  const flatten = (nodes: ContentTreeNode[], depth = 0): Array<{ id: string; title: string; path: string | null; depth: number }> => nodes.flatMap(node => [{ id: node.page.id, title: node.page.title, path: canonicalContentPath(node.page, pages, sections, homepageID) ?? null, depth }, ...flatten(node.children, depth + 1)])
  const navigation = tree.sections.map(group => ({
    id: group.section.id, name: group.section.name,
    pages: flatten([...group.roots, ...group.unplaced]).filter(item => pages.find(page => page.id === item.id)?._status !== 'archived'),
  }))
  return {
    settings, settingsHash: canonicalHash(settings), guide, guideHash: canonicalHash(guide),
    changeSets: sets.docs.map(set => ({ id: set.id, name: set.name, state: set.state, revision: set.revision, contractVersion: themeContext.changeSetContractVersions[String(set.id)] ?? null })),
    redirects: (redirects.docs as unknown as Document[]).map(doc => ({ id: doc.id, ...redirectValue(doc), createdBy: typeof doc.createdByLabel === 'string' && doc.createdByLabel.trim() ? doc.createdByLabel : null, hitCount: Number(doc.hitCount ?? 0), hash: canonicalHash(redirectValue(doc)) })),
    navigation,
    references: { pages: pages.filter(page => page._status !== 'archived').map(page => ({ id: page.id, title: page.title })), sections: sections.map(section => ({ id: section.id, title: section.name, pillars: (section.pageIds ?? []).map(idOf).map(id => pages.find(page => page.id === id)).filter(page => page?._status !== 'archived' && page?.template === 'pillar' && (!idOf(page?.parentId) || idOf(page?.parentId) === idOf(section.landingPageId))).map(page => ({ id: page!.id, title: page!.title })) })), assets: assetsResult.docs.filter(asset => !asset.deletedAt).map(asset => { const file = asset.currentFile && typeof asset.currentFile === 'object' && !Array.isArray(asset.currentFile) ? asset.currentFile as { url?: string } : asset; return { id: asset.id, label: asset.alt || asset.filename || asset.id, url: file.url ?? null } }) },
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
function cleanPreferredTerms(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Preferred terms must be a bounded list.')
  const terms = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['avoid', 'prefer'].includes(key))) throw new Error('Each preferred term needs an avoided and preferred form.')
    const avoid = (item as Record<string, unknown>).avoid; const prefer = (item as Record<string, unknown>).prefer
    if (typeof avoid !== 'string' || typeof prefer !== 'string' || !avoid.trim() || !prefer.trim() || avoid.trim().length > 80 || prefer.trim().length > 80 || avoid.trim().toLocaleLowerCase() === prefer.trim().toLocaleLowerCase()) throw new Error('Each preferred term needs distinct text of 80 characters or fewer.')
    return { avoid: avoid.trim(), prefer: prefer.trim() }
  })
  if (new Set(terms.map(term => term.avoid.toLocaleLowerCase())).size !== terms.length) throw new Error('Avoided terms must be unique.')
  return terms
}
function cleanCrawlerPolicy(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('All crawler preferences are required.')
  const policy = value as Record<string, unknown>
  if (Object.keys(policy).some(key => !['searchEngines', 'aiSearchAndAnswers', 'aiModelTraining'].includes(key)) || !['searchEngines', 'aiSearchAndAnswers', 'aiModelTraining'].every(key => typeof policy[key] === 'boolean')) throw new Error('All crawler preferences are required.')
  return { searchEngines: policy.searchEngines as boolean, aiSearchAndAnswers: policy.aiSearchAndAnswers as boolean, aiModelTraining: policy.aiModelTraining as boolean }
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
      if (input.action === 'search-ai') {
        const [currentSettings, currentGuide] = await Promise.all([
          payload.find({ collection: 'site-settings', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req }),
          payload.find({ collection: 'style-guides', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req }),
        ])
        const settingsDoc = currentSettings.docs[0] as unknown as Document | undefined
        const guideDoc = currentGuide.docs[0] as unknown as Document | undefined
        if (!settingsDoc) throw new Error('Configure Business details before Search and AI.')
        if (input.expectedSettingsHash !== canonicalHash(settingsValue(settingsDoc)) || input.expectedGuideHash !== canonicalHash(guideValue(guideDoc))) throw new Error('Search and AI settings changed. Reload before saving.')
        const value = input.value as { settings?: Record<string, unknown>; guide?: Record<string, unknown> } | undefined
        if (!value || !value.settings || !value.guide || Object.keys(value.settings).some(key => !['seoDescription', 'searchEnabled', 'crawlerPolicy'].includes(key)) || Object.keys(value.guide).some(key => !['bannedPhrases','preferredTerms','canadianSpelling','maximumSentenceWords','minimumReadingEase'].includes(key))) throw new Error('Unsupported Search and AI setting.')
        const policy = cleanCrawlerPolicy(value.settings.crawlerPolicy)
        const description = value.settings.seoDescription
        if (description !== null && (typeof description !== 'string' || !description.trim() || description.trim().length > 160)) throw new Error('The short site description must be 160 characters or fewer.')
        if (typeof value.settings.searchEnabled !== 'boolean') throw new Error('Public search preference is required.')
        if (!['off', 'warn'].includes(String(value.guide.canadianSpelling)) || !Number.isInteger(value.guide.maximumSentenceWords) || Number(value.guide.maximumSentenceWords) < 5 || Number(value.guide.maximumSentenceWords) > 100 || !Number.isInteger(value.guide.minimumReadingEase) || Number(value.guide.minimumReadingEase) < 0 || Number(value.guide.minimumReadingEase) > 121) throw new Error('Writing guidance values are outside the supported range.')
        const preview = await previewThemeContext({ payload, changeSets: [set], initialBaseline: await loadInitialPreviewBaseline(), req })
        if (preview.changeSetContractVersions[String(set.id)] !== '1.7.0') throw new Error('Search and AI crawler preferences require a selected contract 1.7 theme in the same change set.')
        await payload.update({ collection: 'site-settings', id: settingsDoc.id, data: { seoDescription: typeof description === 'string' ? description.trim() : null, searchEnabled: value.settings.searchEnabled, crawlerPolicy: policy }, draft: true, overrideAccess: false, user: actor as never, req })
        // The capture hook performs its own internal change-set update using
        // this request. Restore the caller's capture context before writing
        // the second document in this atomic operation.
        req.context = { ...req.context, editorialInternal: false }
        const guideData = { key: 'active', bannedPhrases: cleanStrings(value.guide.bannedPhrases), preferredTerms: cleanPreferredTerms(value.guide.preferredTerms), canadianSpelling: value.guide.canadianSpelling as 'off' | 'warn', maximumSentenceWords: Number(value.guide.maximumSentenceWords), minimumReadingEase: Number(value.guide.minimumReadingEase) }
        if (guideDoc) await payload.update({ collection: 'style-guides', id: guideDoc.id, data: guideData, draft: true, overrideAccess: false, user: actor as never, req })
        else await payload.create({ collection: 'style-guides', data: guideData, draft: true, overrideAccess: false, user: actor as never, req })
      } else if (input.action === 'settings') {
        const current = (await payload.find({ collection: 'site-settings', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req })).docs[0] as unknown as Document | undefined
        if (input.expectedHash !== canonicalHash(settingsValue(current))) throw new Error('Site details changed. Reload before saving.')
        const value = input.value as Record<string, unknown>
        if (!value || Object.keys(value).some(key => !['siteName','legalName','homepageId','defaultLocale','organizationType','logo','logos','contactEmail','contactPhone','address','linkedIn','incident','navigation','seoDescription','searchEnabled','crawlerPolicy'].includes(key))) throw new Error('Unsupported site setting.')
        const navigation = value.navigation as { header?: Array<{ kind?: string }>; footer?: { columns?: Array<{ kind?: string }>; bottomLinks?: Array<{ kind?: string }> } } | null | undefined
        const uses16 = Boolean(navigation && (navigation.header?.some(item => item.kind === 'unavailable') || navigation.footer?.bottomLinks || navigation.footer?.columns?.some(column => ['section-pillars', 'contact'].includes(column.kind ?? ''))))
        const uses17 = value.crawlerPolicy !== null && value.crawlerPolicy !== undefined
        if (uses16 || uses17) {
          const preview = await previewThemeContext({ payload, changeSets: [set], initialBaseline: await loadInitialPreviewBaseline(), req })
          const selectedContract = preview.changeSetContractVersions[String(set.id)]
          if (uses16 && selectedContract !== '1.6.0' && selectedContract !== '1.7.0') throw new Error('This Navigation design requires a selected contract 1.6 or newer theme in the same change set.')
          if (uses17 && selectedContract !== '1.7.0') throw new Error('Crawler preferences require a selected contract 1.7 theme in the same change set.')
        }
        const data = { ...value, logos: value.logos ?? { primaryLight: null, primaryDark: null, fullLockupLight: null, fullLockupDark: null, symbolLight: null, symbolDark: null }, address: value.address ?? { streetAddress: null, addressLocality: null, addressRegion: null, postalCode: null, addressCountry: null }, incident: value.incident ?? { label: null, guidance: null }, key: 'active' }
        if (current) await payload.update({ collection: 'site-settings', id: current.id, data, draft: true, overrideAccess: false, user: actor as never, req })
        else await payload.create({ collection: 'site-settings', data, draft: true, overrideAccess: false, user: actor as never, req })
      } else if (input.action === 'guide') {
        const current = (await payload.find({ collection: 'style-guides', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req })).docs[0] as unknown as Document | undefined
        if (input.expectedHash !== canonicalHash(guideValue(current))) throw new Error('Search and writing guidance changed. Reload before saving.')
        const value = input.value as Record<string, unknown>
        if (!value || Object.keys(value).some(key => !['bannedPhrases','preferredTerms','canadianSpelling','maximumSentenceWords','minimumReadingEase'].includes(key))) throw new Error('Unsupported style setting.')
        if (!['off', 'warn'].includes(String(value.canadianSpelling)) || !Number.isInteger(value.maximumSentenceWords) || Number(value.maximumSentenceWords) < 5 || Number(value.maximumSentenceWords) > 100 || !Number.isInteger(value.minimumReadingEase) || Number(value.minimumReadingEase) < 0 || Number(value.minimumReadingEase) > 121) throw new Error('Writing guidance values are outside the supported range.')
        const data = { key: 'active', bannedPhrases: cleanStrings(value.bannedPhrases), preferredTerms: cleanPreferredTerms(value.preferredTerms), canadianSpelling: value.canadianSpelling as 'off' | 'warn', maximumSentenceWords: Number(value.maximumSentenceWords), minimumReadingEase: Number(value.minimumReadingEase) }
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
  } catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, noStore) ?? Response.json({ error: error instanceof Error ? error.message : 'Site update failed.' }, { status: 400, headers: noStore }) }
}
