import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload, type Payload } from 'payload'
import { storeResume } from '../src/applications'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'
import { authorizeReply, prepareReply, sendReply, setReplyDeliveryForTest } from '../src/mail-replies'
import { resolveOutgoingAttachments } from '../src/outgoing-attachments'
import { mediaFilePath } from '../src/media'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-outgoing-attachments-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.MEDIA_STORAGE_DIR = join(directory, 'media')
process.env.APPLICATION_STORAGE_DIR = join(directory, 'applications')
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-outgoing-attachments'
const { default: config } = await import('../payload.config.js')
let payload: Payload
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { setReplyDeliveryForTest(); await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

type Actor = { id: string; sessionToken: string }
async function actor(role: 'owner' | 'sales' | 'hiring' | 'editor', disabled = false): Promise<Actor> {
  const user = await payload.create({ collection: 'users', data: { email: `${role}-${randomUUID()}@example.test`, name: role, roles: [role], disabled }, overrideAccess: true })
  const sessionToken = newOpaqueToken(); const now = Date.now()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(sessionToken), user: user.id, authenticatedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }, overrideAccess: true })
  return { id: user.id, sessionToken }
}
async function lead() { return payload.create({ collection: 'inquiries', data: { email: `lead-${randomUUID()}@example.test`, message: 'Question', topic: 'general', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: randomUUID(), stage: 'new' }, overrideAccess: true }) }
async function application(resumeKey = storeResume({ data: Buffer.from('%PDF-1.4\nmatching resume'), name: 'resume.pdf' })) { return payload.create({ collection: 'applications', data: { name: 'Applicant', email: `${randomUUID()}@example.test`, coverLetter: 'Application', consent: true, jobId: randomUUID(), resumeKey, idempotencyKey: randomUUID() }, overrideAccess: true }) }
const raster = () => sharp({ create: { width: 20, height: 20, channels: 3, background: '#155e75' } }).png().toBuffer()
async function asset(owner: Actor, name = 'brief.png', bytes?: Buffer) { const data = bytes ?? await raster(); return payload.create({ collection: 'assets', data: { alt: 'Attachment fixture' }, file: { data, mimetype: 'image/png', name, size: data.length }, user: await payload.findByID({ collection: 'users', id: owner.id, overrideAccess: true }), overrideAccess: false }) }

