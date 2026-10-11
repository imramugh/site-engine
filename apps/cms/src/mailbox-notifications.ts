import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { microsoftMailboxTarget } from './mail-provider-adapters'
import type { Payload } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
export type NotificationFetcher = (url: string, init: RequestInit) => Promise<Response>
export type GoogleJWKSResolver = JWTVerifyGetKey
const internal = { mailboxInternal: true }; const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const graphURL = 'https://graph.microsoft.com/v1.0/subscriptions'; const maxBearerBytes = 16 * 1024; const maxProviderBytes = 64 * 1024; const renewalLeadMS = 10 * 60_000
const googleJWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 5_000 })
const bounded = async (request: Request, limit = 64 * 1024) => { const reader = request.body?.getReader(); if (!reader) throw new Error('notification_invalid'); const chunks: Uint8Array[] = []; let size = 0; try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('notification_invalid') }; chunks.push(next.value) } } finally { reader.releaseLock() }; return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as Record<string, unknown> }
const boundedResponse = async (response: Response) => { const reader = response.body?.getReader(); if (!reader) throw new Error('notification_unavailable'); const chunks: Uint8Array[] = []; let size = 0; try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maxProviderBytes) { await reader.cancel(); throw new Error('notification_unavailable') }; chunks.push(part.value) } } finally { reader.releaseLock() }; const value = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('notification_unavailable'); return value as Record<string, unknown> }
const safeEqual = (left: string, right: string) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
/** App-only credentials rotate; delegated subscriptions are bound to the mailbox, not refresh-token ciphertext. */
export const notificationCredentialRevision = (mailbox: { id?: unknown; connectionMode?: unknown; credentialRevision?: unknown }) => mailbox.connectionMode === 'app-only' ? String(mailbox.credentialRevision ?? '') : hash('delegated:' + String(mailbox.id ?? '')).slice(0, 32)
export async function scheduleMailboxNotification(payload: Payload, provider: 'microsoft' | 'google', mailboxID: string, revision: string, notificationID: string, lifecycle?: string, subscriptionID?: string) {
  return withPayloadTransaction(payload, async req => {
    req.context = { ...req.context, ...internal }
    const mailbox = await payload.findByID({ collection: 'mailbox-configurations', id: mailboxID, depth: 0, overrideAccess: true, req })
    if (mailbox.provider !== provider || mailbox.health !== 'connected' || notificationCredentialRevision(mailbox) !== revision) throw new Error('notification_invalid')
    const found = await payload.find({ collection: 'mailbox-notifications', where: { mailbox: { equals: mailboxID } }, limit: 1, depth: 0, overrideAccess: true, req })
    const current = found.docs[0]
    if (!current || current.provider !== provider || current.credentialRevision !== revision || current.status !== 'active' || !current.subscriptionID || (subscriptionID && current.subscriptionID !== subscriptionID) || !Number.isFinite(Date.parse(current.expiresAt ?? '')) || Date.parse(current.expiresAt!) <= Date.now()) throw new Error('notification_invalid')
    if (notificationID && current.replayKey === notificationID) return false
    const needsRenewal = ['missed', 'subscriptionRemoved', 'reauthorizationRequired'].includes(lifecycle ?? '')
    await payload.update({ collection: 'mailbox-notifications', id: current.id, data: {
      lastNotificationAt: new Date().toISOString(), ...(notificationID ? { replayKey: notificationID } : {}),
      ...(needsRenewal ? { status: 'expired', expiresAt: new Date(0).toISOString(), nextRenewAttemptAt: null, failureCode: 'graph_lifecycle' } : {}),
    }, overrideAccess: true, req })
    await payload.update({ collection: 'mailbox-configurations', id: mailboxID, data: { inboundNextAttemptAt: new Date().toISOString() }, overrideAccess: true, req })
    return true
  })
}

