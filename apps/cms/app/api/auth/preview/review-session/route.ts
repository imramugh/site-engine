import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { serverSessionStrategy } from '../../../../../src/identity'
import { changeSetHash } from '../../../../../src/publishing'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const reviewPath = new RegExp(`^/preview/changes/(${uuid})/(live|proposed)(?:/([A-Za-z0-9._~!$&'()+,;=:@-]+(?:/[A-Za-z0-9._~!$&'()+,;=:@-]+)*))?/?$`, 'i')
const response = (status: 204 | 401 | 403) => new Response(null, { status, headers })

function comparisonPath(originalURI: string): RegExpExecArray | null {
  // auth_request receives the untrusted client URI. Keep query strings out of
  // path matching, and reject encoded separators/dot segments before URL
  // normalization can turn a request into a different artifact path.
  const path = originalURI.split('?', 1)[0]
  if (!path.startsWith('/') || /[\\\\%]/.test(path)) return null
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null
  return reviewPath.exec(path)
}

/** Authenticates a completed, current immutable comparison only. */
export async function GET(request: Request): Promise<Response> {
  try {
    const raw = request.headers.get('x-original-uri')
    if (!raw) return response(403)
    const match = comparisonPath(raw)
    if (!match) return response(403)
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    const user = authenticated.user as { id?: string; roles?: string[] } | undefined
    if (!user) return response(401)
    const owner = user.roles?.includes('owner') === true
    const reviewer = owner || user.roles?.includes('approver') === true
    const editor = user.roles?.includes('editor') === true
    if (!reviewer && !editor) return response(403)
    const job = await payload.findByID({ collection: 'preview-render-jobs', id: match[1]!, depth: 0, overrideAccess: true })
    if (job.status !== 'completed' || !job.artifactDigest) return response(403)
    const set = await payload.findByID({ collection: 'change-sets', id: String(job.changeSet), depth: 0, overrideAccess: true })
    const preview = set.preview as { status?: string; jobID?: string; revision?: number; changeHash?: string; proposedManifestHash?: string; liveManifestHash?: string } | undefined
    if (Number(set.revision) !== job.reviewRevision || changeSetHash(Array.isArray(set.changes) ? set.changes as never[] : []) !== job.changeHash) return response(403)
    if (reviewer && preview?.status === 'ready' && preview.jobID === job.id && preview.revision === job.reviewRevision && preview.changeHash === job.changeHash && preview.liveManifestHash === job.liveManifestHash && preview.proposedManifestHash === job.proposedManifestHash) return response(204)
    // Draft-preview jobs intentionally never populate changeSets.preview: that
    // field is reserved for submitted reviewer approval. A page editor may view
    // only their own still-editable, hash-current immutable draft artifact.
    const ownsDraft = ['open', 'changes-requested'].includes(String(set.state)) && (owner || ((editor || user.roles?.includes('approver')) && String(typeof set.actor === 'string' ? set.actor : set.actor?.id) === user.id))
    if (!ownsDraft || job.status !== 'completed' || !job.artifactDigest) return response(403)
    return response(204)
  } catch {
    return response(401)
  }
}
