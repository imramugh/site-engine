import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createClient } from '@libsql/client'
import { getPayload } from 'payload'
import { cookieName, hashOpaqueToken, OIDC_TRANSACTION_COOKIE, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-identity-callback-'))
const db = join(directory, 'cms.sqlite')
const tokenFile = join(directory, 'bootstrap-token')
process.env.DATABASE_URI = `file:${db}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-payload'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://localhost'
process.env.OIDC_GOOGLE_CLIENT_ID = 'test-client'
process.env.OIDC_GOOGLE_CLIENT_SECRET = 'test-secret'
process.env.OIDC_MICROSOFT_CLIENT_ID = 'test-client'
process.env.OIDC_MICROSOFT_CLIENT_SECRET = 'test-secret'
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
  process.env.OIDC_MICROSOFT_ISSUER_URL = issuerState.issuer

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

async function createSignIn(email: string, subject: string, provider: 'google' | 'microsoft' = 'google') {
  issuerState.email = email
  issuerState.subject = subject
  const invitation = await payload.create({
    collection: 'invitations',
    data: { email, provider, providerIssuer: issuerState.issuer, providerSubject: subject, requiredSubject: subject, roles: ['editor'], tokenHash: hashOpaqueToken(`invite-${subject}`), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    overrideAccess: true,
  })
  const state = `state-${subject}`
  await payload.create({
    collection: 'auth-transactions',
    data: { stateHash: hashOpaqueToken(state), nonce: issuerState.nonce, verifier: issuerState.verifier, provider, invitation: invitation.id, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    overrideAccess: true,
  })
  const request = (code = 'accepted-code') => new Request(`http://localhost/api/auth/callback/${provider}?code=${code}&state=${state}`, {
    headers: { cookie: `${cookieName(OIDC_TRANSACTION_COOKIE)}=${hashOpaqueToken(state)}` },
  })
  return { invitation, request, state }
}

const invoke = (request: Request) => callback(request, { params: Promise.resolve({ provider: 'google' }) })

async function callbackDenials(transactionID: string, reason: string) {
  const audit = await payload.find({
    collection: 'audit-events',
    where: { and: [
      { event: { equals: 'identity.sign_in_denied' } },
      { 'detail.transactionID': { equals: transactionID } },
      { 'detail.reason': { equals: reason } },
    ] },
    limit: 20,
    depth: 0,
    overrideAccess: true,
  })
  return audit.docs
}

function expectPrivacySafeCallbackDenial(event: any, input: { transactionID: string; provider: 'google' | 'microsoft'; reason: string; secrets: string[] }) {
  expect(event.detail).toEqual({ provider: input.provider, reason: input.reason, transactionID: input.transactionID })
  const serialized = JSON.stringify(event)
  for (const secret of input.secrets) expect(serialized).not.toContain(secret)
}

