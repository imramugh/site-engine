import { describe, expect, it } from 'vitest'
import { receiveGoogleNotification, receiveMicrosoftNotification } from '../src/mailbox-notifications'
const payload = { find: async () => ({ docs: [] }) } as any
describe('ENG-020 mailbox notification gates', () => {
  it('returns Graph validationToken without reading a notification body', async () => {
    const response = await receiveMicrosoftNotification(payload, new Request('https://cms.test?validationToken=opaque', { method: 'POST', body: 'not-json' }))
    expect(response.status).toBe(200); expect(await response.text()).toBe('opaque')
  })
  it('rejects oversized Graph notification bodies', async () => {
    const response = await receiveMicrosoftNotification(payload, new Request('https://cms.test', { method: 'POST', body: 'x'.repeat(70_000) }))
    expect(response.status).toBe(400)
  })
  it('rejects missing auth before parsing the Pub/Sub body', async () => {
    const response = await receiveGoogleNotification(payload, new Request('https://cms.test', { method: 'POST', body: '{bad' }), async () => { throw new Error('bad') })
    expect(response.status).toBe(400)
  })
  it('rejects a verifier failure without querying a mailbox', async () => {
    let queried = false; const guarded = { find: async () => { queried = true; return { docs: [] } } } as any
    const response = await receiveGoogleNotification(guarded, new Request('https://cms.test', { method: 'POST', headers: { authorization: 'Bearer invalid' }, body: '{}' }), async () => { throw new Error('bad') })
    expect(response.status).toBe(400); expect(queried).toBe(false)
  })
})
