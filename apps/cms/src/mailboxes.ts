import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import nodemailer from 'nodemailer'
import type { Payload, PayloadRequest } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
import { gmailAdapter, gmailIdentity, microsoftAdapter, microsoftIdentity, type Fetcher } from './mail-provider-adapters'
import { mailboxOAuthSettings, refreshAndPersistMailboxOAuth } from './mailbox-oauth'

export const mailboxAreas = ['leads', 'careers', 'notifications'] as const
export type MailboxArea = (typeof mailboxAreas)[number]
export type MailboxSecurity = 'starttls' | 'tls'
export type SMTPConfiguration = { id?: string; name: string; primaryAddress: string; aliases: string[]; host: string; port: number; security: MailboxSecurity; username: string; password?: string }
type StoredMailbox = Record<string, unknown> & { id: string; encryptedCredential?: string | null }
type Transport = { verify(): Promise<unknown>; sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }> }

const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const hostname = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const normalizedEmail = (value: string) => value.trim().toLowerCase()
const relationID = (value: unknown) => typeof value === 'string' ? value : String((value as { id?: string } | null)?.id ?? '')
const requestHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function key() {
  const encoded = process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY; if (!encoded) throw new Error('INTEGRATION_CREDENTIAL_ENCRYPTION_KEY is required for mailbox credentials.')
  const value = Buffer.from(encoded, 'base64url'); if (value.length !== 32) throw new Error('INTEGRATION_CREDENTIAL_ENCRYPTION_KEY must be a 32-byte base64url value.')
  return value
}
function encryptPassword(value: string) {
  if (!value || Buffer.byteLength(value) > 16_384) throw new Error('SMTP password must contain 1 to 16384 bytes.')
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv); cipher.setAAD(Buffer.from('mailbox:smtp'))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
}
function decryptPassword(value: string) {
  if (!value.startsWith('v1.')) throw new Error('SMTP credential envelope is invalid.')
  const bytes = Buffer.from(value.slice(3), 'base64url'); if (bytes.length < 29) throw new Error('SMTP credential envelope is invalid.')
  const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12)); decipher.setAAD(Buffer.from('mailbox:smtp')); decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
}

function validated(input: SMTPConfiguration, existing?: StoredMailbox) {
  const name = input.name.trim(); const primaryAddress = normalizedEmail(input.primaryAddress); const host = input.host.trim().toLowerCase(); const username = input.username.trim()
  const aliases = [...new Set(input.aliases.map(normalizedEmail))].filter((alias) => alias !== primaryAddress)
  if (!name || name.length > 120 || !email.test(primaryAddress) || aliases.length > 20 || aliases.some((alias) => !email.test(alias)) || (!hostname.test(host) && !isIP(host)) || !Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535 || !['starttls', 'tls'].includes(input.security) || !username || username.length > 320 || (!existing?.encryptedCredential && !input.password)) throw new Error('Mailbox configuration is invalid.')
  return { name, primaryAddress, aliases, host, port: input.port, security: input.security, username }
}

export function isPublicSMTPAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false
  let parsed = ipaddr.parse(address)
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address()
  return parsed.range() === 'unicast'
}
async function smtpTransport(mailbox: StoredMailbox): Promise<Transport> {
  const allowLoopback = process.env.NODE_ENV === 'test' && process.env.MAIL_TEST_SMTP_LOOPBACK === '1'
  const resolved = await lookup(String(mailbox.host), { all: true }); const selected = resolved.find((entry) => allowLoopback || isPublicSMTPAddress(entry.address))
  if (!selected) throw new Error('smtp_target_rejected')
  return nodemailer.createTransport({ host: selected.address, port: Number(mailbox.port), secure: mailbox.security === 'tls', requireTLS: mailbox.security === 'starttls' && !allowLoopback, ignoreTLS: allowLoopback, tls: { servername: String(mailbox.host), rejectUnauthorized: true }, auth: { user: String(mailbox.username), pass: decryptPassword(String(mailbox.encryptedCredential)) }, connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 10_000, disableFileAccess: true, disableUrlAccess: true }) as Transport
}

