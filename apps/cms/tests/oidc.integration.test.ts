import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { authorizationURL, validateCallback } from '../src/oidc'

const issuerState: { issuer: string; nonce: string; verifier: string; key?: CryptoKey; kid: string } = { issuer: '', nonce: 'nonce', verifier: 'verifier', kid: 'test-key' }
let server: ReturnType<typeof createServer>

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  issuerState.key = pair.privateKey
  const jwk = await exportJWK(pair.publicKey)
  server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', issuerState.issuer)
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/.well-known/openid-configuration') {
      response.end(JSON.stringify({ issuer: issuerState.issuer, authorization_endpoint: `${issuerState.issuer}/authorize`, token_endpoint: `${issuerState.issuer}/token`, jwks_uri: `${issuerState.issuer}/jwks`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], id_token_signing_alg_values_supported: ['RS256'] }))
      return
    }
    if (url.pathname === '/jwks') { response.end(JSON.stringify({ keys: [{ ...jwk, kid: issuerState.kid, use: 'sig', alg: 'RS256' }] })); return }
    if (url.pathname === '/token') {
      let body = ''
      for await (const chunk of request) body += chunk
      const parameters = new URLSearchParams(body)
      if (parameters.get('code') !== 'accepted-code' || parameters.get('code_verifier') !== issuerState.verifier) { response.statusCode = 400; response.end(JSON.stringify({ error: 'invalid_grant' })); return }
      const token = await new SignJWT({ email: 'invited@example.test', email_verified: true, nonce: issuerState.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: issuerState.kid })
        .setIssuer(issuerState.issuer).setAudience('test-client').setSubject('provider-subject').setIssuedAt().setExpirationTime('5m').sign(issuerState.key!)
      response.end(JSON.stringify({ access_token: 'unused', token_type: 'Bearer', id_token: token }))
      return
    }
    response.statusCode = 404; response.end('{}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  issuerState.issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(() => server.close())

describe('local OIDC issuer callback validation (ENG-007)', () => {
  const settings = () => ({ issuer: issuerState.issuer, clientID: 'test-client', clientSecret: 'test-secret', redirectURI: 'http://localhost/api/auth/callback/google' })

  it('uses authorization code PKCE and validates state, nonce, and verified Google email', async () => {
    const url = await authorizationURL(settings(), 'expected-state', issuerState.nonce, issuerState.verifier)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const result = await validateCallback('google', settings(), new Request('http://localhost/api/auth/callback/google?code=accepted-code&state=expected-state'), 'expected-state', issuerState.nonce, issuerState.verifier)
    expect(result).toEqual({ subject: 'provider-subject', email: 'invited@example.test', name: 'invited@example.test' })
  })

  it('rejects wrong state, wrong nonce, and an invalid PKCE verifier', async () => {
    await expect(validateCallback('google', settings(), new Request('http://localhost/api/auth/callback/google?code=accepted-code&state=wrong-state'), 'expected-state', issuerState.nonce, issuerState.verifier)).rejects.toThrow()
    await expect(validateCallback('google', settings(), new Request('http://localhost/api/auth/callback/google?code=accepted-code&state=expected-state'), 'expected-state', 'wrong-nonce', issuerState.verifier)).rejects.toThrow()
    await expect(validateCallback('google', settings(), new Request('http://localhost/api/auth/callback/google?code=accepted-code&state=expected-state'), 'expected-state', issuerState.nonce, 'wrong-verifier')).rejects.toThrow()
  })
})
