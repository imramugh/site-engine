import { sqliteAuthenticationBoundary } from '../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { serverSessionStrategy } from '../../../../src/identity'

export const dynamic = 'force-dynamic'

type JobPage = {
  id: string
  sectionId: string
  title: string
  template: string
  status: string
  jobPosting?: {
    employmentType?: string
    workMode?: 'ONSITE' | 'HYBRID' | 'REMOTE'
    validThrough?: string
    location?: { addressLocality?: string; addressRegion?: string; addressCountry?: string }
  }
}

const location = (page: JobPage): string => [page.jobPosting?.location?.addressLocality, page.jobPosting?.location?.addressRegion, page.jobPosting?.location?.addressCountry].filter(Boolean).join(', ')

async function GETHandler(request: Request): Promise<Response> {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const user = authenticated.user as { id?: string; roles?: ('owner' | 'hiring')[]; disabled?: boolean } | null
  if (!user || !hasRole(user, ['owner', 'hiring'])) return Response.json({ error: 'Authentication required.' }, { status: 403 })
  const canPostRole = hasRole(user, ['owner'])

  const [sectionResult, currentResult, releases] = await Promise.all([
    payload.find({ collection: 'sections', where: { slug: { equals: 'careers' } }, limit: 1, depth: 0, draft: true, overrideAccess: true }),
    payload.find({ collection: 'pages', limit: 0, pagination: false, depth: 0, draft: true, overrideAccess: true }),
    payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true }),
  ])
  const manifest = (releases.docs[0]?.snapshot as { manifest?: { pages?: JobPage[]; settings?: { sections?: Array<{ id: string; slug: string }> } } } | undefined)?.manifest
  const currentSectionID = sectionResult.docs[0]?.id
  const publishedSectionID = manifest?.settings?.sections?.find((section) => section.slug === 'careers')?.id
  const current = (currentResult.docs as unknown as JobPage[]).filter((page) => page.template === 'job' && page.sectionId === currentSectionID)
  const published = (manifest?.pages ?? []).filter((page) => page.template === 'job' && page.sectionId === publishedSectionID)
  const currentByID = new Map(current.map((page) => [page.id, page]))
  const publishedByID = new Map(published.map((page) => [page.id, page]))
  const all = [...current, ...published.filter((page) => !currentByID.has(page.id))]

  const jobs = await Promise.all(all.map(async (page) => {
    const applicationCount = await payload.count({ collection: 'applications', where: { jobId: { equals: page.id } }, user, overrideAccess: false })
    // Public availability is determined by the immutable published release.
    // Keep draft metadata visible to staff, but a draft deadline extension
    // cannot reopen an expired role before that revision is published.
    const publishedPage = publishedByID.get(page.id)
    const availability = publishedPage ?? page
    const expired = Boolean(availability.jobPosting?.validThrough && new Date(availability.jobPosting.validThrough).getTime() <= Date.now())
    const status = availability.status === 'archived' || expired ? 'closed' : publishedPage?.status === 'published' ? 'open' : 'draft'
    return { id: page.id, title: page.title, status, applicationCount: applicationCount.totalDocs, employmentType: page.jobPosting?.employmentType, workMode: page.jobPosting?.workMode, location: location(page), validThrough: page.jobPosting?.validThrough, ...(canPostRole ? { editHref: `/content-editor/${encodeURIComponent(page.id)}` } : {}) }
  }))
  jobs.sort((left, right) => left.title.localeCompare(right.title))
  return Response.json({ jobs, canPostRole }, { headers: { 'Cache-Control': 'no-store' } })
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
