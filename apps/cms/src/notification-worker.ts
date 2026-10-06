import { timingSafeEqual } from 'node:crypto'

export function notificationWorkerAuthorized(request: Request): boolean {
  const secret = process.env.NOTIFICATION_WORKER_TOKEN
  const authorization = request.headers.get('authorization')
  if (!secret || Buffer.byteLength(secret) < 32 || !authorization?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(authorization.slice(7)); const expected = Buffer.from(secret)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function createNotificationWorkerRunHandler(dependencies: { payload: () => Promise<any>; run: (payload: any) => Promise<{ id: string; state: string } | null> }) {
  return async (request: Request): Promise<Response> => {
    if (!notificationWorkerAuthorized(request)) return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
    try {
      const delivery = await dependencies.run(await dependencies.payload())
      return Response.json({ delivery: delivery ? { id: delivery.id, state: delivery.state } : null }, { headers: { 'Cache-Control': 'no-store' } })
    } catch { return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
  }
}
