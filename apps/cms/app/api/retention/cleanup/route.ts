import { timingSafeEqual } from 'node:crypto'
import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { runRetentionCleanup } from '../../../../src/retention'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../../src/sqlite'

export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  const token = process.env.RETENTION_WORKER_TOKEN
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token || !supplied || Buffer.byteLength(token) !== Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(token), Buffer.from(supplied))) return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  try { const payload = await getPayload({ config }); return Response.json(await runRetentionCleanup(payload), { headers: { 'Cache-Control': 'no-store' } }) }
  catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, { 'Cache-Control': 'no-store' }) ?? Response.json({ error: 'Retention cleanup is unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
}
