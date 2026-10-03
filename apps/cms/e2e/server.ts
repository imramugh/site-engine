import { createServer as createHTTPServer, request as requestUpstream, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { getPayload } from 'payload'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { hashOpaqueToken } from '../src/identity.js'
import { encryptSecret, recoveryHash } from '../src/totp.js'

const e2ePort = Number(process.env.CMS_E2E_PORT ?? 4300)
const cmsOrigin = `https://127.0.0.1:${e2ePort}`
const issuerOrigin = `https://127.0.0.1:${e2ePort + 1}`
const clientID = 'synthetic-browser-client'
const clientSecret = 'synthetic-browser-secret'
const inviteToken = 'synthetic-browser-owner-invite'
const encryptedFixture = 'synthetic-encrypted-secret-sentinel'
const recoveryFixture = 'synthetic-recovery-hash-sentinel'
const emergencyEmail = 'emergency-owner.synthetic@example.test'
const emergencyRecoveryCode = 'synthetic-recovery-code-01'
const localOwnerRecoveryCode = 'synthetic-local-recovery-code-02'
const localOwnerDisableRecoveryCode = 'synthetic-local-recovery-code-03'
const reviewOwnerEmail = 'review-owner.synthetic@example.test'
const reviewOwnerRecoveryCode = 'synthetic-review-owner-code-04'
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'site-engine-cms-e2e-'))
const databasePath = join(temporaryDirectory, 'cms.sqlite')
const bootstrapPath = join(temporaryDirectory, 'bootstrap-token')
const caCertificate = join(temporaryDirectory, 'synthetic-ca.pem')
const caKey = join(temporaryDirectory, 'synthetic-ca.key')
const serverCertificate = join(temporaryDirectory, 'synthetic-issuer.pem')
const serverKey = join(temporaryDirectory, 'synthetic-issuer.key')
const certificateRequest = join(temporaryDirectory, 'synthetic-issuer.csr')
const certificateExtensions = join(temporaryDirectory, 'synthetic-issuer.ext')
const initialPreviewBaseline = join(temporaryDirectory, 'initial-preview-baseline.json')
writeFileSync(bootstrapPath, 'synthetic-browser-bootstrap-token')
writeFileSync(initialPreviewBaseline, JSON.stringify(neutralFixture))

Object.assign(process.env, { NODE_ENV: 'test' })
process.env.DATABASE_URI = `file:${databasePath}`
process.env.MEDIA_STORAGE_DIR = join(temporaryDirectory, 'media')
process.env.PAYLOAD_SECRET = 'synthetic-browser-payload-secret-not-for-production'
process.env.PAYLOAD_PUBLIC_SERVER_URL = cmsOrigin
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = bootstrapPath
process.env.OIDC_GOOGLE_ISSUER_URL = issuerOrigin
process.env.OIDC_GOOGLE_CLIENT_ID = clientID
process.env.OIDC_GOOGLE_CLIENT_SECRET = clientSecret
process.env.EMERGENCY_TOTP_ENCRYPTION_KEY = randomBytes(32).toString('base64url')
process.env.INITIAL_PUBLISH_BASELINE_FILE = initialPreviewBaseline
process.env.PREVIEW_THEME_VERSION = 'synthetic-theme'
process.env.PREVIEW_ENGINE_VERSION = 'synthetic-engine'
process.env.PREVIEW_CONTRACT_VERSION = neutralFixture.settings.contractVersion
process.env.PREVIEW_WORKER_TOKEN = 'synthetic-preview-worker-token-long-enough-for-browser-tests'

type Identity = { email: string; name: string; subject: string }
type Authorization = { challenge: string; nonce: string; redirectURI: string; identity: Identity }
const identities: Record<'editor' | 'owner', Identity> = {
  owner: { email: 'owner.synthetic@example.test', name: 'Synthetic Owner', subject: 'synthetic-owner' },
  editor: { email: 'editor.synthetic@example.test', name: 'Synthetic Editor', subject: 'synthetic-editor' },
}
const authorizations = new Map<string, Authorization>()
let privateKey: CryptoKey
let jwk: Record<string, unknown>
let payload: Awaited<ReturnType<typeof getPayload>>
let issuer: ReturnType<typeof createServer>
let cmsProxy: ReturnType<typeof createServer>
let readiness: ReturnType<typeof createHTTPServer>
let next: ChildProcess | undefined
let stopping = false
let localOwnerID: string | undefined
let reviewOwnerID: string | undefined