describe('identity callback SQLite transaction (ENG-007)', () => {
  it('enables real Payload SQLite transactions', async () => {
    const transactionID = await payload.db.beginTransaction()
    expect(transactionID).toEqual(expect.any(String))
    await payload.db.rollbackTransaction(transactionID!)
  })

  it('atomically consumes a replayed state, creating only one session and audit event', async () => {
    const { request, state } = await createSignIn('parallel@example.test', 'parallel-subject')
    const [first, second] = await Promise.all([invoke(request()), invoke(request())])
    expect([first.status, second.status].sort()).toEqual([307, 400])

    const users = await payload.find({ collection: 'users', where: { providerSubject: { equals: 'parallel-subject' } }, limit: 10, overrideAccess: true })
    const sessions = await payload.find({ collection: 'auth-sessions', limit: 10, overrideAccess: true })
    const audit = await payload.find({ collection: 'audit-events', where: { event: { equals: 'identity.signed_in' } }, limit: 10, depth: 0, overrideAccess: true })
    expect(users.totalDocs).toBe(1)
    expect(sessions.totalDocs).toBe(1)
    expect(audit.totalDocs).toBe(1)
    expect(audit.docs[0]).toMatchObject({ user: users.docs[0]!.id, detail: { provider: 'google' } })
    expect(JSON.stringify(audit.docs[0])).not.toContain('parallel@example.test')
    expect(JSON.stringify(audit.docs[0])).not.toContain('accepted-code')

    const transaction = await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: hashOpaqueToken(state) } }, limit: 1, depth: 0, overrideAccess: true })
    const denials = await callbackDenials(String(transaction.docs[0]!.id), 'transaction_not_current')
    expect(denials).toHaveLength(1)
    expectPrivacySafeCallbackDenial(denials[0], {
      transactionID: String(transaction.docs[0]!.id),
      provider: 'google',
      reason: 'transaction_not_current',
      secrets: [state, 'accepted-code', 'parallel@example.test', 'parallel-subject', issuerState.nonce, issuerState.verifier],
    })
  })

  it('enrolls an invited Microsoft identity through the configured local OIDC issuer and records the provider decision', async () => {
    const { invitation, request, state } = await createSignIn('microsoft-invited@example.test', 'microsoft-subject', 'microsoft')
    const response = await callback(request(), { params: Promise.resolve({ provider: 'microsoft' }) })
    expect(response.status).toBe(307)
    const user = (await payload.find({ collection: 'users', where: { providerSubject: { equals: 'microsoft-subject' } }, limit: 1, depth: 0, overrideAccess: true })).docs[0]!
    expect(user).toMatchObject({ email: 'microsoft-invited@example.test', provider: 'microsoft', providerIssuer: issuerState.issuer, providerSubject: 'microsoft-subject', roles: ['editor'] })
    expect((await payload.findByID({ collection: 'invitations', id: invitation.id, overrideAccess: true })).acceptedAt).toEqual(expect.any(String))
    const transaction = (await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: hashOpaqueToken(state) } }, limit: 1, depth: 0, overrideAccess: true })).docs[0]!
    expect(transaction.consumedAt).toEqual(expect.any(String))
    const audit = await payload.find({ collection: 'audit-events', where: { and: [{ event: { equals: 'identity.signed_in' } }, { user: { equals: user.id } }] }, limit: 1, depth: 0, overrideAccess: true })
    expect(audit.docs[0]).toMatchObject({ detail: { provider: 'microsoft' } })
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

  it('returns a sanitized retry response when an external SQLite writer blocks the post-verification transaction, then signs in after release', async () => {
    const { invitation, request, state } = await createSignIn('writer-lock@example.test', 'writer-lock-subject')
    const transaction = (await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: hashOpaqueToken(state) } }, limit: 1, depth: 0, overrideAccess: true })).docs[0]!
    const sessionsBefore = await payload.count({ collection: 'auth-sessions', overrideAccess: true })
    const usersBefore = await payload.count({ collection: 'users', overrideAccess: true })
    const external = createClient({ url: `file:${db}` })
    const lock = await external.transaction('write')
    try {
      await lock.execute({ sql: 'UPDATE auth_transactions SET updated_at = updated_at WHERE id = ?', args: [String(transaction.id)] })
      const blocked = await invoke(request())
      expect(blocked.status).toBe(503)
      expect(blocked.headers.get('Retry-After')).toBe('1')
      expect(blocked.headers.get('Cache-Control')).toBe('no-store')
      expect(blocked.headers.get('set-cookie')).toBeNull()
      await expect(blocked.text()).resolves.toBe('Sign-in is temporarily unavailable. Restart sign-in and try again.')
      expect((await payload.findByID({ collection: 'auth-transactions', id: transaction.id, overrideAccess: true })).consumedAt).toBeNull()
      expect((await payload.findByID({ collection: 'invitations', id: invitation.id, overrideAccess: true })).acceptedAt).toBeNull()
      expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(usersBefore.totalDocs)
      expect((await payload.count({ collection: 'auth-sessions', overrideAccess: true })).totalDocs).toBe(sessionsBefore.totalDocs)
    } finally {
      await lock.rollback()
      external.close()
    }
    const retried = await invoke(request())
    expect(retried.status).toBe(307)
    expect(retried.headers.get('set-cookie')).toContain(cookieName(SESSION_COOKIE))
  }, 15_000)

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
    expect((await payload.count({ collection: 'audit-events', overrideAccess: true })).totalDocs).toBe(auditBefore.totalDocs + 1)
  })

  it('enrolls a first owner from an unbound bootstrap invitation once', async () => {
    issuerState.email = 'bootstrap-owner@example.test'
    issuerState.subject = 'bootstrap-owner-subject'
    const invitation = await payload.create({ collection: 'invitations', data: { email: issuerState.email, provider: 'google', providerIssuer: issuerState.issuer, providerSubject: 'unbound:bootstrap', roles: ['owner'], tokenHash: hashOpaqueToken('bootstrap-invite'), expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const state = 'bootstrap-state'
    await payload.create({ collection: 'auth-transactions', data: { stateHash: hashOpaqueToken(state), nonce: issuerState.nonce, verifier: issuerState.verifier, provider: 'google', invitation: invitation.id, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const request = () => new Request(`http://localhost/api/auth/callback/google?code=accepted-code&state=${state}`, { headers: { cookie: `${cookieName(OIDC_TRANSACTION_COOKIE)}=${hashOpaqueToken(state)}` } })
    expect((await invoke(request())).status).toBe(307)
    expect((await invoke(request())).status).toBe(400)
    const users = await payload.find({ collection: 'users', where: { providerSubject: { equals: issuerState.subject } }, overrideAccess: true })
    expect(users.docs[0]).toMatchObject({ email: issuerState.email, roles: ['owner'], providerIssuer: issuerState.issuer })
  })

  it('denies a callback when the invitation email, issuer, or required subject differs', async () => {
    const cases = [
      { email: 'wrong-email@example.test', issuer: issuerState.issuer, subject: 'case-email', mutate: () => { issuerState.email = 'actual-email@example.test' } },
      { email: 'issuer@example.test', issuer: 'https://wrong-issuer.example.test', subject: 'case-issuer', mutate: () => undefined },
      { email: 'subject@example.test', issuer: issuerState.issuer, subject: 'case-subject', mutate: () => { issuerState.subject = 'different-subject' } },
    ]
    for (const entry of cases) {
      const { invitation, request } = await createSignIn(entry.email, entry.subject)
      await payload.update({ collection: 'invitations', id: invitation.id, data: { providerIssuer: entry.issuer }, overrideAccess: true })
      entry.mutate()
      expect((await invoke(request())).status).toBe(403)
    }
  })
})

describe('ENG-007 identity decision audit evidence', () => {
  async function auditByReason(reason: string) {
    return payload.find({ collection: 'audit-events', where: { and: [{ event: { equals: 'identity.sign_in_denied' } }, { 'detail.reason': { equals: reason } }] }, limit: 20, depth: 0, overrideAccess: true })
  }

  it('records a bounded privacy-safe decision for uninvited and wrong-provider callbacks', async () => {
    issuerState.email = 'uninvited@example.test'
    issuerState.subject = 'uninvited-subject'
    const state = 'uninvited-state'
    const transaction = await payload.create({ collection: 'auth-transactions', data: { stateHash: hashOpaqueToken(state), nonce: issuerState.nonce, verifier: issuerState.verifier, provider: 'google', expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
    const request = () => new Request(`http://localhost/api/auth/callback/google?code=accepted-code&state=${state}`, { headers: { cookie: `${cookieName(OIDC_TRANSACTION_COOKIE)}=${hashOpaqueToken(state)}` } })
    expect((await invoke(request())).status).toBe(403)
    expect((await invoke(request())).status).toBe(403)

    const uninvited = await auditByReason('invitation_not_authorized')
    const matching = uninvited.docs.filter((event: any) => event.detail?.transactionID === String(transaction.id))
    expect(matching).toHaveLength(1)
    expect(matching[0]).toMatchObject({ detail: { provider: 'google', reason: 'invitation_not_authorized', transactionID: String(transaction.id) } })
    expect(JSON.stringify(matching[0])).not.toContain(issuerState.email)
    expect(JSON.stringify(matching[0])).not.toContain('accepted-code')

    const wrong = await createSignIn('wrong-provider@example.test', 'wrong-provider-subject')
    const wrongResponse = await callback(wrong.request(), { params: Promise.resolve({ provider: 'microsoft' }) })
    expect(wrongResponse.status).toBe(400)
    const wrongTransaction = await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: hashOpaqueToken(wrong.state) } }, limit: 1, depth: 0, overrideAccess: true })
    const wrongAudit = await auditByReason('transaction_provider_mismatch')
    const wrongMatching = wrongAudit.docs.filter((event: any) => event.detail?.transactionID === String(wrongTransaction.docs[0]!.id))
    expect(wrongMatching).toHaveLength(1)
    expect(wrongMatching[0]).toMatchObject({ detail: { provider: 'microsoft', reason: 'transaction_provider_mismatch' } })
  })

  it('atomically records one privacy-safe provider mismatch denial for concurrent callbacks', async () => {
    const mismatch = await createSignIn('concurrent-mismatch@example.test', 'concurrent-mismatch-subject')
    const invokeMismatch = () => callback(mismatch.request(), { params: Promise.resolve({ provider: 'microsoft' }) })
    const responses = await Promise.all([invokeMismatch(), invokeMismatch()])
    expect(responses.map(response => response.status)).toEqual([400, 400])

    const transaction = await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: hashOpaqueToken(mismatch.state) } }, limit: 1, depth: 0, overrideAccess: true })
    const transactionID = String(transaction.docs[0]!.id)
    const denials = await callbackDenials(transactionID, 'transaction_provider_mismatch')
    expect(denials).toHaveLength(1)
    expectPrivacySafeCallbackDenial(denials[0], {
      transactionID,
      provider: 'microsoft',
      reason: 'transaction_provider_mismatch',
      secrets: [mismatch.state, 'accepted-code', 'concurrent-mismatch@example.test', 'concurrent-mismatch-subject', issuerState.nonce, issuerState.verifier],
    })
  })

  it('atomically records one privacy-safe identity validation failure for concurrent callbacks', async () => {
    const failed = await createSignIn('concurrent-validation@example.test', 'concurrent-validation-subject')
    const rejectedCode = 'rejected-authorization-code'
    const responses = await Promise.all([invoke(failed.request(rejectedCode)), invoke(failed.request(rejectedCode))])
    expect(responses.map(response => response.status)).toEqual([401, 401])

    const transaction = await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: hashOpaqueToken(failed.state) } }, limit: 1, depth: 0, overrideAccess: true })
    const transactionID = String(transaction.docs[0]!.id)
    const denials = await callbackDenials(transactionID, 'identity_verification_failed')
    expect(denials).toHaveLength(1)
    expectPrivacySafeCallbackDenial(denials[0], {
      transactionID,
      provider: 'google',
      reason: 'identity_verification_failed',
      secrets: [failed.state, rejectedCode, 'concurrent-validation@example.test', 'concurrent-validation-subject', issuerState.nonce, issuerState.verifier],
    })
  })

  it('records disabled enrolled identities without consuming enrollment or leaking claims', async () => {
    const disabled = await payload.create({ collection: 'users', data: { email: 'disabled@example.test', name: 'Disabled', roles: ['editor'], disabled: true, provider: 'google', providerIssuer: issuerState.issuer, providerSubject: 'disabled-subject' }, overrideAccess: true })
    const { invitation, request, state } = await createSignIn('disabled@example.test', 'disabled-subject')
    expect((await invoke(request())).status).toBe(403)

    const audit = await auditByReason('identity_disabled')
    expect(audit.docs).toHaveLength(1)
    expect(audit.docs[0]).toMatchObject({ user: disabled.id, detail: { provider: 'google', reason: 'identity_disabled' } })
    expect(JSON.stringify(audit.docs[0])).not.toContain('disabled@example.test')
    const transaction = await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: hashOpaqueToken(state) } }, limit: 1, overrideAccess: true })
    expect(transaction.docs[0]?.consumedAt).toBeNull()
    expect((await payload.findByID({ collection: 'invitations', id: invitation.id, overrideAccess: true })).acceptedAt).toBeNull()
  })
})
