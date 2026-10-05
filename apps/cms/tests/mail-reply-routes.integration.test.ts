import { describe, expect, it } from 'vitest'
import { POST } from '../app/api/mail-replies/[target]/[id]/route'

// Route-level contract guard: these assertions intentionally exercise the
// public handler boundary; the SQLite fixture suite owns credential setup.
const call = (target: string, id: string, body: object, origin?: string) => POST(new Request(`http://cms.test/api/mail-replies/${target}/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }), { params: Promise.resolve({ target, id }) })

describe('ENG-020 mail reply route boundary', () => {
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