describe('outgoing attachment resolution with Payload access', () => {
  it('uses actual asset access and target roles, including disabled and editor denial', async () => {
    const owner = await actor('owner'); const sales = await actor('sales'); const hiring = await actor('hiring'); const editor = await actor('editor'); const disabled = await actor('owner', true)
    const document = await asset(owner); const inquiry = await lead(); const app = await application()
    await expect(resolveOutgoingAttachments(payload, { target: 'lead', targetID: inquiry.id, actorID: owner.id, attachments: [{ source: 'asset', id: document.id }] })).resolves.toHaveLength(1)
    await expect(resolveOutgoingAttachments(payload, { target: 'lead', targetID: inquiry.id, actorID: sales.id, attachments: [{ source: 'asset', id: document.id }] })).rejects.toThrow()
    await expect(resolveOutgoingAttachments(payload, { target: 'lead', targetID: inquiry.id, actorID: hiring.id, attachments: [] })).rejects.toThrow('mail_authorization_required')
    await expect(resolveOutgoingAttachments(payload, { target: 'application', targetID: app.id, actorID: editor.id, attachments: [] })).rejects.toThrow('mail_authorization_required')
    await expect(resolveOutgoingAttachments(payload, { target: 'lead', targetID: inquiry.id, actorID: disabled.id, attachments: [] })).rejects.toThrow('mail_authorization_required')
  })

  it('binds only the matching application resume and rejects cross-target, deleted, changed, and oversized sources', async () => {
    const owner = await actor('owner'); const hiring = await actor('hiring'); const first = await application(); const second = await application()
    await expect(resolveOutgoingAttachments(payload, { target: 'application', targetID: first.id, actorID: hiring.id, attachments: [{ source: 'application-resume', id: first.id }] })).resolves.toMatchObject([{ source: 'application-resume', sourceID: first.id, filename: 'resume.pdf', mimeType: 'application/pdf' }])
    await expect(resolveOutgoingAttachments(payload, { target: 'application', targetID: first.id, actorID: hiring.id, attachments: [{ source: 'application-resume', id: second.id }] })).rejects.toThrow('attachment_not_available')
    const document = await asset(owner)
    await payload.update({ collection: 'assets', id: document.id, data: { deletedAt: new Date().toISOString(), deleteAfter: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true, context: { mediaLifecycle: 'bin' } })
    await expect(resolveOutgoingAttachments(payload, { target: 'lead', targetID: (await lead()).id, actorID: owner.id, attachments: [{ source: 'asset', id: document.id }] })).rejects.toThrow('attachment_not_available')
    const huge = await asset(owner, 'huge.png'); writeFileSync(mediaFilePath(String((huge as any).currentFile?.filename ?? (huge as any).filename)), Buffer.alloc(10 * 1024 * 1024 + 1, 1)); const hugeLead = await lead()
    await expect(resolveOutgoingAttachments(payload, { target: 'lead', targetID: hugeLead.id, actorID: owner.id, attachments: [{ source: 'asset', id: huge.id }] })).rejects.toThrow('attachment_not_available')
  })

  it('re-resolves changed blobs and immutable descriptors at confirmation, and leaves unsupported delivery uncalled and unconsumed', async () => {
    const owner = await actor('owner'); const inquiry = await lead(); const document = await asset(owner)
    const assetDraft = await prepareReply(payload, 'lead', inquiry.id, owner.id, { sender: 'team@example.test', subject: 'Asset reply', body: 'Thank you.', attachments: [{ source: 'asset', id: document.id }] })
    writeFileSync(mediaFilePath(String((document as any).currentFile?.filename ?? (document as any).filename)), Buffer.from('changed stored asset bytes'))
    await expect(authorizeReply(payload, owner, assetDraft.id)).rejects.toThrow('attachment_not_available')
    const hiring = await actor('hiring'); const app = await application()
    const prepared = await prepareReply(payload, 'application', app.id, hiring.id, { sender: 'team@example.test', subject: 'Application reply', body: 'Thank you.', attachments: [{ source: 'application-resume', id: app.id }] })
    await payload.update({ collection: 'mail-drafts', id: prepared.id, data: { attachments: [{ source: 'application-resume', sourceID: app.id, filename: 'changed.pdf', mimeType: 'application/pdf', size: 1, sha256: '0'.repeat(64) }] }, overrideAccess: true })
    await expect(authorizeReply(payload, hiring, prepared.id)).rejects.toThrow('attachment_not_available')
    const matching = await prepareReply(payload, 'application', app.id, hiring.id, { sender: 'team@example.test', subject: 'Application reply two', body: 'Thank you.', attachments: [{ source: 'application-resume', id: app.id }] })
    const grant = await authorizeReply(payload, hiring, matching.id)
    let calls = 0; setReplyDeliveryForTest(async () => { calls += 1; return { provider: 'google', messageID: 'must-not-send' } })
    await expect(sendReply(payload, hiring, grant.id)).rejects.toThrow('reply_attachments_not_supported')
    expect(calls).toBe(0)
    expect(await payload.findByID({ collection: 'mail-authorizations', id: grant.id, overrideAccess: true })).toMatchObject({ consumedAt: null })
    expect(await payload.findByID({ collection: 'mail-drafts', id: matching.id, overrideAccess: true })).toMatchObject({ state: 'authorized' })
    const mailbox = await payload.create({ collection: 'mailbox-configurations', data: { name: 'Attachment delivery', provider: 'google', primaryAddress: 'team@example.test', aliases: [], verifiedAliases: [], host: 'oauth', port: 1, security: 'tls', username: 'team@example.test', encryptedCredential: 'opaque', credentialRevision: 'fixture', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
    await payload.create({ collection: 'mailbox-area-mappings', data: { area: 'careers', mailbox: mailbox.id, senderAddress: 'team@example.test' }, overrideAccess: true, context: { mailboxInternal: true } })
    let delivered: any; setReplyDeliveryForTest(async (_payload, _area, envelope) => { delivered = envelope; return { provider: 'google', messageID: 'verified-send', threadID: 'verified-thread' } })
    await expect(sendReply(payload, hiring, grant.id)).resolves.toMatchObject({ provider: 'google', messageID: 'verified-send', threadID: 'verified-thread' })
    expect(calls).toBe(0); expect(delivered.attachments).toMatchObject([{ filename: 'resume.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4\nmatching resume') }])
  })
})