const internal = (req: PayloadRequest) => { req.context.mailboxInternal = true; return req }
export function publicMailbox(doc: StoredMailbox) {
  const provider = doc.provider === 'microsoft' || doc.provider === 'google' ? doc.provider : 'smtp'
  const base = { id: doc.id, name: doc.name, provider, primaryAddress: doc.primaryAddress, aliases: Array.isArray(doc.aliases) ? doc.aliases : [], verifiedAliases: Array.isArray(doc.verifiedAliases) ? doc.verifiedAliases : [], health: doc.health ?? 'unknown', testedAt: doc.testedAt ?? null, credentialConfigured: Boolean(doc.encryptedCredential), credentialHint: doc.credentialRevision ? `configured • ${doc.credentialRevision}` : null }
  return provider === 'smtp' ? { ...base, host: doc.host, port: doc.port, security: doc.security, username: doc.username } : base
}

export async function configureSMTPMailbox(payload: Payload, input: SMTPConfiguration, actor: string) {
  return withPayloadTransaction(payload, async (transaction) => {
    const req = internal(transaction); const existing = input.id ? await payload.findByID({ collection: 'mailbox-configurations', id: input.id, depth: 0, overrideAccess: true, req }) as unknown as StoredMailbox : undefined
    const config = validated(input, existing); const password = input.password || (existing?.encryptedCredential ? decryptPassword(existing.encryptedCredential) : '')
    const transportChanged = Boolean(existing && (String(existing.host) !== config.host || Number(existing.port) !== config.port || String(existing.security) !== config.security || String(existing.username) !== config.username))
    const verifiedAliases = !transportChanged && Array.isArray(existing?.verifiedAliases) ? existing.verifiedAliases.map(String).filter((alias) => config.aliases.includes(alias)) : []
    if (existing) {
      const mappings = await payload.find({ collection: 'mailbox-area-mappings', where: { mailbox: { equals: existing.id } }, limit: mailboxAreas.length, depth: 0, overrideAccess: true, req })
      const allowed = [config.primaryAddress, ...verifiedAliases]
      if (mappings.docs.some((mapping) => !allowed.includes(String(mapping.senderAddress)))) throw new Error('Unassign this mailbox sender before removing or changing its address.')
    }
    const credentialRevision = input.password ? randomBytes(8).toString('hex') : String(existing?.credentialRevision || randomBytes(8).toString('hex'))
    const data = { ...config, verifiedAliases, provider: 'smtp' as const, encryptedCredential: encryptPassword(password), credentialRevision, health: 'unknown' as const, testedAt: null }
    const saved = existing ? await payload.update({ collection: 'mailbox-configurations', id: existing.id, data, overrideAccess: true, req }) : await payload.create({ collection: 'mailbox-configurations', data, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: existing ? 'mailbox.configuration_updated' : 'mailbox.configuration_created', user: actor, actor, detail: { mailbox: (saved as { id: string }).id, provider: 'smtp', credentialRevision } }, overrideAccess: true, req })
    return saved
  })
}

export async function testSMTPMailbox(payload: Payload, id: string, actor: string) {
  const mailbox = await payload.findByID({ collection: 'mailbox-configurations', id, depth: 0, overrideAccess: true }) as unknown as StoredMailbox
  let health: 'connected' | 'rejected' | 'unavailable' = 'unavailable'
  try { await (await smtpTransport(mailbox)).verify(); health = 'connected' } catch (error) { health = error instanceof Error && /auth|credential|535/i.test(error.message) ? 'rejected' : 'unavailable' }
  return withPayloadTransaction(payload, async (transaction) => { const req = internal(transaction); const saved = await payload.update({ collection: 'mailbox-configurations', id, data: { health, testedAt: new Date().toISOString() }, overrideAccess: true, req }); await payload.create({ collection: 'audit-events', data: { event: 'mailbox.connection_tested', user: actor, actor, detail: { mailbox: id, health } }, overrideAccess: true, req }); return saved })
}

