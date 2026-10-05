import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { withPayloadTransaction } from '../../../../src/auth-transaction'
import { serverSessionStrategy } from '../../../../src/identity'
import { moveAssetToBin, restoreAssetFromBin } from '../../../../src/media-lifecycle'
import { retentionPolicy } from '../../../../src/retention'

export const dynamic = 'force-dynamic'

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!authenticated.user) return Response.json({ error: 'Authentication required.' }, { status: 401 })
    const body = await request.json() as { assetId?: string; action?: string }
    if (typeof body.assetId !== 'string') return Response.json({ error: 'assetId is required.' }, { status: 400 })
    if (body.action !== 'bin' && body.action !== 'restore') return Response.json({ error: 'A media lifecycle action is required.' }, { status: 400 })
    const assetId = body.assetId
    const result = await withPayloadTransaction(payload, async (req) => {
      req.user = authenticated.user
      return body.action === 'bin'
        ? moveAssetToBin(payload, req, authenticated.user as never, assetId, new Date(), (await retentionPolicy(payload, req)).mediaBinDays)
        : restoreAssetFromBin(payload, req, authenticated.user as never, assetId)
    })
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to update media lifecycle.' }, { status: 400 })
  }
}
