import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import nodemailer from 'nodemailer'
import type { Payload, PayloadRequest } from 'payload'
import { withPayloadTransaction } from './auth-transaction'

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

const privateAddress = (address: string) => address === '::1' || address === '0.0.0.0' || address.startsWith('127.') || address.startsWith('10.') || address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address) || /^169\.254\./.test(address) || /^f[cd][0-9a-f]{2}:/i.test(address) || /^fe[89ab][0-9a-f]:/i.test(address)
async function smtpTransport(mailbox: StoredMailbox): Promise<Transport> {
  const allowLoopback = process.env.NODE_ENV === 'test' && process.env.MAIL_TEST_SMTP_LOOPBACK === '1'
  const resolved = await lookup(String(mailbox.host), { all: true }); const selected = resolved.find((entry) => allowLoopback || !privateAddress(entry.address))
  if (!selected) throw new Error('smtp_target_rejected')
  return nodemailer.createTransport({ host: selected.address, port: Number(mailbox.port), secure: mailbox.security === 'tls', requireTLS: mailbox.security === 'starttls' && !allowLoopback, ignoreTLS: allowLoopback, tls: { servername: String(mailbox.host), rejectUnauthorized: true }, auth: { user: String(mailbox.username), pass: decryptPassword(String(mailbox.encryptedCredential)) }, connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 10_000, disableFileAccess: true, disableUrlAccess: true }) as Transport
}

const internal = (req: PayloadRequest) => { req.context.mailboxInternal = true; return req }
export function publicMailbox(doc: StoredMailbox) { return { id: doc.id, name: doc.name, provider: 'smtp', primaryAddress: doc.primaryAddress, aliases: Array.isArray(doc.aliases) ? doc.aliases : [], host: doc.host, port: doc.port, security: doc.security, username: doc.username, health: doc.health ?? 'unknown', testedAt: doc.testedAt ?? null, credentialConfigured: Boolean(doc.encryptedCredential), credentialHint: doc.credentialFingerprint ? `configured • ${doc.credentialFingerprint}` : null } }

export async function configureSMTPMailbox(payload: Payload, input: SMTPConfiguration, actor: string) {
  return withPayloadTransaction(payload, async (transaction) => {
    const req = internal(transaction); const existing = input.id ? await payload.findByID({ collection: 'mailbox-configurations', id: input.id, depth: 0, overrideAccess: true, req }) as unknown as StoredMailbox : undefined
    const config = validated(input, existing); const password = input.password || (existing?.encryptedCredential ? decryptPassword(existing.encryptedCredential) : '')
    const data = { ...config, provider: 'smtp' as const, encryptedCredential: encryptPassword(password), credentialFingerprint: createHash('sha256').update(password).digest('hex').slice(0, 12), health: 'unknown' as const }
    const saved = existing ? await payload.update({ collection: 'mailbox-configurations', id: existing.id, data, overrideAccess: true, req }) : await payload.create({ collection: 'mailbox-configurations', data, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: existing ? 'mailbox.configuration_updated' : 'mailbox.configuration_created', user: actor, actor, detail: { mailbox: (saved as { id: string }).id, provider: 'smtp', credentialFingerprint: data.credentialFingerprint } }, overrideAccess: true, req })
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
  if (![String(mailbox.primaryAddress), ...(Array.isArray(mailbox.aliases) ? mailbox.aliases.map(String) : [])].includes(senderAddress)) throw new Error('Sender address is not configured on this mailbox.')
  return withPayloadTransaction(payload, async (transaction) => { const req = internal(transaction); const current = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: input.area } }, limit: 1, depth: 0, overrideAccess: true, req }); const saved = current.docs[0] ? await payload.update({ collection: 'mailbox-area-mappings', id: current.docs[0].id, data: { mailbox: input.mailbox, senderAddress }, overrideAccess: true, req }) : await payload.create({ collection: 'mailbox-area-mappings', data: { area: input.area, mailbox: input.mailbox, senderAddress }, overrideAccess: true, req }); await payload.create({ collection: 'audit-events', data: { event: 'mailbox.area_mapped', user: actor, actor, detail: { area: input.area, mailbox: input.mailbox, senderAddress } }, overrideAccess: true, req }); return saved })
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
    try { const result = await (await smtpTransport(mailbox)).sendMail({ from: exact.senderAddress, to: exact.recipientAddress, subject: exact.subject, text: exact.body }); return withPayloadTransaction(payload, async (transaction) => { const req = internal(transaction); const sent = await payload.update({ collection: 'mailbox-test-sends', id: claim.id, data: { state: 'sent', providerMessageID: result.messageId?.slice(0, 500) }, overrideAccess: true, req }); await payload.create({ collection: 'audit-events', data: { event: 'mailbox.test_send_completed', user: actor, actor, detail: { mailbox: input.mailbox, testSend: claim.id, state: 'sent' } }, overrideAccess: true, req }); return sent }) } catch { return withPayloadTransaction(payload, async (transaction) => { const req = internal(transaction); await payload.update({ collection: 'mailbox-test-sends', id: claim.id, data: { state: 'failed', failureCode: 'provider_unavailable' }, overrideAccess: true, req }); await payload.create({ collection: 'audit-events', data: { event: 'mailbox.test_send_completed', user: actor, actor, detail: { mailbox: input.mailbox, testSend: claim.id, state: 'failed' } }, overrideAccess: true, req }); throw new Error('SMTP test message could not be delivered.') }) }
  })
}

export async function mailboxWorkspace(payload: Payload) {
  const [mailboxes, mappings] = await Promise.all([payload.find({ collection: 'mailbox-configurations', limit: 100, sort: 'name', depth: 0, overrideAccess: true }), payload.find({ collection: 'mailbox-area-mappings', limit: 3, sort: 'area', depth: 0, overrideAccess: true })])
  return { providers: { microsoft: { status: 'available' }, google: { status: 'available' }, smtp: { status: mailboxes.docs.some((item) => item.health === 'connected') ? 'connected' : mailboxes.totalDocs ? 'configured' : 'available' } }, mailboxes: mailboxes.docs.map((item) => publicMailbox(item as unknown as StoredMailbox)), mappings: mappings.docs.map((item) => ({ id: item.id, area: item.area, mailbox: relationID(item.mailbox), senderAddress: item.senderAddress })) }
}