function createCertificates(): void {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes', '-keyout', caKey, '-out', caCertificate, '-subj', '/CN=site-engine-e2e-ca', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' })
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', serverKey, '-out', certificateRequest, '-subj', '/CN=localhost'], { stdio: 'ignore' })
  writeFileSync(certificateExtensions, 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n')
  execFileSync('openssl', ['x509', '-req', '-in', certificateRequest, '-CA', caCertificate, '-CAkey', caKey, '-CAcreateserial', '-out', serverCertificate, '-days', '1', '-sha256', '-extfile', certificateExtensions], { stdio: 'ignore' })
}

function readBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(new URLSearchParams(body)))
    request.on('error', reject)
  })
}

function html(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function provider(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || '/', issuerOrigin)
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(response, { issuer: issuerOrigin, authorization_endpoint: `${issuerOrigin}/authorize`, token_endpoint: `${issuerOrigin}/token`, jwks_uri: `${issuerOrigin}/jwks`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], id_token_signing_alg_values_supported: ['RS256'] })
  }
  if (url.pathname === '/jwks') return json(response, { keys: [{ ...jwk, alg: 'RS256', kid: 'synthetic-browser-key', use: 'sig' }] })
  if (url.pathname === '/cross-origin-post') {
    return html(response, `<form action="${cmsOrigin}/api/auth/logout" method="post"><button>Submit cross-origin logout</button></form>`)
  }
  if (url.pathname === '/authorize' && request.method === 'GET') {
    const redirectURI = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state')
    const nonce = url.searchParams.get('nonce')
    const challenge = url.searchParams.get('code_challenge')
    if (!redirectURI || !state || !nonce || !challenge || url.searchParams.get('client_id') !== clientID) return html(response, 'Invalid synthetic authorization request.', 400)
    const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`
    return html(response, `<main><h1>Synthetic identity provider</h1><form method="post" action="/authorize">${hidden('redirect_uri', redirectURI)}${hidden('state', state)}${hidden('nonce', nonce)}${hidden('code_challenge', challenge)}<button name="identity" value="owner">Sign in as Synthetic Owner</button><button name="identity" value="editor">Sign in as Synthetic Editor</button></form></main>`)
  }
  if (url.pathname === '/authorize' && request.method === 'POST') {
    const form = await readBody(request)
    const choice = form.get('identity')
    const identity = choice === 'owner' || choice === 'editor' ? identities[choice] : undefined
    const redirectURI = form.get('redirect_uri')
    const state = form.get('state')
    const nonce = form.get('nonce')
    const challenge = form.get('code_challenge')
    if (!identity || !redirectURI || !state || !nonce || !challenge || !redirectURI.startsWith(`${cmsOrigin}/api/auth/callback/google`)) return html(response, 'Invalid synthetic authorization request.', 400)
    const code = randomUUID()
    authorizations.set(code, { challenge, nonce, redirectURI, identity })
    response.writeHead(303, { location: `${redirectURI}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, 'cache-control': 'no-store' })
    response.end()
    return
  }
  if (url.pathname === '/token' && request.method === 'POST') {
    const form = await readBody(request)
    const authorization = form.get('code') ? authorizations.get(form.get('code')!) : undefined
    const verifier = form.get('code_verifier')
    const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : ''
    const basicCredentials = `Basic ${Buffer.from(`${clientID}:${clientSecret}`).toString('base64')}`
    const clientAuthenticated = request.headers.authorization === basicCredentials || (form.get('client_id') === clientID && form.get('client_secret') === clientSecret)
    if (!authorization || !clientAuthenticated || form.get('redirect_uri') !== authorization.redirectURI || challenge !== authorization.challenge) {
      return json(response, { error: 'invalid_grant' }, 400)
    }
    authorizations.delete(form.get('code')!)
    const idToken = await new SignJWT({ email: authorization.identity.email, email_verified: true, name: authorization.identity.name, nonce: authorization.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-browser-key' })
      .setIssuer(issuerOrigin).setAudience(clientID).setSubject(authorization.identity.subject).setIssuedAt().setExpirationTime('5m').sign(privateKey)
    return json(response, { access_token: 'synthetic-access-token', id_token: idToken, token_type: 'Bearer' })
  }
  html(response, 'Not found', 404)
}

async function seed(): Promise<void> {
  const { default: config } = await import('../payload.config.js')
  payload = await getPayload({ config })
  await payload.create({ collection: 'users', data: { email: identities.editor.email, name: identities.editor.name, roles: ['editor'], provider: 'google', providerIssuer: issuerOrigin, providerSubject: identities.editor.subject, emergencyTotpSecret: encryptedFixture, emergencyRecoveryHashes: [recoveryFixture] }, overrideAccess: true })
  const localOwner = await payload.create({ collection: 'users', data: { email: emergencyEmail, name: 'Synthetic Emergency Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash(emergencyRecoveryCode), recoveryHash(localOwnerRecoveryCode), recoveryHash(localOwnerDisableRecoveryCode)] }, overrideAccess: true })
  localOwnerID = String(localOwner.id)
  const reviewOwner = await payload.create({ collection: 'users', data: { email: reviewOwnerEmail, name: 'Synthetic Review Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash(reviewOwnerRecoveryCode)] }, overrideAccess: true })
  reviewOwnerID = String(reviewOwner.id)
  await payload.create({ collection: 'users', data: { email: 'content-owner.synthetic@example.test', name: 'Synthetic Content Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash('synthetic-content-owner-code-05'), recoveryHash('synthetic-intake-owner-code-06')] }, overrideAccess: true })
  await payload.create({ collection: 'invitations', data: { email: identities.owner.email, provider: 'google', providerIssuer: issuerOrigin, providerSubject: identities.owner.subject, requiredSubject: identities.owner.subject, roles: ['owner'], tokenHash: hashOpaqueToken(inviteToken), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }, overrideAccess: true })
}

function forwardCMS(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === 'GET' && /^\/preview\/changes\/[0-9a-f-]+\/(live|proposed)(?:\/[^?]*)?(?:\?.*)?$/i.test(request.url ?? '')) {
    html(response, '<!doctype html><title>Synthetic private comparison</title><main>Authenticated private comparison fixture</main>')
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/owner/disable') {
    void payload.find({ collection: 'users', where: { providerSubject: { equals: identities.owner.subject } }, limit: 1, overrideAccess: true })
      .then(({ docs }) => docs[0] ? payload.update({ collection: 'users', id: docs[0].id, data: { disabled: true }, overrideAccess: true }) : Promise.reject(new Error('Owner missing')))
      .then(() => { response.writeHead(204); response.end() })
      .catch(() => { response.writeHead(500); response.end('Unable to disable owner.') })
    return
  }
  // The public contact artifact is served under the same synthetic TLS origin
  // as CMS, just as the production edge routes public pages and /api together.
  // This makes the browser exercise the real Astro form, not a CMS preview.
  const pathname = new URL(request.url || '/', cmsOrigin).pathname
  const staticPath = pathname === '/general/gallery' || pathname === '/general/gallery/'
    ? join(process.cwd(), '..', 'site', 'dist', 'general', 'gallery', 'index.html')
    : pathname.startsWith('/_astro/') ? join(process.cwd(), '..', 'site', 'dist', pathname) : undefined
  if (request.method === 'GET' && staticPath && existsSync(staticPath)) {
    response.writeHead(200, { 'content-type': staticPath.endsWith('.html') ? 'text/html; charset=utf-8' : staticPath.endsWith('.css') ? 'text/css' : 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
    response.end(readFileSync(staticPath))
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/local-owner/disable') {
    void payload.update({ collection: 'users', id: localOwnerID!, data: { disabled: true }, overrideAccess: true })
      .then(() => { response.writeHead(204); response.end() })
      .catch(() => { response.writeHead(500); response.end('Unable to disable local owner.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/review-owner/disable') {
    void payload.update({ collection: 'users', id: reviewOwnerID!, data: { disabled: true }, overrideAccess: true })
      .then(() => { response.writeHead(204); response.end() })
      .catch(() => { response.writeHead(500); response.end('Unable to disable review owner.') })
    return
  }
  const upstream = requestUpstream({
    hostname: '127.0.0.1', port: e2ePort + 2, method: request.method, path: request.url,
    headers: { ...request.headers, host: `127.0.0.1:${e2ePort}`, 'x-forwarded-host': `127.0.0.1:${e2ePort}`, 'x-forwarded-proto': 'https' },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(response)
  })
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('CMS is starting.') })
  request.pipe(upstream)
}

async function stop(code = 0): Promise<void> {
  if (stopping) return
  stopping = true
  next?.kill('SIGTERM')
  issuer?.close()
  cmsProxy?.close()
  readiness?.close()
  await payload?.destroy()
  rmSync(temporaryDirectory, { recursive: true, force: true })
  process.exit(code)
}

function runNext(args: string[], keepRunning = false): Promise<ChildProcess> {
  const child = spawn('corepack', ['pnpm@12.8.1', '--filter', '@site-engine/cms', 'exec', 'next', ...args], { cwd: process.cwd(), env: { ...process.env, NODE_EXTRA_CA_CERTS: caCertificate }, stdio: 'inherit' })
  if (keepRunning) return Promise.resolve(child)
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (status) => status === 0 ? resolve(child) : reject(new Error(`Next command exited with ${status ?? 'no'} status.`)))
  })
}

async function main(): Promise<void> {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  jwk = await exportJWK(pair.publicKey)
  createCertificates()
  issuer = createServer({ key: readFileSync(serverKey), cert: readFileSync(serverCertificate) }, (request, response) => { void provider(request, response).catch(() => html(response, 'Synthetic provider failed.', 500)) })
  issuer.listen(e2ePort + 1, '127.0.0.1')
  await once(issuer, 'listening')
  cmsProxy = createServer({ key: readFileSync(serverKey), cert: readFileSync(serverCertificate) }, forwardCMS)
  cmsProxy.listen(e2ePort, '127.0.0.1')
  await once(cmsProxy, 'listening')
  await seed()
  await runAstroBuild()
  await runNext(['build'])
  const appDirectory = process.cwd()
  const standaloneDirectory = join(appDirectory, '.next', 'standalone', 'apps', 'cms')
  // Next's standalone output deliberately omits static/public files; production
  // image assembly copies these too. Do the same here so the browser validates
  // the hydrated Payload admin rather than an empty HTML shell.
  cpSync(join(appDirectory, '.next', 'static'), join(standaloneDirectory, '.next', 'static'), { recursive: true })
  if (existsSync(join(appDirectory, 'public'))) cpSync(join(appDirectory, 'public'), join(standaloneDirectory, 'public'), { recursive: true })
  next = spawn(process.execPath, [join(standaloneDirectory, 'server.js')], {
    cwd: process.cwd(),
    env: { ...process.env, HOSTNAME: '127.0.0.1', NODE_EXTRA_CA_CERTS: caCertificate, PORT: String(e2ePort + 2) },
    stdio: 'inherit',
  })
  next.once('exit', (status) => { if (!stopping) void stop(status ?? 1) })
  await new Promise<void>((resolve, reject) => {
    const retry = () => Date.now() > deadline ? reject(new Error('CMS standalone server did not become ready.')) : setTimeout(check, 100)
    const deadline = Date.now() + 30_000
    const check = () => {
      const probe = requestUpstream({ hostname: '127.0.0.1', port: e2ePort + 2, path: '/api/health' }, (response) => { response.resume(); response.statusCode === 200 ? resolve() : retry() })
      probe.once('error', retry).end()
    }
    check()
  })
  readiness = createHTTPServer((_request, response) => { response.writeHead(200); response.end('ready') })
  readiness.listen(e2ePort + 3, '127.0.0.1')
  await once(readiness, 'listening')
}

function runAstroBuild(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('corepack', ['pnpm@12.8.1', '--filter', '@site-engine/site', 'build'], { cwd: process.cwd(), env: { ...process.env, SITE_PUBLIC_ORIGIN: cmsOrigin }, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (status) => status === 0 ? resolve() : reject(new Error(`Astro build exited with ${status ?? 'no'} status.`)))
  })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stop() })
void main().catch((error) => { console.error(error instanceof Error ? error.message : 'Unable to start synthetic CMS identity server.'); void stop(1) })
