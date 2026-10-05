import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'
import { authorizeMailDraft } from '../src/mail-authorizations'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
const directory=mkdtempSync(join(tmpdir(),'mail-reply-routes-'));process.env.DATABASE_URI=`file:${join(directory,'cms.sqlite')}`;process.env.PAYLOAD_PUBLIC_SERVER_URL='https://cms.reply.test';process.env.PAYLOAD_SECRET='test-secret-that-is-long-enough-for-reply-routes'
const { default: config } = await import('../payload.config.js'); const { POST } = await import('../app/api/mail-replies/[target]/[id]/route.js'); let live:any
beforeAll(async()=>{live=await getPayload({config})});afterAll(async()=>{await live?.destroy();rmSync(directory,{recursive:true,force:true})})

// Route-level contract guard: these assertions intentionally exercise the
// public handler boundary; the SQLite fixture suite owns credential setup.
const call = (target: string, id: string, body: object, origin?: string) => POST(new Request(`https://cms.reply.test/api/mail-replies/${target}/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }), { params: Promise.resolve({ target, id }) })

describe('ENG-020 mail reply route boundary', () => {
  it('rejects authenticated Sales on Careers and Hiring on Leads', async () => {
    const payload = await getPayload({ config }); const make = async (role: 'sales' | 'hiring') => { const user = await payload.create({ collection: 'users', data: { email: `${role}-${newOpaqueToken().slice(0, 8)}@example.test`, name: role, roles: [role] }, overrideAccess: true }); const token = newOpaqueToken(); await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true }); return token }
    const sales = await make('sales'); const hiring = await make('hiring'); const headers = (token: string) => ({ 'content-type': 'application/json', origin: 'http://cms.test', cookie: `site_engine_session=${token}` })
    const salesResponse = await POST(new Request('http://cms.test/api/mail-replies/application/00000000-0000-4000-8000-000000000001', { method: 'POST', headers: headers(sales), body: JSON.stringify({ action: 'prepare' }) }), { params: Promise.resolve({ target: 'application', id: '00000000-0000-4000-8000-000000000001' }) })
    const hiringResponse = await POST(new Request('http://cms.test/api/mail-replies/lead/00000000-0000-4000-8000-000000000001', { method: 'POST', headers: headers(hiring), body: JSON.stringify({ action: 'prepare' }) }), { params: Promise.resolve({ target: 'lead', id: '00000000-0000-4000-8000-000000000001' }) })
    expect(salesResponse.status).toBe(403); expect(hiringResponse.status).toBe(403)
  })
  it('binds Owner authorization and send actions to the route lead', async () => {
    const payload = await getPayload({ config }); const user = await payload.create({ collection: 'users', data: { email: `owner-${newOpaqueToken().slice(0, 8)}@example.test`, name: 'Owner', roles: ['owner'] }, overrideAccess: true }); const token = newOpaqueToken(); await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const lead = async () => payload.create({ collection: 'inquiries', data: { email: `${newOpaqueToken().slice(0, 8)}@example.test`, message: 'Message', topic: 'general', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: newOpaqueToken(), stage: 'new' }, overrideAccess: true }); const a = await lead(); const b = await lead()
    const draft = await payload.create({ collection: 'mail-drafts', data: { lead: a.id, threadID: newOpaqueToken(), recipient: a.email, sender: 'team@example.test', subject: 'Subject', body: 'Body', attachmentHashes: [], revision: 1, state: 'prepared' }, overrideAccess: true }); const grant = await authorizeMailDraft(payload, { id: user.id, sessionToken: token }, draft.id, new Date(Date.now() + 60_000)); const origin = process.env.PAYLOAD_PUBLIC_SERVER_URL ? new URL(process.env.PAYLOAD_PUBLIC_SERVER_URL).origin : 'http://cms.test'; const headers = { 'content-type': 'application/json', origin, cookie: `${cookieName(SESSION_COOKIE)}=${token}` }
    for (const body of [{ action: 'authorize', grantID: draft.id }, { action: 'send', grantID: grant.id }]) { const response = await POST(new Request(`${origin}/api/mail-replies/lead/${b.id}`, { method: 'POST', headers, body: JSON.stringify(body) }), { params: Promise.resolve({ target: 'lead', id: b.id }) }); expect(response.status).toBe(422) }
    expect(await payload.findByID({ collection: 'mail-authorizations', id: grant.id, depth: 0, overrideAccess: true })).toMatchObject({ consumedAt: null })
  })
  it('rejects cross-origin reply preparation before loading a record', async () => {
    const response = await call('lead', '00000000-0000-4000-8000-000000000001', { action: 'prepare', sender: 'team@example.test', subject: 'Test', body: 'Body' }, 'https://attacker.example')
    expect(response.status).toBe(403)
  })
  it('does not expose an arbitrary resource through an unauthenticated grant action', async () => {
    const response = await call('application', '00000000-0000-4000-8000-000000000001', { action: 'send', grantID: '00000000-0000-4000-8000-000000000002' }, 'http://cms.test')
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('00000000-0000-4000-8000-000000000001')
  })
})
