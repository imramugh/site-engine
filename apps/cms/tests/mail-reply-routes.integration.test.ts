import { describe, expect, it } from 'vitest'
import { POST } from '../app/api/mail-replies/[target]/[id]/route'
import { getPayload } from 'payload'
import config from '../payload.config'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'

// Route-level contract guard: these assertions intentionally exercise the
// public handler boundary; the SQLite fixture suite owns credential setup.
const call = (target: string, id: string, body: object, origin?: string) => POST(new Request(`http://cms.test/api/mail-replies/${target}/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }), { params: Promise.resolve({ target, id }) })

describe('ENG-020 mail reply route boundary', () => {
  it('rejects authenticated Sales on Careers and Hiring on Leads', async () => {
    const payload = await getPayload({ config }); const make = async (role: 'sales' | 'hiring') => { const user = await payload.create({ collection: 'users', data: { email: `${role}-${newOpaqueToken().slice(0, 8)}@example.test`, name: role, roles: [role] }, overrideAccess: true }); const token = newOpaqueToken(); await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true }); return token }
    const sales = await make('sales'); const hiring = await make('hiring'); const headers = (token: string) => ({ 'content-type': 'application/json', origin: 'http://cms.test', cookie: `site_engine_session=${token}` })
    const salesResponse = await POST(new Request('http://cms.test/api/mail-replies/application/00000000-0000-4000-8000-000000000001', { method: 'POST', headers: headers(sales), body: JSON.stringify({ action: 'prepare' }) }), { params: Promise.resolve({ target: 'application', id: '00000000-0000-4000-8000-000000000001' }) })
    const hiringResponse = await POST(new Request('http://cms.test/api/mail-replies/lead/00000000-0000-4000-8000-000000000001', { method: 'POST', headers: headers(hiring), body: JSON.stringify({ action: 'prepare' }) }), { params: Promise.resolve({ target: 'lead', id: '00000000-0000-4000-8000-000000000001' }) })
    expect(salesResponse.status).toBe(403); expect(hiringResponse.status).toBe(403)
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
