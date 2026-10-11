import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Payload } from 'payload'
export type NotificationFetcher = (url: string, init: RequestInit) => Promise<Response>
const internal = { mailboxInternal: true }; const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const bounded = async (request: Request, limit = 64 * 1024) => { const text = await request.text(); if (Buffer.byteLength(text) > limit) throw new Error('notification_invalid'); return JSON.parse(text) as Record<string, unknown> }
const safeEqual = (left: string, right: string) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
export async function scheduleMailboxNotification(payload: Payload, provider: 'microsoft' | 'google', mailboxID: string, revision: string, notificationID: string) {
  const row = await payload.find({ collection: 'mailbox-notifications' as never, where: { mailbox: { equals: mailboxID } }, limit: 1, depth: 0, overrideAccess: true }); const current = row.docs[0] as any
  if (!current || current.provider !== provider || current.credentialRevision !== revision || current.status !== 'active' || !current.subscriptionID || current.replayKey === notificationID) throw new Error('notification_invalid')
  await payload.update({ collection: 'mailbox-notifications' as never, id: current.id, data: { lastNotificationAt: new Date().toISOString(), replayKey: notificationID.slice(0, 128) } as never, overrideAccess: true, context: internal })
  await payload.update({ collection: 'mailbox-configurations', id: mailboxID, data: { inboundNextAttemptAt: new Date().toISOString() } as never, overrideAccess: true, context: internal })
}
export async function receiveMicrosoftNotification(payload: Payload, request: Request) {
  const validation = new URL(request.url).searchParams.get('validationToken'); if (validation) return new Response(validation, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
  try { const body = await bounded(request); const values = Array.isArray(body.value) ? body.value : []; if (values.length < 1 || values.length > 20) throw new Error(); for (const item of values) { const value = item as Record<string, unknown>; if (typeof value.subscriptionId !== 'string' || typeof value.clientState !== 'string') throw new Error(); const found = await payload.find({ collection: 'mailbox-notifications' as never, where: { subscriptionID: { equals: value.subscriptionId } }, limit: 1, depth: 0, overrideAccess: true }); const row = found.docs[0] as any; if (!row || !safeEqual(hash(value.clientState), row.clientStateHash ?? '')) throw new Error(); await scheduleMailboxNotification(payload, 'microsoft', String(typeof row.mailbox === 'string' ? row.mailbox : row.mailbox.id), row.credentialRevision, `${value.subscriptionId}:${String(value.id ?? '')}`) }; return new Response(null, { status: 202 }) } catch { return new Response(null, { status: 400 }) }
}
export type GoogleJWTVerify = (token: string) => Promise<void>
export function googleJWTVerifier(): GoogleJWTVerify | undefined {
  const audience = process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE; const email = process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT
  if (!audience || !email) return undefined
  const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 5_000 })
  return async token => { const verified = await jwtVerify(token, keys, { audience, issuer: ['https://accounts.google.com', 'accounts.google.com'], algorithms: ['RS256'] }); if (verified.payload.email !== email || verified.payload.email_verified !== true) throw new Error('notification_invalid') }
}
export async function receiveGoogleNotification(payload: Payload, request: Request, verify = googleJWTVerifier()) {
  try { const authorization = request.headers.get('authorization'); if (!verify || !authorization?.startsWith('Bearer ')) throw new Error(); await verify(authorization.slice(7)); const body = await bounded(request); const message = body.message as Record<string, unknown> | undefined; if (!message || typeof message.messageId !== 'string' || typeof message.data !== 'string') throw new Error(); const decoded = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8')) as { emailAddress?: unknown }; if (typeof decoded.emailAddress !== 'string') throw new Error(); const rows = await payload.find({ collection: 'mailbox-configurations', where: { primaryAddress: { equals: decoded.emailAddress.toLowerCase() } }, limit: 1, depth: 0, overrideAccess: true }); const mailbox = rows.docs[0] as any; if (!mailbox) throw new Error(); await scheduleMailboxNotification(payload, 'google', mailbox.id, mailbox.credentialRevision, message.messageId); return new Response(null, { status: 204 }) } catch { return new Response(null, { status: 400 }) }
}
export const notificationClientState = () => randomBytes(32).toString('base64url')
