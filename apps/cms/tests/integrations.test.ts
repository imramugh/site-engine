import { afterEach, describe, expect, it } from 'vitest'
import { decryptCredential, encryptCredential, providerConnectionTransport, publicIntegration, testConnection } from '../src/integrations'

const key = Buffer.alloc(32, 7).toString('base64url')

afterEach(() => { delete process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY })

describe('ENG-023 credential envelopes', () => {
  it('encrypts at rest, decrypts only at the adapter boundary, and exposes a masked serializer', async () => {
    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = key
    const secret = 'synthetic-secret-must-not-escape'
    const encryptedCredential = encryptCredential(secret, 'openai')
    expect(encryptedCredential).not.toContain(secret)
    expect(decryptCredential(encryptedCredential, 'openai')).toBe(secret)
    expect(() => decryptCredential(encryptedCredential, 'anthropic')).toThrow()
    const visible = publicIntegration({ id: 'one', provider: 'openai', model: 'synthetic-model', encryptedCredential, credentialFingerprint: '0123456789ab' })
    expect(JSON.stringify(visible)).not.toContain(secret)
    expect(visible).toMatchObject({ credentialConfigured: true, credentialHint: 'configured • 0123456789ab' })
    await expect(testConnection({ provider: 'openai', encryptedCredential }, async ({ credential }) => credential === secret ? { ok: true, code: 'connected' } : { ok: false, code: 'rejected' })).resolves.toEqual({ ok: true, code: 'connected' })
  })

  it('does not turn a transport failure into a credential disclosure', async () => {
    process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = key
    const encryptedCredential = encryptCredential('synthetic-secret-must-not-escape', 'openai')
    await expect(testConnection({ provider: 'openai', encryptedCredential }, async () => { throw new Error('synthetic-secret-must-not-escape') })).resolves.toEqual({ ok: false, code: 'rejected' })
  })

  it('uses bounded, non-billable model metadata requests for explicit connection tests', async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response('ok', { status: 200 })
    }
    await expect(providerConnectionTransport({ provider: 'openai', model: 'gpt-test', credential: 'secret' }, fakeFetch)).resolves.toEqual({ ok: true, code: 'connected' })
    await expect(providerConnectionTransport({ provider: 'anthropic', model: 'claude-test', credential: 'secret' }, fakeFetch)).resolves.toEqual({ ok: true, code: 'connected' })
    await expect(providerConnectionTransport({ provider: 'google-gemini', model: 'gemini-test', credential: 'secret' }, fakeFetch)).resolves.toEqual({ ok: true, code: 'connected' })
    await expect(providerConnectionTransport({ provider: 'openrouter', model: 'openai/gpt-test', credential: 'secret' }, fakeFetch)).resolves.toEqual({ ok: true, code: 'connected' })
    expect(requests.map(item => item.url)).toEqual([
      'https://api.openai.com/v1/models/gpt-test',
      'https://api.anthropic.com/v1/models/claude-test',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test',
      'https://openrouter.ai/api/v1/key',
      'https://openrouter.ai/api/v1/model/openai/gpt-test',
    ])
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer secret')
    expect(requests[1]!.headers.get('x-api-key')).toBe('secret')
    expect(requests[2]!.headers.get('x-goog-api-key')).toBe('secret')
    expect(requests[3]!.headers.get('authorization')).toBe('Bearer secret')
    expect(requests.map(item => item.url).join('\n')).not.toContain('secret')
  })

  it('normalizes provider failures without exposing provider response data', async () => {
    const rejected = async () => new Response('credential-secret', { status: 401 })
    await expect(providerConnectionTransport({ provider: 'openai', model: 'gpt-test', credential: 'credential-secret' }, rejected)).resolves.toEqual({ ok: false, code: 'rejected' })
    await expect(providerConnectionTransport({ provider: 'openrouter', model: 'not-a-model', credential: 'credential-secret' }, rejected)).resolves.toEqual({ ok: false, code: 'unavailable' })
  })

  it('does not accept OpenRouter public model metadata when key verification fails', async () => {
    let calls = 0
    const fakeFetch = async () => { calls++; return new Response('invalid-key', { status: 401 }) }
    await expect(providerConnectionTransport({ provider: 'openrouter', model: 'openai/gpt-test', credential: 'bad-key' }, fakeFetch)).resolves.toEqual({ ok: false, code: 'rejected' })
    expect(calls).toBe(1)
  })
})
