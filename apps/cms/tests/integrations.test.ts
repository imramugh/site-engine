import { afterEach, describe, expect, it } from 'vitest'
import { decryptCredential, encryptCredential, publicIntegration, testConnection } from '../src/integrations'

const key = Buffer.alloc(32, 7).toString('base64url')

afterEach(() => { delete process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY })

describe('ENG-023 credential envelopes', () => {
  it('encrypts at rest, decrypts only at the adapter boundary, and exposes a masked serializer', async () => {
    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = key
    const secret = 'synthetic-secret-must-not-escape'
    const encryptedCredential = encryptCredential(secret)
    expect(encryptedCredential).not.toContain(secret)
    expect(decryptCredential(encryptedCredential)).toBe(secret)
    const visible = publicIntegration({ id: 'one', provider: 'openai', model: 'synthetic-model', encryptedCredential, credentialFingerprint: '0123456789ab' })
    expect(JSON.stringify(visible)).not.toContain(secret)
    expect(visible).toMatchObject({ credentialConfigured: true, credentialHint: 'configured • 0123456789ab' })
    await expect(testConnection({ provider: 'openai', encryptedCredential }, async ({ credential }) => credential === secret ? { ok: true, code: 'connected' } : { ok: false, code: 'rejected' })).resolves.toEqual({ ok: true, code: 'connected' })
  })

  it('does not turn a transport failure into a credential disclosure', async () => {
    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = key
    const encryptedCredential = encryptCredential('synthetic-secret-must-not-escape')
    await expect(testConnection({ provider: 'openai', encryptedCredential }, async () => { throw new Error('synthetic-secret-must-not-escape') })).resolves.toEqual({ ok: false, code: 'rejected' })
  })
})
