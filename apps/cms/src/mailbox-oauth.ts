import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Payload } from 'payload'
import { gmailIdentity, microsoftIdentity, type Fetcher } from './mail-provider-adapters'

export type MailboxOAuthProvider = 'microsoft' | 'google'

type Settings = { clientID: string; clientSecret: string; redirectURI: string; authorize: string; token: string; scopes: string[] }

const digest = (value: string) => createHash('sha256').update(value).digest('base64url')
const maximumResponseBytes = 64 * 1024

function key() {
  const value = Buffer.from(process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY || '', 'base64url')
  if (value.length !== 32) throw new Error('Mailbox credential key unavailable.')
  return value
}

function encrypt(value: string, provider: MailboxOAuthProvider) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from(`mailbox:${provider}`))
  const body = Buffer.concat([cipher.update(value), cipher.final()])
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`
}

export function decryptMailboxOAuthCredential(value: string, provider: MailboxOAuthProvider) {
  const bytes = Buffer.from(value.slice(3), 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12))
  decipher.setAAD(Buffer.from(`mailbox:${provider}`))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()
}

export function mailboxOAuthSettings(provider: MailboxOAuthProvider): Settings | undefined {
  const prefix = `MAILBOX_${provider.toUpperCase()}`
  const clientID = process.env[`${prefix}_CLIENT_ID`]
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]
  const base = process.env.PAYLOAD_PUBLIC_SERVER_URL
  if (!clientID || !clientSecret || !base) return undefined
  let origin: URL
  try { origin = new URL(base) } catch { return undefined }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || (origin.protocol !== 'https:' && origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1')) return undefined
  if (provider === 'microsoft') return { clientID, clientSecret, redirectURI: `${origin.origin}/api/email-workspace/oauth/microsoft/callback`, authorize: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token', scopes: ['offline_access', 'User.Read', 'Mail.Read', 'Mail.Send'] }
  return { clientID, clientSecret, redirectURI: `${origin.origin}/api/email-workspace/oauth/google/callback`, authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.settings.basic'] }
}

async function tokenJSON(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('provider_rejected')
  const chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > maximumResponseBytes) throw new Error('provider_rejected'); chunks.push(item.value) } }
  finally { reader.releaseLock() }
  try { const value: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown> } catch { throw new Error('provider_rejected') }
}

export async function startMailboxOAuth(payload: Payload, provider: MailboxOAuthProvider, owner: string, sessionToken: string) {
  const settings = mailboxOAuthSettings(provider)
  if (!settings || !sessionToken) throw new Error('provider_not_configured')
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(48).toString('base64url')
  await (payload as any).create({ collection: 'mailbox-oauth-transactions', data: { provider, stateHash: digest(state), sessionHash: digest(sessionToken), verifier: encrypt(verifier, provider), owner, expiresAt: new Date(Date.now() + 600000).toISOString() }, overrideAccess: true, context: { mailboxInternal: true } })
  const url = new URL(settings.authorize)
  Object.entries({ client_id: settings.clientID, redirect_uri: settings.redirectURI, response_type: 'code', scope: settings.scopes.join(' '), state, code_challenge: digest(verifier), code_challenge_method: 'S256', ...(provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : {}) }).forEach(([name, value]) => url.searchParams.set(name, value))
  return url.toString()
}

export async function completeMailboxOAuth(payload: Payload, provider: MailboxOAuthProvider, state: string, code: string, owner: string, sessionToken: string, fetcher: Fetcher = fetch) {
  const settings = mailboxOAuthSettings(provider)
  const found = await (payload as any).find({ collection: 'mailbox-oauth-transactions', where: { stateHash: { equals: digest(state) } }, limit: 1, overrideAccess: true })
  const transaction = found.docs[0]
  const transactionOwner = typeof transaction?.owner === 'string' ? transaction.owner : transaction?.owner?.id
  if (!settings || !code || !sessionToken || !transaction || transaction.provider !== provider || transactionOwner !== owner || transaction.sessionHash !== digest(sessionToken) || transaction.consumedAt || Date.parse(transaction.expiresAt) < Date.now()) throw new Error('invalid_callback')
  const claimed = await (payload as any).update({ collection: 'mailbox-oauth-transactions', where: { and: [{ id: { equals: transaction.id } }, { consumedAt: { equals: null } }] }, data: { consumedAt: new Date().toISOString() }, overrideAccess: true, context: { mailboxInternal: true } })
  if (claimed.docs.length !== 1) throw new Error('invalid_callback')
  let response: Response
  try { response = await fetcher(settings.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: settings.redirectURI, client_id: settings.clientID, client_secret: settings.clientSecret, code_verifier: decryptMailboxOAuthCredential(transaction.verifier, provider) }), redirect: 'error', signal: AbortSignal.timeout(10_000) }) } catch { throw new Error('provider_rejected') }
  const token = await tokenJSON(response)
  if (!response.ok || typeof token.access_token !== 'string' || token.access_token.length > 16_384 || typeof token.refresh_token !== 'string' || token.refresh_token.length > 16_384) throw new Error('provider_rejected')
  const identity = await (provider === 'microsoft' ? microsoftIdentity(fetcher) : gmailIdentity(fetcher))(token.access_token)
  return (payload as any).create({ collection: 'mailbox-configurations', data: { name: `${provider} ${identity.primaryAddress}`, provider, primaryAddress: identity.primaryAddress, aliases: [], verifiedAliases: [], host: 'oauth', port: 1, security: 'tls', username: identity.primaryAddress, encryptedCredential: encrypt(JSON.stringify({ refreshToken: token.refresh_token }), provider), credentialRevision: randomBytes(8).toString('hex'), health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
}

export async function refreshMailboxOAuth(mailbox: any, fetcher: Fetcher = fetch) {
  const provider = mailbox.provider as MailboxOAuthProvider
  const settings = mailboxOAuthSettings(provider)
  if (!settings) throw new Error('provider_not_configured')
  const refreshToken = JSON.parse(decryptMailboxOAuthCredential(mailbox.encryptedCredential, provider)).refreshToken
  let response: Response
  try {
    response = await fetcher(settings.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: settings.clientID, client_secret: settings.clientSecret, scope: settings.scopes.join(' ') }), redirect: 'error', signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new Error('provider_rejected')
  }
  const value = await tokenJSON(response)
  if (!response.ok || typeof value.access_token !== 'string' || value.access_token.length < 1 || value.access_token.length > 16_384 || (value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' || value.refresh_token.length < 1 || value.refresh_token.length > 16_384))) throw new Error('provider_rejected')
  return { accessToken: value.access_token, encryptedCredential: typeof value.refresh_token === 'string' ? encrypt(JSON.stringify({ refreshToken: value.refresh_token }), provider) : undefined }
}

export async function refreshAndPersistMailboxOAuth(payload: Payload, mailbox: any, fetcher: Fetcher = fetch) {
  const refreshed = await refreshMailboxOAuth(mailbox, fetcher)
  if (!refreshed.encryptedCredential) return { ...refreshed, credentialRevision: mailbox.credentialRevision }
  const saved = await (payload as any).update({ collection: 'mailbox-configurations', where: { and: [{ id: { equals: mailbox.id } }, { credentialRevision: { equals: mailbox.credentialRevision } }] }, data: { encryptedCredential: refreshed.encryptedCredential, credentialRevision: randomBytes(8).toString('hex') }, overrideAccess: true, context: { mailboxInternal: true } })
  if (saved.docs.length !== 1) throw new Error('credential_changed')
  return { ...refreshed, credentialRevision: saved.docs[0].credentialRevision }
}
