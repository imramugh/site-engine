import { describe, expect, it } from 'vitest'
import { authorizationDigest, authorizationUsable, normalizeBody } from '../src/mail-authorizations'
const draft = { recipient: 'Lead@Example.test ', sender: 'Site@Example.test', subject: ' Hello ', body: 'One\r\nTwo\n', attachmentHashes: ['b', 'a'], lead: 'lead-1', revision: 1 }
describe('ENG-033 local mail authorization digest', () => {
  it('binds immutable recipient, canonical body, attachments, lead and revision', () => {
    expect(normalizeBody(draft.body)).toBe('One\nTwo')
    expect(authorizationDigest(draft)).toBe(authorizationDigest({ ...draft, recipient: 'lead@example.test', attachmentHashes: ['a', 'b'] }))
    expect(authorizationDigest({ ...draft, body: 'Changed' })).not.toBe(authorizationDigest(draft))
  })
  it('rejects expired, revoked, consumed and changed draft grants', () => {
    const grant = { digest: authorizationDigest(draft), draftRevision: 1, expiresAt: '2099-01-01T00:00:00.000Z' }
    expect(authorizationUsable(grant, draft)).toBe(true)
    expect(authorizationUsable({ ...grant, revokedAt: '2026-01-01T00:00:00.000Z' }, draft)).toBe(false)
    expect(authorizationUsable({ ...grant, consumedAt: '2026-01-01T00:00:00.000Z' }, draft)).toBe(false)
    expect(authorizationUsable(grant, { ...draft, revision: 2 })).toBe(false)
  })
})
