import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'
import { createClient } from '@libsql/client'

const directory = mkdtempSync(join(tmpdir(), 'mail-thread-route-'))
const db = join(directory, 'cms.sqlite')
process.env.DATABASE_URI = `file:${db}`
process.env.PAYLOAD_SECRET = 'mail-thread-route-test-secret-long-enough'
const { default: config } = await import('../payload.config.js')
const { GET } = await import('../app/api/mail-threads/[target]/[id]/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>

const session = async (roles: Array<'owner' | 'sales' | 'hiring'>) => {
  const user = await payload.create({ collection: 'users', data: { email: `${roles[0]}-${newOpaqueToken().slice(0, 8)}@example.test`, name: roles[0], roles }, overrideAccess: true })
  const token = newOpaqueToken(); const now = new Date().toISOString()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  return token
}
const call = (target: string, id: string, token?: string) => GET(new Request(`http://cms.test/api/mail-threads/${target}/${id}`, { headers: token ? { cookie: `site_engine_session=${token}` } : {} }), { params: Promise.resolve({ target, id }) })

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }); delete process.env.DATABASE_URI; delete process.env.PAYLOAD_SECRET })

describe('ENG-020 mail timeline route', () => {
  it('returns latest chronological messages only for the authenticated target domain', async () => {
    const owner = await session(['owner']); const sales = await session(['sales']); const hiring = await session(['hiring'])
    const lead = await payload.create({ collection: 'inquiries', data: { email: 'timeline-lead@example.test', message: 'Lead', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: newOpaqueToken(), stage: 'new' }, overrideAccess: true })
    const application = await payload.create({ collection: 'applications', data: { name: 'Timeline applicant', email: 'timeline-applicant@example.test', coverLetter: 'Application', consent: true, jobId: crypto.randomUUID(), resumeKey: 'resume', idempotencyKey: newOpaqueToken(), status: 'new' }, overrideAccess: true })
    const mailbox = await payload.create({ collection: 'mailbox-configurations', data: { name: 'Timeline', provider: 'smtp', primaryAddress: 'team@example.test', aliases: [], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'timeline', encryptedCredential: 'opaque', credentialRevision: 'test', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
    const leadThread = await payload.create({ collection: 'mail-threads', data: { lead: lead.id, mailbox: mailbox.id, provider: 'smtp', providerConversationID: 'lead-thread' }, overrideAccess: true })
    const applicationThread = await payload.create({ collection: 'mail-threads', data: { application: application.id, mailbox: mailbox.id, provider: 'smtp', providerConversationID: 'application-thread' }, overrideAccess: true })
    for (let index = 0; index < 101; index += 1) await payload.create({ collection: 'mail-thread-messages', data: { thread: leadThread.id, lead: lead.id, mailbox: mailbox.id, providerMessageID: `lead-${index}`, direction: 'inbound', sender: lead.email, recipient: 'team@example.test', subject: `Lead ${index}`, body: `body-${index}`, receivedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), attachmentMetadata: index === 100 ? [{ name: 'latest.pdf', contentType: 'application/pdf', size: 12 }] : [] }, overrideAccess: true })
    await payload.create({ collection: 'mail-thread-messages', data: { thread: applicationThread.id, application: application.id, mailbox: mailbox.id, providerMessageID: 'application-0', direction: 'inbound', sender: application.email, recipient: 'team@example.test', subject: 'Application only', body: 'private', receivedAt: '2026-01-01T00:00:00.000Z', attachmentMetadata: [] }, overrideAccess: true })

    const response = await call('lead', lead.id, owner); expect(response.status).toBe(200)
    const body = await response.json() as { truncated: boolean; messages: Array<{ subject: string; body: string; attachments: Array<{ name: string }> }> }
    expect(body.truncated).toBe(true); expect(body.messages).toHaveLength(100); expect(body.messages[0]?.subject).toBe('Lead 1'); expect(body.messages.at(-1)?.subject).toBe('Lead 100'); expect(body.messages.at(-1)?.attachments).toEqual([{ name: 'latest.pdf', contentType: 'application/pdf', size: 12 }]); expect(JSON.stringify(body)).not.toContain('Application only')
    expect((await call('lead', lead.id, sales)).status).toBe(200)
    expect((await call('application', application.id, hiring)).status).toBe(200)
    expect((await call('application', application.id, sales)).status).toBe(403)
    expect((await call('lead', lead.id, hiring)).status).toBe(403)
    expect((await call('lead', lead.id)).status).toBe(403)
    expect((await call('lead', crypto.randomUUID(), owner)).status).toBe(404)
    expect((await call('lead', 'not-a-uuid', owner)).status).toBe(404)
  })

  it('returns the shared retryable authentication response when an aged session refresh is blocked', async () => {
    const owner = await session(['owner'])
    const ownerSession = (await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(owner) } }, limit: 1, overrideAccess: true })).docs[0]!
    await payload.update({ collection: 'auth-sessions', id: ownerSession.id, data: { lastSeenAt: new Date(Date.now() - 61_000).toISOString() }, overrideAccess: true })
    const external = createClient({ url: `file:${db}` })
    const lock = await external.transaction('write')
    try {
      await lock.execute({ sql: 'UPDATE auth_sessions SET updated_at = updated_at WHERE id = ?', args: [String(ownerSession.id)] })
      const response = await call('lead', crypto.randomUUID(), owner)
      expect(response.status).toBe(503)
      expect(response.headers.get('Retry-After')).toBe('1')
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      await expect(response.json()).resolves.toEqual({ error: 'Authentication is temporarily unavailable. Please retry.' })
    } finally { await lock.rollback(); external.close() }
  }, 15_000)
})
