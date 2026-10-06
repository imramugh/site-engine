import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'mail-attachments-route-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'mail-attachments-route-test-secret-long-enough', PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'), MAILBOX_GOOGLE_CLIENT_ID: 'client', MAILBOX_GOOGLE_CLIENT_SECRET: 'secret' })
const { default: config } = await import('../payload.config.js'); const { GET } = await import('../app/api/mail-attachments/[target]/[messageID]/[attachment]/route.js'); const { completeMailboxOAuth, startMailboxOAuth } = await import('../src/mailbox-oauth.js')
let payload: Awaited<ReturnType<typeof getPayload>>
const originalFetch = globalThis.fetch
let providerCalls = 0
const token = async (roles: Array<'owner' | 'sales' | 'hiring'>) => { const user = await payload.create({ collection: 'users', data: { email: `${roles.join('-')}-${newOpaqueToken().slice(0, 6)}@example.test`, name: roles.join(' '), roles }, overrideAccess: true }); const value = newOpaqueToken(); const now = new Date().toISOString(); await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(value), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true }); return value }
const call = (target: string, messageID: string, attachment: string, session?: string) => GET(new Request(`https://cms.example.test/api/mail-attachments/${target}/${messageID}/${attachment}`, { headers: session ? { cookie: `site_engine_session=${session}` } : {} }), { params: Promise.resolve({ target, messageID, attachment }) })

beforeAll(async () => { payload = await getPayload({ config }); globalThis.fetch = async (url) => { const value = String(url); if (value.includes('/token')) return Response.json({ access_token: 'download-token' }); if (value.includes('/attachments/attachment-id')) { providerCalls += 1; return Response.json({ data: Buffer.from('exact private bytes').toString('base64url') }) } throw new Error(`unexpected ${value}`) } })
afterAll(async () => { globalThis.fetch = originalFetch; await payload.destroy(); rmSync(directory, { recursive: true, force: true }) })

test('streams only the selected matched record attachment after target-role authorization', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'route-owner@example.test', name: 'Owner', roles: ['owner'] }, overrideAccess: true }); const state = new URL(await startMailboxOAuth(payload, 'google', owner.id, 'route-owner-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'google', state, 'code', owner.id, 'route-owner-session', async (url) => String(url).includes('/token') ? Response.json({ access_token: 'setup', refresh_token: 'refresh' }) : String(url).endsWith('/profile') ? Response.json({ emailAddress: 'route-mailbox@example.test' }) : Response.json({ sendAs: [{ sendAsEmail: 'route-mailbox@example.test', verificationStatus: 'accepted' }] }))
  const lead = await payload.create({ collection: 'inquiries', data: { email: 'same@example.test', message: 'lead', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: newOpaqueToken(), stage: 'new' }, overrideAccess: true }); const application = await payload.create({ collection: 'applications', data: { name: 'Same', email: lead.email, coverLetter: 'private', consent: true, jobId: crypto.randomUUID(), resumeKey: 'resume', idempotencyKey: newOpaqueToken(), status: 'new' }, overrideAccess: true })
  const thread = await payload.create({ collection: 'mail-threads', data: { lead: lead.id, mailbox: mailbox.id, provider: 'google', providerConversationID: 'route-thread' }, overrideAccess: true }); const message = await payload.create({ collection: 'mail-thread-messages', data: { thread: thread.id, lead: lead.id, mailbox: mailbox.id, providerMessageID: 'route-message', direction: 'inbound', sender: lead.email, recipient: mailbox.primaryAddress, subject: 'Attachment', body: 'body', receivedAt: new Date().toISOString(), attachmentMetadata: [{ name: 'cv name.pdf', contentType: 'application/pdf', size: 19, providerAttachmentID: 'attachment-id' }] }, overrideAccess: true })
  const sales = await token(['sales']); const hiring = await token(['hiring']); const mixed = await token(['sales', 'hiring'])
  providerCalls = 0
  expect((await call('lead', message.id, '0')).status).toBe(403)
  expect((await call('lead', message.id, '0', hiring)).status).toBe(403)
  expect((await call('application', message.id, '0', mixed)).status).toBe(404)
  expect(providerCalls).toBe(0)
  const response = await call('lead', message.id, '0', sales)
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(response.headers.get('content-type')).toBe('application/pdf'); expect(response.headers.get('content-disposition')).toContain("attachment; filename*=UTF-8''cv%20name.pdf"); expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('exact private bytes')
  expect(providerCalls).toBe(1)
})
