import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { serverSessionStrategy } from '../../../../src/identity'

export const dynamic = 'force-dynamic'
type JobPage = { id: string; title: string; template: string; status: string; jobPosting?: { employmentType?: string; location?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } } }

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  const user = authenticated.user as { roles?: ('owner' | 'hiring')[]; disabled?: boolean } | null
  if (!user || !hasRole(user, ['owner', 'hiring'])) return Response.json({ error: 'Authentication required.' }, { status: 403 })
  const releases = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true })
  const pages = (releases.docs[0]?.snapshot as { manifest?: { pages?: JobPage[] } } | undefined)?.manifest?.pages ?? []
  const jobs = pages.filter((page) => page.template === 'job').map((page) => ({ id: page.id, title: page.title, status: page.status, employmentType: page.jobPosting?.employmentType, location: [page.jobPosting?.location?.addressLocality, page.jobPosting?.location?.addressRegion, page.jobPosting?.location?.addressCountry].filter(Boolean).join(', ') }))
  return Response.json({ jobs }, { headers: { 'Cache-Control': 'no-store' } })
}