export async function setMailboxArea(payload: Payload, input: { area: MailboxArea; mailbox: string; senderAddress: string }, actor: string) {
  if (!mailboxAreas.includes(input.area) || !uuid.test(input.mailbox)) throw new Error('Mailbox mapping is invalid.')
  const mailbox = await payload.findByID({ collection: 'mailbox-configurations', id: input.mailbox, depth: 0, overrideAccess: true }) as unknown as StoredMailbox; const senderAddress = normalizedEmail(input.senderAddress)
  if (![String(mailbox.primaryAddress), ...(Array.isArray(mailbox.verifiedAliases) ? mailbox.verifiedAliases.map(String) : [])].includes(senderAddress)) throw new Error('Sender address has not been verified on this mailbox.')
  return withPayloadTransaction(payload, async (transaction) => { const req = internal(transaction); const current = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: input.area } }, limit: 1, depth: 0, overrideAccess: true, req }); const saved = current.docs[0] ? await payload.update({ collection: 'mailbox-area-mappings', id: current.docs[0].id, data: { mailbox: input.mailbox, senderAddress }, overrideAccess: true, req }) : await payload.create({ collection: 'mailbox-area-mappings', data: { area: input.area, mailbox: input.mailbox, senderAddress }, overrideAccess: true, req }); await payload.create({ collection: 'audit-events', data: { event: 'mailbox.area_mapped', user: actor, actor, detail: { area: input.area, mailbox: input.mailbox, senderAddress } }, overrideAccess: true, req }); return saved })
}

export async function clearMailboxArea(payload: Payload, area: MailboxArea, actor: string) {
  if (!mailboxAreas.includes(area)) throw new Error('Mailbox mapping is invalid.')
  return withPayloadTransaction(payload, async (transaction) => {
    const req = internal(transaction)
    const current = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: area } }, limit: 1, depth: 0, overrideAccess: true, req })
    if (current.docs[0]) await payload.delete({ collection: 'mailbox-area-mappings', id: current.docs[0].id, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'mailbox.area_unmapped', user: actor, actor, detail: { area, mapping: current.docs[0]?.id ?? null } }, overrideAccess: true, req })
  })
}

/** The single outbound seam used by reply workflows.  OAuth providers plug in
 * here with the same mailbox-scoped contract; SMTP remains the deterministic
 * fallback and is deliberately the only provider persisted until tenant OAuth
 * credentials are configured. */
export type AreaMailMessage = {
  sender: string
  recipient: string
  subject: string
  body: string
  /** A local draft thread ID is only meaningful to SMTP. */
  threadID?: string
  /** Provider IDs are persisted by mailbox sync and required for replies. */
  providerThreadID?: string
  providerMessageID?: string
  providerMailboxID?: string
  provider?: 'microsoft' | 'google'
  providerTarget?: { collection: 'inquiries' | 'applications'; id: string }
  providerRFCMessageID?: string
  providerRFCReferences?: string
  providerSubject?: string
}

async function currentAreaMailbox(payload: Payload, area: MailboxArea) {
  const mapping = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: area } }, limit: 1, depth: 0, overrideAccess: true })
  if (!mapping.docs[0]) throw new Error('mailbox_not_configured')
  const mailboxID = relationID(mapping.docs[0].mailbox)
  const mailbox = await payload.findByID({ collection: 'mailbox-configurations', id: mailboxID, depth: 0, overrideAccess: true }) as unknown as StoredMailbox
  return { mapping: mapping.docs[0], mailboxID, mailbox }
}

async function groundedProviderThread(payload: Payload, message: AreaMailMessage, mailbox: StoredMailbox) {
  if (!message.threadID) return
  if (!message.providerThreadID || !message.providerMessageID || !message.providerMailboxID || !message.provider || !message.providerTarget || message.providerMailboxID !== mailbox.id || message.provider !== mailbox.provider) throw new Error('mailbox_thread_not_grounded')
  const targetField = message.providerTarget.collection === 'inquiries' ? 'lead' : 'application'
  const thread = await payload.find({ collection: 'mail-threads', where: { and: [{ mailbox: { equals: mailbox.id } }, { provider: { equals: message.provider } }, { providerConversationID: { equals: message.providerThreadID } }, { [targetField]: { equals: message.providerTarget.id } }] }, limit: 1, depth: 0, overrideAccess: true })
  if (!thread.docs[0]) throw new Error('mailbox_thread_not_grounded')
  const linked = await payload.find({ collection: 'mail-thread-messages', where: { and: [{ thread: { equals: thread.docs[0].id } }, { mailbox: { equals: mailbox.id } }, { providerMessageID: { equals: message.providerMessageID } }] }, limit: 1, depth: 0, overrideAccess: true })
  if (!linked.docs[0] || (message.provider === 'google' && (message.subject !== message.providerSubject || message.providerSubject !== linked.docs[0].subject || !message.providerRFCMessageID || message.providerRFCMessageID !== linked.docs[0].rfcMessageID || (message.providerRFCReferences ?? undefined) !== (linked.docs[0].rfcReferences ?? undefined)))) throw new Error('mailbox_thread_not_grounded')
}

