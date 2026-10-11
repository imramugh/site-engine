import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPair, generateSecret, SignJWT, exportJWK, importJWK } from 'jose'
import { googleJWTVerifier, receiveGoogleNotification, receiveMicrosoftNotification } from '../src/mailbox-notifications'

const payload = { find: async () => ({ docs: [] }) } as any
const original = { audience: process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE, email: process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT }
afterEach(() => {
  if (original.audience === undefined) delete process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE; else process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE = original.audience
  if (original.email === undefined) delete process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT; else process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT = original.email
})

describe('ENG-020 notification request boundaries', () => {
  it('returns only a bounded Graph validation token with no-store', async () => {
    const valid = await receiveMicrosoftNotification(payload, new Request('https://cms.test?validationToken=opaque', { method: 'POST', body: 'not-json' }))
    const long = await receiveMicrosoftNotification(payload, new Request(`https://cms.test?validationToken=${'x'.repeat(4097)}`, { method: 'POST' }))
    expect(valid.status).toBe(200); expect(valid.headers.get('cache-control')).toBe('no-store'); expect(await valid.text()).toBe('opaque'); expect(long.status).toBe(400)
  })

  it('rejects malformed JSON before consulting notification state', async () => {
    let queried = false
    const guarded = { find: async () => { queried = true; return { docs: [] } } } as any
    expect((await receiveMicrosoftNotification(guarded, new Request('https://cms.test', { method: 'POST', body: '{bad' }))).status).toBe(400)
    expect(queried).toBe(false)
  })

  it('cancels an oversized streamed Graph request', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(70_000))) }, cancel() { cancelled = true } })
    const request = new Request('https://cms.test', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    expect((await receiveMicrosoftNotification(payload, request)).status).toBe(400)
    expect(cancelled).toBe(true)
  })

  it('rejects absent Pub/Sub authorization before parsing a body', async () => {
    expect((await receiveGoogleNotification(payload, new Request('https://cms.test', { method: 'POST', body: '{bad' }), async () => { throw new Error('must not verify') })).status).toBe(400)
  })
})

describe('ENG-020 Google JWT verification', () => {
  it('accepts an actually signed RS256 token and rejects each invalid claim or signature', async () => {
    process.env.MAILBOX_GOOGLE_PUBSUB_AUDIENCE = 'https://cms.test/push'
    process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT = 'push@example.iam.gserviceaccount.com'
    const expectedEmail = process.env.MAILBOX_GOOGLE_PUBSUB_SERVICE_ACCOUNT
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const verifier = googleJWTVerifier(async () => importJWK(await exportJWK(publicKey), 'RS256'))!
    const sign = async (claims: Record<string, unknown> = {}, header: any = { alg: 'RS256' }) => {
      let jwt = new SignJWT({ email: expectedEmail, email_verified: true, ...claims }).setProtectedHeader(header).setAudience('https://cms.test/push').setIssuer('https://accounts.google.com')
      if (!('iat' in claims)) jwt = jwt.setIssuedAt()
      if (!('exp' in claims)) jwt = jwt.setExpirationTime('5m')
      return jwt.sign(privateKey)
    }
    await expect(verifier(await sign())).resolves.toBeUndefined()
    const secret = await generateSecret('HS256')
    const hs256 = await new SignJWT({ email: expectedEmail, email_verified: true }).setProtectedHeader({ alg: 'HS256' }).setAudience('https://cms.test/push').setIssuer('https://accounts.google.com').setIssuedAt().setExpirationTime('5m').sign(secret)
    await expect(verifier(hs256)).rejects.toThrow()
    const wrongIssuer = await new SignJWT({ email: expectedEmail, email_verified: true }).setProtectedHeader({ alg: 'RS256' }).setAudience('https://cms.test/push').setIssuer('https://attacker.test').setIssuedAt().setExpirationTime('5m').sign(privateKey)
    const wrongAudience = await new SignJWT({ email: expectedEmail, email_verified: true }).setProtectedHeader({ alg: 'RS256' }).setAudience('wrong').setIssuer('https://accounts.google.com').setIssuedAt().setExpirationTime('5m').sign(privateKey)
    const expired = await new SignJWT({ email: expectedEmail, email_verified: true }).setProtectedHeader({ alg: 'RS256' }).setAudience('https://cms.test/push').setIssuer('https://accounts.google.com').setIssuedAt().setExpirationTime('0s').sign(privateKey)
    const cases = [wrongIssuer, wrongAudience, expired, await sign({ email: 'other@example.test' }), await sign({ email_verified: false }), await sign({ exp: undefined }), await sign({ iat: undefined })]
    for (const token of cases) await expect(verifier(token)).rejects.toThrow()
    const parts = (await sign()).split('.')
    parts[2] = (parts[2]![0] === 'a' ? 'b' : 'a') + parts[2]!.slice(1)
    const forged = parts.join('.')
    await expect(verifier(forged)).rejects.toThrow()
  })
})
