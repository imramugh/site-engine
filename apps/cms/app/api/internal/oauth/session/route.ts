import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { handleOAuthSessionBridge } from '../../../../../src/oauth-session-bridge'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleOAuthSessionBridge(request, await getPayload({ config }))
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}

export async function GET(): Promise<Response> {
  return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { 'cache-control': 'no-store' } })
}
