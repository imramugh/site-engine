import { timingSafeEqual } from 'node:crypto'
import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { runRetentionCleanup } from '../../../../src/retention'

export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  const token = process.env.RETENTION_WORKER_TOKEN
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token || !supplied || token.length !== supplied.length || !timingSafeEqual(Buffer.from(token), Buffer.from(supplied))) return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  const payload = await getPayload({ config })
  return Response.json(await runRetentionCleanup(payload), { headers: { 'Cache-Control': 'no-store' } })
}
