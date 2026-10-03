import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { withPayloadTransaction } from '../../../../src/auth-transaction'
import { serverSessionStrategy } from '../../../../src/identity'
import { importReviewedSnapshot } from '../../../../src/reviewed-snapshot-import'
import type { Role } from '../../../../src/access'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }
const sameOrigin = (request: Request) => {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin === new URL(configured).origin)
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403, headers: noStore })
  try {
    const body = await request.json() as { name?: unknown; manifest?: unknown }
    if (typeof body.name !== 'string' || !body.manifest) throw new Error('A change-set name and snapshot manifest are required.')
    const name = body.name
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    const actor = authenticated.user as unknown as { id: string; roles?: Role[] | null; disabled?: boolean | null }
    if (!actor.roles?.includes('owner')) return Response.json({ error: 'Owner role required.' }, { status: 403, headers: noStore })
    const result = await withPayloadTransaction(payload, async req => {
      req.user = authenticated.user
      req.headers = request.headers
      const releases = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true, req })
      const source = releases.docs[0]?.snapshot as { manifest?: unknown } | undefined
      if (!source?.manifest) throw new Error('A published baseline is required before snapshot reconciliation.')
      return importReviewedSnapshot({ payload, req, actor, name, manifest: body.manifest, baseline: source.manifest })
    })
    return Response.json(result, { headers: noStore })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Snapshot import failed.'
    return Response.json({ error: message }, { status: /Owner role|required|Authentication/i.test(message) ? 403 : 400, headers: noStore })
  }
}