export async function receiveMicrosoftNotification(payload: Payload, request: Request) {
  const headers = { 'cache-control': 'no-store' }
  const validation = new URL(request.url).searchParams.get('validationToken')
  if (validation !== null) return validation.length > 0 && validation.length <= 4096 ? new Response(validation, { headers: { ...headers, 'content-type': 'text/plain' } }) : new Response(null, { status: 400, headers })
  try {
    const body = await bounded(request)
    const values = Array.isArray(body.value) ? body.value : []
    if (!values.length || values.length > 20) throw new Error('notification_invalid')
    for (const item of values) {
      const value = item as Record<string, unknown>
      if (!value || typeof value.subscriptionId !== 'string' || value.subscriptionId.length > 500 || typeof value.clientState !== 'string' || value.clientState.length > 128) throw new Error('notification_invalid')
      const found = await payload.find({ collection: 'mailbox-notifications', where: { and: [{ subscriptionID: { equals: value.subscriptionId } }, { provider: { equals: 'microsoft' } }] }, limit: 1, depth: 0, overrideAccess: true })
      const row = found.docs[0]
      if (!row?.clientStateHash || !safeEqual(hash(value.clientState), row.clientStateHash)) throw new Error('notification_invalid')
      const id = typeof row.mailbox === 'string' ? row.mailbox : row.mailbox.id
      const replay = typeof value.id === 'string' && value.id ? hash(value.subscriptionId + ':' + value.id) : ''
      await scheduleMailboxNotification(payload, 'microsoft', id, row.credentialRevision, replay, typeof value.lifecycleEvent === 'string' ? value.lifecycleEvent : undefined, value.subscriptionId)
    }
    return new Response(null, { status: 202, headers })
  } catch { return new Response(null, { status: 400, headers }) }
}
export type GoogleJWTVerify = (token: string) => Promise<void>
export function googleJWTVerifier(resolver: GoogleJWKSResolver = googleJWKS): GoogleJWTVerify | undefined {
  const audience = process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE; const email = process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT
  if (!audience || !email) return undefined
  return async token => { if (Buffer.byteLength(token) > maxBearerBytes) throw new Error('notification_invalid'); const verified = await jwtVerify(token, resolver, { audience, issuer: ['https://accounts.google.com', 'accounts.google.com'], algorithms: ['RS256'] }); const claim = verified.payload; const now = Math.floor(Date.now() / 1000); if (claim.email !== email || claim.email_verified !== true || typeof claim.exp !== 'number' || typeof claim.iat !== 'number' || claim.exp <= now || claim.iat > now + 60) throw new Error('notification_invalid') }
}
export async function receiveGoogleNotification(payload: Payload, request: Request, verify = googleJWTVerifier()) {
  try { const authorization = request.headers.get('authorization'); if (!verify || !authorization?.startsWith('Bearer ') || Buffer.byteLength(authorization) > maxBearerBytes + 7) throw new Error(); await verify(authorization.slice(7)); const body = await bounded(request); const message = body.message as Record<string, unknown> | undefined; if (!message || typeof message.messageId !== 'string' || !message.messageId || message.messageId.length > 128 || typeof message.data !== 'string' || message.data.length > 64 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data) || message.data.length % 4 === 1) throw new Error(); const expectedSubscription = process.env.MAILBOX_GOOGLE_PUBSUB_SUBSCRIPTION; if (expectedSubscription && body.subscription !== expectedSubscription) throw new Error(); const decodedRaw = Buffer.from(message.data, 'base64'); if (!decodedRaw.length || decodedRaw.length > 64 * 1024) throw new Error(); const decoded = JSON.parse(decodedRaw.toString('utf8')) as { emailAddress?: unknown }; if (typeof decoded.emailAddress !== 'string' || decoded.emailAddress.length > 320 || decoded.emailAddress.trim() !== decoded.emailAddress) throw new Error(); const rows = await payload.find({ collection: 'mailbox-configurations', where: { and: [{ primaryAddress: { equals: decoded.emailAddress.toLowerCase() } }, { provider: { equals: 'google' } }] }, limit: 1, depth: 0, overrideAccess: true }); const mailbox = rows.docs[0] as any; if (!mailbox || mailbox.provider !== 'google') throw new Error(); await scheduleMailboxNotification(payload, 'google', mailbox.id, notificationCredentialRevision(mailbox), message.messageId); return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }) } catch { return new Response(null, { status: 400, headers: { 'cache-control': 'no-store' } }) }
}
export const notificationClientState = () => randomBytes(32).toString('base64url')
const notificationURL = (provider: 'microsoft' | 'google') => { const value = process.env.PAYLOAD_PUBLIC_SERVER_URL; if (!value) throw new Error('notification_unavailable'); let url: URL; try { url = new URL(value) } catch { throw new Error('notification_unavailable') }; if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) throw new Error('notification_unavailable'); return url.origin + '/api/email-workspace/notifications/' + provider }


