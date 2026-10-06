import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'mail-suggestions-route-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`; process.env.PAYLOAD_SECRET = 'mail-suggestions-route-test-secret-long-enough'
const { default: config } = await import('../payload.config.js'); const { GET } = await import('../app/api/mail-suggestions/[target]/[id]/route.js')
let payload: Awaited<ReturnType<typeof getPayload>>
const hash = (email: string) => createHash('sha256').update(email).digest('hex')

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }) })

test('shows only unadopted suggestions for the current mapped mailbox and provider', async () => {
  const user = await payload.create({ collection: 'users', data: { email: 'suggestions-sales@example.test', name: 'Sales', roles: ['sales'] }, overrideAccess: true }); const token = newOpaqueToken(); const now = new Date().toISOString()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  const lead = await payload.create({ collection: 'inquiries', data: { email: 'suggestions@example.test', message: 'lead', topic: 'general', sourcePage: '/', consentedAt: now, consentBasis: 'staff-recorded', idempotencyKey: newOpaqueToken(), stage: 'new' }, overrideAccess: true })
  const mailbox = async (name: string, provider: 'google' | 'microsoft') => payload.create({ collection: 'mailbox-configurations', data: { name, provider, primaryAddress: `${name}@example.test`, aliases: [], verifiedAliases: [], host: 'oauth', port: 1, security: 'tls', username: name, encryptedCredential: 'opaque', credentialRevision: name, health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  const current = await mailbox('current', 'google'); const former = await mailbox('former', 'google')
  await payload.create({ collection: 'mailbox-area-mappings', data: { area: 'leads', mailbox: current.id, senderAddress: current.primaryAddress }, overrideAccess: true, context: { mailboxInternal: true } })
  const create = (mailbox: string, provider: 'google' | 'microsoft', conversation: string) => payload.create({ collection: 'mail-conversation-suggestions', data: { mailbox, provider, providerConversationID: conversation, addressHash: hash(lead.email), target: 'lead' }, overrideAccess: true })
  const visible = await create(current.id, 'google', 'current-google'); await create(former.id, 'google', 'former-google'); await create(current.id, 'microsoft', 'current-microsoft')
  const response = await GET(new Request(`http://cms.test/api/mail-suggestions/lead/${lead.id}`, { headers: { cookie: `site_engine_session=${token}` } }), { params: Promise.resolve({ target: 'lead', id: lead.id }) })
  expect(response.status).toBe(200); await expect(response.json()).resolves.toEqual({ suggestions: [{ id: visible.id }] })
})