export async function sendAreaMail(
  payload: Payload,
  area: MailboxArea,
  message: AreaMailMessage,
  fetcher: Fetcher = fetch,
) {
  const initial = await currentAreaMailbox(payload, area)
  const { mailboxID, mailbox } = initial
  if (mailbox.health !== 'connected' || normalizedEmail(message.sender) !== normalizedEmail(String(initial.mapping.senderAddress))) throw new Error('mailbox_not_ready')

  if (mailbox.provider === 'smtp') {
    const result = await (await smtpTransport(mailbox)).sendMail({ from: message.sender, to: message.recipient, subject: message.subject, text: message.body, headers: message.threadID ? { 'In-Reply-To': message.threadID } : undefined })
    return { provider: 'smtp' as const, messageID: result.messageId?.slice(0, 500) ?? null }
  }

  if (mailbox.provider !== 'microsoft' && mailbox.provider !== 'google') throw new Error('mailbox_not_ready')
  await groundedProviderThread(payload, message, mailbox)

  const refreshed = await refreshAndPersistMailboxOAuth(payload, mailbox, fetcher)
  const identity = await (mailbox.provider === 'microsoft' ? microsoftIdentity(fetcher) : gmailIdentity(fetcher))(refreshed.accessToken)
  if (!identity.verifiedSenders.map(normalizedEmail).includes(normalizedEmail(message.sender))) throw new Error('mailbox_sender_not_verified')
  const final = await currentAreaMailbox(payload, area)
  if (final.mailboxID !== mailboxID || final.mailbox.provider !== mailbox.provider || final.mailbox.health !== 'connected' || final.mailbox.credentialRevision !== refreshed.credentialRevision || normalizedEmail(message.sender) !== normalizedEmail(String(final.mapping.senderAddress))) throw new Error('mailbox_not_ready')
  await groundedProviderThread(payload, message, final.mailbox)

  const envelope = {
    sender: message.sender,
    recipient: message.recipient,
    subject: message.subject,
    body: message.body,
    ...(mailbox.provider === 'microsoft' && message.providerMessageID ? { replyMessageID: message.providerMessageID } : {}),
    ...(mailbox.provider === 'google' && message.providerRFCMessageID ? { rfcMessageID: message.providerRFCMessageID, ...(message.providerRFCReferences ? { rfcReferences: message.providerRFCReferences } : {}) } : {}),
    ...(mailbox.provider === 'google' && message.providerThreadID ? { threadID: message.providerThreadID } : {}),
  }
  const result = await (mailbox.provider === 'microsoft'
    ? microsoftAdapter(fetcher, message.sender).send(refreshed.accessToken, envelope)
    : gmailAdapter(fetcher, message.sender).send(refreshed.accessToken, envelope))
  return { provider: mailbox.provider, messageID: 'id' in result ? result.id : null }
}

