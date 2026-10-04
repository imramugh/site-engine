import { timingSafeEqual } from 'node:crypto'

export function aiWorkerAuthorized(request: Request): boolean {
  const secret = process.env.AI_WORKER_TOKEN
  const authorization = request.headers.get('authorization')
  if (!secret || Buffer.byteLength(secret) < 32 || !authorization?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice('Bearer '.length)); const expected = Buffer.from(secret)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function aiWorkerResponse(job: unknown): Response {
  if (!job || typeof job !== 'object') return Response.json({ job: null }, { headers: { 'Cache-Control': 'no-store' } })
  const row = job as { id?: unknown; state?: unknown }
  if (typeof row.id !== 'string' || typeof row.state !== 'string') return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  return Response.json({ job: { id: row.id, state: row.state } }, { headers: { 'Cache-Control': 'no-store' } })
}
