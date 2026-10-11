import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { microsoftMailboxTarget } from './mail-provider-adapters'
import type { Payload } from 'payload'
export type NotificationFetcher = (url: string, init: RequestInit) => Promise<Response>
const internal = { mailboxInternal: true }; const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const bounded = async (request: Request, limit = 64 * 1024) => { const reader = request.body?.getReader(); if (!reader) throw new Error('notification_invalid'); const chunks: Uint8Array[] = []; let size = 0; try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('notification_invalid') }; chunks.push(next.value) } } finally { reader.releaseLock() }; return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as Record<string, unknown> }
const safeEqual = (left: string, right: string) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
export const notificationCredentialRevision = (mailbox: { id?: unknown; connectionMode?: unknown; credentialRevision?: unknown }) => mailbox.connectionMode === 'app-only' ? String(mailbox.credentialRevision ?? '') : hash('delegated:' + String(mailbox.id ?? '')).slice(0, 32)
export async function scheduleMailboxNotification(payload: Payload, provider: 'microsoft' | 'google', mailboxID: string, revision: string, notificationID: string) {
  const mailbox = await payload.findByID({ collection: 'mailbox-configurations', id: mailboxID, depth: 0, overrideAccess: true }) as any
  if (!mailbox || mailbox.provider !== provider || mailbox.health !== 'connected' || notificationCredentialRevision(mailbox) !== revision) throw new Error('notification_invalid')
  const row = await payload.find({ collection: 'mailbox-notifications' as never, where: { mailbox: { equals: mailboxID } }, limit: 1, depth: 0, overrideAccess: true }); const current = row.docs[0] as any
  if (!current || current.provider !== provider || current.credentialRevision !== revision || current.status !== 'active' || !current.subscriptionID || (notificationID && current.replayKey === notificationID)) throw new Error('notification_invalid')
  await payload.update({ collection: 'mailbox-notifications' as never, id: current.id, data: { lastNotificationAt: new Date().toISOString(), ...(notificationID ? { replayKey: notificationID.slice(0, 128) } : {}) } as never, overrideAccess: true, context: internal })
  await payload.update({ collection: 'mailbox-configurations', id: mailboxID, data: { inboundNextAttemptAt: new Date().toISOString() } as never, overrideAccess: true, context: internal })
}
export async function receiveMicrosoftNotification(payload: Payload, request: Request) {
  const validation = new URL(request.url).searchParams.get('validationToken'); if (validation) return new Response(validation, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
  try { const body = await bounded(request); const values = Array.isArray(body.value) ? body.value : []; if (values.length < 1 || values.length > 20) throw new Error(); for (const item of values) { const value = item as Record<string, unknown>; if (typeof value.subscriptionId !== 'string' || typeof value.clientState !== 'string') throw new Error(); const found = await payload.find({ collection: 'mailbox-notifications' as never, where: { subscriptionID: { equals: value.subscriptionId } }, limit: 1, depth: 0, overrideAccess: true }); const row = found.docs[0] as any; if (!row || !safeEqual(hash(value.clientState), row.clientStateHash ?? '')) throw new Error(); await scheduleMailboxNotification(payload, 'microsoft', String(typeof row.mailbox === 'string' ? row.mailbox : row.mailbox.id), row.credentialRevision, typeof value.id === 'string' && value.id ? `${value.subscriptionId}:${value.id}` : '') }; return new Response(null, { status: 202 }) } catch { return new Response(null, { status: 400 }) }
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
const notificationURL = (provider: 'microsoft' | 'google') => { const value = process.env.PAYLOAD_PUBLIC_SERVER_URL; if (!value) throw new Error('notification_unavailable'); let url: URL; try { url = new URL(value) } catch { throw new Error('notification_unavailable') }; if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) throw new Error('notification_unavailable'); return url.origin + '/api/email-workspace/notifications/' + provider }


export async function renewMailboxNotifications(payload: Payload, mailboxID: string, accessToken: string, fetcher: NotificationFetcher = fetch, now = new Date()) {
  const mailbox = await payload.findByID({ collection: 'mailbox-configurations', id: mailboxID, depth: 0, overrideAccess: true }) as any
  if (!mailbox || mailbox.health !== 'connected' || !['microsoft', 'google'].includes(mailbox.provider)) throw new Error('notification_unavailable')
  const prior = await payload.find({ collection: 'mailbox-notifications' as never, where: { mailbox: { equals: mailboxID } }, limit: 1, depth: 0, overrideAccess: true }) as any
  const current = prior.docs[0] as any; const clientState = notificationClientState(); const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }
  let response: Response; let data: any; const expires = new Date(now.getTime() + 50 * 60_000).toISOString()
  try {
    if (mailbox.provider === 'microsoft') {
      const target = microsoftMailboxTarget(mailbox); const resource = target ? `/users/${encodeURIComponent(target)}/messages` : '/me/messages'
      response = await fetcher(current?.subscriptionID ? `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(current.subscriptionID)}` : 'https://graph.microsoft.com/v1.0/subscriptions', { method: current?.subscriptionID ? 'PATCH' : 'POST', headers, body: JSON.stringify(current?.subscriptionID ? { expirationDateTime: expires } : { changeType: 'created,updated', resource, notificationUrl: notificationURL('microsoft'), expirationDateTime: expires, clientState }), redirect: 'error', signal: AbortSignal.timeout(10_000) })
    } else {
      const topic = process.env.MAILBOX_GOOGLE_PUBSUB_TOPIC; if (!topic) throw new Error('notification_unavailable')
      response = await fetcher(`https://gmail.googleapis.com/gmail/v1/users/me/watch`, { method: 'POST', headers, body: JSON.stringify({ topicName: topic }), redirect: 'error', signal: AbortSignal.timeout(10_000) })
    }
    if (!response.ok) throw new Error('notification_unavailable'); data = await response.json()
  } catch { await payload.update({ collection: 'mailbox-notifications' as never, id: current?.id, data: { status: 'failed', failureCode: 'renew_failed' } as never, overrideAccess: true, context: internal }).catch(() => undefined); throw new Error('notification_unavailable') }
  const subscriptionID = mailbox.provider === 'microsoft' ? data.id : String(data.historyId ?? '')
  const state = mailbox.provider === 'microsoft' ? (current?.clientStateHash ? '' : clientState) : ''
  if (!subscriptionID) throw new Error('notification_unavailable')
  const record = { mailbox: mailboxID, provider: mailbox.provider, credentialRevision: notificationCredentialRevision(mailbox), subscriptionID, clientStateHash: state ? hash(state) : null, resource: mailbox.provider === 'microsoft' ? `/users/${mailbox.primaryAddress}/messages` : null, topic: mailbox.provider === 'google' ? process.env.MAILBOX_GOOGLE_PUBSUB_TOPIC : null, expiresAt: mailbox.provider === 'microsoft' ? data.expirationDateTime ?? expires : new Date(Number(data.expiration ?? now.getTime() + 6 * 24 * 3600_000)).toISOString(), status: 'active', lastRenewedAt: now.toISOString(), failureCode: null }
  return current ? payload.update({ collection: 'mailbox-notifications' as never, id: current.id, data: record as never, overrideAccess: true, context: internal }) : payload.create({ collection: 'mailbox-notifications' as never, data: record as never, overrideAccess: true, context: internal })
}
export async function revokeMailboxNotifications(payload: Payload, mailboxID: string, accessToken?: string, fetcher: NotificationFetcher = fetch) {
  const found = await payload.find({ collection: 'mailbox-notifications' as never, where: { mailbox: { equals: mailboxID } }, limit: 1, depth: 0, overrideAccess: true }) as any; const row = found.docs[0] as any
  try { if (row?.provider === 'microsoft' && row.subscriptionID && accessToken) await fetcher(`https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(row.subscriptionID)}`, { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); if (row?.provider === 'google' && accessToken) await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/stop', { method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) }) } finally { if (row) await payload.update({ collection: 'mailbox-notifications' as never, id: row.id, data: { status: 'revoked', subscriptionID: null, expiresAt: null, replayKey: null } as never, overrideAccess: true, context: internal }) }
}
