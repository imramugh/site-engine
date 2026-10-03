import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, OIDC_TRANSACTION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-identity-callback-'))
const db = join(directory, 'cms.sqlite')
const tokenFile = join(directory, 'bootstrap-token')
process.env.DATABASE_URI = `file:${db}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://localhost'
process.env.OIDC_GOOGLE_CLIENT_ID = 'test-client'
process.env.OIDC_GOOGLE_CLIENT_SECRET = 'test-secret'
writeFileSync(tokenFile, 'test-only-bootstrap-token')
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = tokenFile

const issuerState: { email: string; issuer: string; key?: CryptoKey; kid: string; nonce: string; subject: string; verifier: string } = {
  email: 'invited@example.test', issuer: '', kid: 'test-key', nonce: 'callback-nonce', subject: 'provider-subject', verifier: 'callback-verifier',
}
let server: ReturnType<typeof createServer>
let payload: Awaited<ReturnType<typeof getPayload>>
let callback: (request: Request, context: { params: Promise<{ provider: string }> }) => Promise<Response>

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
    if (url.pathname === '/jwks') {
      response.end(JSON.stringify({ keys: [{ ...jwk, alg: 'RS256', kid: issuerState.kid, use: 'sig' }] }))
      return
    }
    if (url.pathname === '/token') {
      let body = ''
      for await (const chunk of request) body += chunk
      const parameters = new URLSearchParams(body)
      if (parameters.get('code') !== 'accepted-code' || parameters.get('code_verifier') !== issuerState.verifier) {
        response.statusCode = 400
        response.end(JSON.stringify({ error: 'invalid_grant' }))
        return
      }
      const token = await new SignJWT({ email: issuerState.email, email_verified: true, nonce: issuerState.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: issuerState.kid })
        .setIssuer(issuerState.issuer).setAudience('test-client').setSubject(issuerState.subject).setIssuedAt().setExpirationTime('5m').sign(issuerState.key!)
      response.end(JSON.stringify({ access_token: 'unused', id_token: token, token_type: 'Bearer' }))
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  issuerState.issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  process.env.OIDC_GOOGLE_ISSUER_URL = issuerState.issuer

  const { default: config } = await import('../payload.config.js')
  payload = await getPayload({ config })
  const route = await import('../app/api/auth/callback/[provider]/route.js')
  callback = route.GET
})

afterAll(async () => {
  await payload?.destroy()
  server?.close()
  rmSync(directory, { recursive: true, force: true })
})

async function createSignIn(email: string, subject: string) {
  issuerState.email = email
  issuerState.subject = subject
  const invitation = await payload.create({
    collection: 'invitations',
    data: { email, provider: 'google', providerIssuer: issuerState.issuer, providerSubject: subject, roles: ['editor'], tokenHash: hashOpaqueToken(`invite-${subject}`), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    overrideAccess: true,
  })
  const state = `state-${subject}`
  await payload.create({
    collection: 'auth-transactions',
    data: { stateHash: hashOpaqueToken(state), nonce: issuerState.nonce, verifier: issuerState.verifier, provider: 'google', invitation: invitation.id, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    overrideAccess: true,
  })
  const request = () => new Request(`http://localhost/api/auth/callback/google?code=accepted-code&state=${state}`, {
    headers: { cookie: `${cookieName(OIDC_TRANSACTION_COOKIE)}=${hashOpaqueToken(state)}` },
  })
  return { invitation, request, state }
}

const invoke = (request: Request) => callback(request, { params: Promise.resolve({ provider: 'google' }) })

describe('identity callback SQLite transaction (ENG-007)', () => {
  it('enables real Payload SQLite transactions', async () => {
    const transactionID = await payload.db.beginTransaction()
    expect(transactionID).toEqual(expect.any(String))
    await payload.db.rollbackTransaction(transactionID!)
  })

  it('atomically consumes a replayed state, creating only one session and audit event', async () => {
    const { request } = await createSignIn('parallel@example.test', 'parallel-subject')
    const [first, second] = await Promise.all([invoke(request()), invoke(request())])
    expect([first.status, second.status].sort()).toEqual([307, 400])

    const users = await payload.find({ collection: 'users', where: { providerSubject: { equals: 'parallel-subject' } }, limit: 10, overrideAccess: true })
    const sessions = await payload.find({ collection: 'auth-sessions', limit: 10, overrideAccess: true })
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'identity.signed_in' } }, limit: 10, overrideAccess: true })
    expect(users.totalDocs).toBe(1)
    expect(sessions.totalDocs).toBe(1)
    expect(audit.totalDocs).toBe(1)
  })

  it('rolls back state, invitation, user, and session when the audit insert fails', async () => {
    const { invitation, request, state } = await createSignIn('rollback@example.test', 'rollback-subject')
    const client = (payload.db as unknown as { client: { execute: (sql: string) => Promise<unknown> } }).client
    const sessionsBefore = await payload.count({ collection: 'auth-sessions', overrideAccess: true })
    const auditBefore = await payload.count({ collection: 'audit-events', overrideAccess: true })
    await client.execute("CREATE TRIGGER fail_identity_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(FAIL, 'injected audit write failure'); END")
    try {
      const response = await invoke(request())
      expect(response.status).toBe(401)
    } finally {
      await client.execute('DROP TRIGGER fail_identity_audit')
    }

    const transaction = await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: hashOpaqueToken(state) } }, limit: 1, overrideAccess: true })
    const redeemedInvitation = await payload.findByID({ collection: 'invitations', id: invitation.id, overrideAccess: true })
    const users = await payload.find({ collection: 'users', where: { providerSubject: { equals: 'rollback-subject' } }, limit: 10, overrideAccess: true })
    expect(transaction.docs[0]?.consumedAt).toBeNull()
    expect(redeemedInvitation.acceptedAt).toBeNull()
    expect(users.totalDocs).toBe(0)
    expect((await payload.count({ collection: 'auth-sessions', overrideAccess: true })).totalDocs).toBe(sessionsBefore.totalDocs)
    expect((await payload.count({ collection: 'audit-events', overrideAccess: true })).totalDocs).toBe(auditBefore.totalDocs)
  })

  it('does not let an existing identity consume an invitation bound to another identity', async () => {
    const existing = await payload.create({
      collection: 'users',
      data: { email: 'existing@example.test', name: 'Existing identity', roles: ['editor'], provider: 'google', providerIssuer: issuerState.issuer, providerSubject: 'existing-subject' },
      overrideAccess: true,
    })
    const { invitation, request, state } = await createSignIn('intended-recipient@example.test', 'intended-subject')
    issuerState.email = existing.email
    issuerState.subject = 'existing-subject'
    const sessionsBefore = await payload.count({ collection: 'auth-sessions', overrideAccess: true })
    const auditBefore = await payload.count({ collection: 'audit-events', overrideAccess: true })

    expect((await invoke(request())).status).toBe(403)

    const transaction = await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: hashOpaqueToken(state) } }, limit: 1, overrideAccess: true })
    const untouchedInvitation = await payload.findByID({ collection: 'invitations', id: invitation.id, overrideAccess: true })
    expect(transaction.docs[0]?.consumedAt).toBeNull()
    expect(untouchedInvitation.acceptedAt).toBeNull()
    expect((await payload.count({ collection: 'auth-sessions', overrideAccess: true })).totalDocs).toBe(sessionsBefore.totalDocs)
    expect((await payload.count({ collection: 'audit-events', overrideAccess: true })).totalDocs).toBe(auditBefore.totalDocs)
  })
})