const sendLocks = new Map<string, Promise<void>>()
async function exclusively<T>(key: string, operation: () => Promise<T>) { const previous = sendLocks.get(key) ?? Promise.resolve(); let release: () => void = () => undefined; const current = new Promise<void>((resolve) => { release = resolve }); sendLocks.set(key, current); await previous; try { return await operation() } finally { release(); if (sendLocks.get(key) === current) sendLocks.delete(key) } }
export async function sendAuthorizedMailboxTest(payload: Payload, input: { requestKey: string; mailbox: string; senderAddress: string; recipientAddress: string; subject: string; body: string; confirmed: boolean }, actor: string) {
  if (!uuid.test(input.requestKey) || !uuid.test(input.mailbox) || input.confirmed !== true || !email.test(normalizedEmail(input.recipientAddress)) || !input.subject.trim() || input.subject.length > 200 || !input.body.trim() || input.body.length > 10_000) throw new Error('Explicit confirmation of a valid test message is required.')
  return exclusively(input.requestKey, async () => {
    const exact = { mailbox: input.mailbox, senderAddress: normalizedEmail(input.senderAddress), recipientAddress: normalizedEmail(input.recipientAddress), subject: input.subject.trim(), body: input.body.trim() }; const digest = requestHash(exact)
    const prior = await payload.find({ collection: 'mailbox-test-sends', where: { requestKey: { equals: input.requestKey } }, limit: 1, depth: 0, overrideAccess: true }); if (prior.docs[0]) { if (prior.docs[0].requestHash !== digest) throw new Error('Test-send request key was already used for different content.'); return prior.docs[0] }
    const mailbox = await payload.findByID({ collection: 'mailbox-configurations', id: input.mailbox, depth: 0, overrideAccess: true }) as unknown as StoredMailbox; if (mailbox.health !== 'connected') throw new Error('Mailbox connection must be tested before sending.')
    if (![String(mailbox.primaryAddress), ...(Array.isArray(mailbox.aliases) ? mailbox.aliases.map(String) : [])].includes(exact.senderAddress)) throw new Error('Sender address is not configured on this mailbox.')
    const claim = await withPayloadTransaction(payload, async (transaction) => { const req = internal(transaction); const created = await payload.create({ collection: 'mailbox-test-sends', data: { requestKey: input.requestKey, requestHash: digest, mailbox: input.mailbox, senderAddress: exact.senderAddress, recipientAddress: exact.recipientAddress, authorizedBy: actor, state: 'sending' }, overrideAccess: true, req }); await payload.create({ collection: 'audit-events', data: { event: 'mailbox.test_send_authorized', user: actor, actor, detail: { mailbox: input.mailbox, testSend: created.id, requestHash: digest } }, overrideAccess: true, req }); return created })
    try {
      const result = await (await smtpTransport(mailbox)).sendMail({ from: exact.senderAddress, to: exact.recipientAddress, subject: exact.subject, text: exact.body })
      return withPayloadTransaction(payload, async (transaction) => {
        const req = internal(transaction)
        const sent = await payload.update({ collection: 'mailbox-test-sends', id: claim.id, data: { state: 'sent', providerMessageID: result.messageId?.slice(0, 500) }, overrideAccess: true, req })
        const aliases = Array.isArray(mailbox.aliases) ? mailbox.aliases.map(String) : []
        const verified = Array.isArray(mailbox.verifiedAliases) ? mailbox.verifiedAliases.map(String) : []
        if (aliases.includes(exact.senderAddress) && !verified.includes(exact.senderAddress)) {
          await payload.update({ collection: 'mailbox-configurations', id: mailbox.id, data: { verifiedAliases: [...verified, exact.senderAddress] }, overrideAccess: true, req })
        }
        await payload.create({ collection: 'audit-events', data: { event: 'mailbox.test_send_completed', user: actor, actor, detail: { mailbox: input.mailbox, testSend: claim.id, state: 'sent', senderVerified: exact.senderAddress } }, overrideAccess: true, req })
        return sent
      })
    } catch {
      await withPayloadTransaction(payload, async (transaction) => {
        const req = internal(transaction)
        await payload.update({ collection: 'mailbox-test-sends', id: claim.id, data: { state: 'failed', failureCode: 'provider_unavailable' }, overrideAccess: true, req })
        await payload.create({ collection: 'audit-events', data: { event: 'mailbox.test_send_completed', user: actor, actor, detail: { mailbox: input.mailbox, testSend: claim.id, state: 'failed' } }, overrideAccess: true, req })
      })
      throw new Error('SMTP test message could not be delivered.')
    }
  })
}

export async function mailboxWorkspace(payload: Payload) {
  const [mailboxes, mappings] = await Promise.all([payload.find({ collection: 'mailbox-configurations', limit: 100, sort: 'name', depth: 0, overrideAccess: true }), payload.find({ collection: 'mailbox-area-mappings', limit: 3, sort: 'area', depth: 0, overrideAccess: true })])
  const provider = (name: 'microsoft' | 'google') => { const configured = Boolean(mailboxOAuthSettings(name)); const connected = mailboxes.docs.some((item) => item.provider === name && item.health === 'connected'); return connected ? { status: 'connected' } : configured ? { status: 'available' } : { status: 'unconfigured', setupMessage: 'Configure the mailbox OAuth client ID and secret before connecting.' } }
  return { providers: { microsoft: provider('microsoft'), google: provider('google'), smtp: { status: mailboxes.docs.some((item) => item.provider === 'smtp' && item.health === 'connected') ? 'connected' : mailboxes.docs.some((item) => item.provider === 'smtp') ? 'configured' : 'available' } }, mailboxes: mailboxes.docs.map((item) => publicMailbox(item as unknown as StoredMailbox)), mappings: mappings.docs.map((item) => ({ id: item.id, area: item.area, mailbox: relationID(item.mailbox), senderAddress: item.senderAddress })) }
}