async function removeRemote(provider: string, subscriptionID: string | undefined, token: string, fetcher: NotificationFetcher) {
  if (provider === 'microsoft' && !subscriptionID) return
  try {
    await fetcher(provider === 'microsoft' ? `${graphURL}/${encodeURIComponent(subscriptionID!)}` : 'https://gmail.googleapis.com/gmail/v1/users/me/stop', {
      method: provider === 'microsoft' ? 'DELETE' : 'POST', headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(5_000),
    })
  } catch { /* Polling and local revocation remain authoritative. */ }
}

export async function renewMailboxNotifications(payload: Payload, mailboxID: string, accessToken: string, fetcher: NotificationFetcher = fetch, now = new Date()) {
  const at = now.getTime()
  // Serialize the local decision, but never hold a SQLite transaction during network I/O.
  const prepared = await withPayloadTransaction(payload, async req => {
    req.context = { ...req.context, ...internal }
    const mailbox = await payload.findByID({ collection: 'mailbox-configurations', id: mailboxID, depth: 0, overrideAccess: true, req }) as any
    if (mailbox.health !== 'connected' || !['microsoft', 'google'].includes(mailbox.provider)) throw new Error('notification_unavailable')
    const revision = notificationCredentialRevision(mailbox)
    const found = await payload.find({ collection: 'mailbox-notifications', where: { mailbox: { equals: mailboxID } }, limit: 1, depth: 0, overrideAccess: true, req })
    const current = found.docs[0]
    const target = microsoftMailboxTarget(mailbox)
    const resource = target ? `/users/${encodeURIComponent(target)}/messages` : '/me/messages'
    const topic = mailbox.provider === 'google' ? process.env.MAILBOX_GOOGLE_PUBSUB_TOPIC : undefined
    if (mailbox.provider === 'google' && (!topic || !/^projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(topic))) throw new Error('notification_unavailable')
    const same = current?.provider === mailbox.provider && current.credentialRevision === revision && (mailbox.provider === 'google' ? current.topic === topic : current.resource === resource)
    const live = same && current?.status === 'active' && current.subscriptionID && Number.isFinite(Date.parse(current.expiresAt ?? '')) && Date.parse(current.expiresAt!) > at
    if (live && Date.parse(current.expiresAt!) > at + renewalLeadMS) return { skip: true as const, current }
    if (same && current?.nextRenewAttemptAt && Date.parse(current.nextRenewAttemptAt) > at) throw new Error('notification_backoff')
    const patch = Boolean(live && mailbox.provider === 'microsoft' && current.clientStateHash)
    const clientState = mailbox.provider === 'microsoft' && !patch ? notificationClientState() : undefined
    // lastRenewedAt also distinguishes overlapping operations/revocation after the request.
    const attempt = new Date().toISOString()
    const data = {
      mailbox: mailboxID, provider: mailbox.provider, credentialRevision: revision,
      resource: mailbox.provider === 'microsoft' ? resource : null, topic: topic ?? null,
      status: (patch ? 'active' : 'pending') as 'active' | 'pending',
      clientStateHash: mailbox.provider === 'microsoft' ? (patch ? current!.clientStateHash : hash(clientState!)) : null,
      subscriptionID: patch ? current!.subscriptionID : null, expiresAt: patch ? current!.expiresAt : null,
      lastRenewedAt: attempt, replayKey: null, failureCode: null, nextRenewAttemptAt: null,
      renewFailureCount: same ? current?.renewFailureCount ?? 0 : 0,
    }
    const saved = current ? await payload.update({ collection: 'mailbox-notifications', id: current.id, data, overrideAccess: true, req }) : await payload.create({ collection: 'mailbox-notifications', data, overrideAccess: true, req })
    return { skip: false as const, mailbox, revision, resource, topic, current: saved, patch, clientState, attempt, oldSubscription: !patch && current?.provider === 'microsoft' ? current.subscriptionID : undefined }
  })
  if (prepared.skip) return prepared.current
  const { mailbox, revision, resource, topic, current, patch, clientState, attempt } = prepared
  let remoteID: string | undefined
  let expiredRemote = false
  try {
    if (prepared.oldSubscription) await removeRemote('microsoft', prepared.oldSubscription, accessToken, fetcher)
    const expires = new Date(at + 50 * 60_000).toISOString()
    const callback = mailbox.provider === 'microsoft' ? notificationURL('microsoft') : undefined
    const response = await fetcher(mailbox.provider === 'microsoft' ? (patch ? `${graphURL}/${encodeURIComponent(current.subscriptionID!)}` : graphURL) : 'https://gmail.googleapis.com/gmail/v1/users/me/watch', {
      method: patch ? 'PATCH' : 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(mailbox.provider === 'google' ? { topicName: topic } : patch ? { expirationDateTime: expires } : { changeType: 'created,updated', resource, notificationUrl: callback, lifecycleNotificationUrl: callback, expirationDateTime: expires, clientState }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    expiredRemote = response.status === 404 || response.status === 410
    if (!response.ok) throw new Error('notification_unavailable')
    const data = await boundedResponse(response)
    const id = mailbox.provider === 'microsoft' ? data.id : data.historyId
    if (typeof id !== 'string' || !id || id.length > 500 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('notification_unavailable')
    remoteID = id
    const expiration = mailbox.provider === 'microsoft' ? Date.parse(String(data.expirationDateTime ?? '')) : Number(data.expiration)
    if (!Number.isFinite(expiration) || expiration <= at || expiration > at + 8 * 24 * 3600_000 || (patch && id !== current.subscriptionID) || (mailbox.provider === 'microsoft' && data.resource !== undefined && data.resource !== resource)) throw new Error('notification_unavailable')
    return await withPayloadTransaction(payload, async req => {
      req.context = { ...req.context, ...internal }
      const latestMailbox = await payload.findByID({ collection: 'mailbox-configurations', id: mailboxID, depth: 0, overrideAccess: true, req })
      const latest = await payload.findByID({ collection: 'mailbox-notifications', id: current.id, depth: 0, overrideAccess: true, req })
      if (latestMailbox.health !== 'connected' || latestMailbox.provider !== mailbox.provider || notificationCredentialRevision(latestMailbox) !== revision || latest.status === 'revoked' || latest.credentialRevision !== revision || latest.lastRenewedAt !== attempt) throw new Error('notification_stale')
      return payload.update({ collection: 'mailbox-notifications', id: latest.id, data: { subscriptionID: id, status: 'active', expiresAt: new Date(expiration).toISOString(), failureCode: null, renewFailureCount: 0, nextRenewAttemptAt: null }, overrideAccess: true, req })
    })
  } catch (error) {
    if (remoteID && (!patch || remoteID !== current.subscriptionID)) await removeRemote(mailbox.provider, remoteID, accessToken, fetcher)
    await withPayloadTransaction(payload, async req => {
      req.context = { ...req.context, ...internal }
      const mailboxNow = await payload.findByID({ collection: 'mailbox-configurations', id: mailboxID, depth: 0, overrideAccess: true, req })
      const latest = await payload.findByID({ collection: 'mailbox-notifications', id: current.id, depth: 0, overrideAccess: true, req })
      if (mailboxNow.health !== 'connected' || notificationCredentialRevision(mailboxNow) !== revision || latest.status === 'revoked' || latest.credentialRevision !== revision || latest.lastRenewedAt !== attempt) return
      const failures = Math.min(Number(latest.renewFailureCount ?? 0) + 1, 12)
      const stillLive = patch && !expiredRemote && Date.parse(latest.expiresAt ?? '') > Date.now()
      await payload.update({ collection: 'mailbox-notifications', id: latest.id, data: { status: stillLive ? 'active' : 'failed', failureCode: 'renew_failed', renewFailureCount: failures, nextRenewAttemptAt: new Date(at + Math.min(3600000, 30000 * 2 ** (failures - 1))).toISOString(), ...(!stillLive ? { subscriptionID: null, expiresAt: null } : {}) }, overrideAccess: true, req })
    }).catch(() => undefined)
    throw error
  }
}

export async function revokeMailboxNotifications(payload: Payload, mailboxID: string, accessToken?: string, fetcher: NotificationFetcher = fetch) {
  const found = await payload.find({ collection: 'mailbox-notifications', where: { mailbox: { equals: mailboxID } }, limit: 1, depth: 0, overrideAccess: true })
  const row = found.docs[0]
  if (row) await payload.update({ collection: 'mailbox-notifications', id: row.id, data: { status: 'revoked', subscriptionID: null, expiresAt: null, replayKey: null, nextRenewAttemptAt: null }, overrideAccess: true, context: internal })
  if (row && accessToken) await removeRemote(row.provider, row.subscriptionID ?? undefined, accessToken, fetcher)
}
