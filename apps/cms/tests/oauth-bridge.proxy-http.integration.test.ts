import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, test } from 'vitest'
import { getPayload } from 'payload'
import { createAIWorkerAPI } from '../scripts/run-ai-worker.mjs'
import { hashOpaqueToken, newOpaqueToken, SESSION_COOKIE } from '../src/identity'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-oauth-proxy-http-'))
const bridgeSecret = 'synthetic-proxy-bridge-secret'
const aiWorkerToken = 'synthetic-ai-worker-token-for-proxy-http-tests'
const port = await new Promise<number>((resolve) => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => {
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    server.close(() => resolve(address.port))
  })
})
const origin = `http://127.0.0.1:${port}`
const cmsRoot = fileURLToPath(new URL('../', import.meta.url))
Object.assign(process.env, {
  DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`,
  PAYLOAD_SECRET: 'synthetic-proxy-http-payload-secret-not-for-production',
  PAYLOAD_PUBLIC_SERVER_URL: origin,
  OAUTH_BRIDGE_SECRET: bridgeSecret,
  AI_WORKER_TOKEN: aiWorkerToken,
})
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
let next: ChildProcess | undefined
let build: ChildProcess | undefined

function runNext(args: string[]): Promise<void> {
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', ...args], { cwd: cmsRoot, env: process.env, stdio: 'ignore' })
  build = child
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Next ${args[0]} exited with ${code}`)))
  })
}

async function ready(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { if ((await fetch(`${origin}/api/health`)).ok) return } catch { /* server is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('isolated CMS Next server did not become ready')
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const user = await payload.create({ collection: 'users', data: { email: 'proxy-bridge@example.test', name: 'Proxy bridge', roles: ['editor'] }, overrideAccess: true })
  // Cold production compilation is slower on CI; it must not consume the
  // lifetime of the authentication session this test is about to exercise.
  await runNext(['build'])
  const token = newOpaqueToken(); const now = new Date().toISOString()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(token), user: user.id, authenticatedAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
  // `next start` uses production cookie naming even though Vitest itself is
  // running with NODE_ENV=test.
  process.env.SYNTHETIC_PROXY_SESSION_COOKIE = `${SESSION_COOKIE}=${token}`
  next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: cmsRoot, env: process.env, stdio: 'ignore' })
  await ready()
}, 180_000)

afterAll(async () => {
  if (build?.exitCode === null) { build.kill('SIGTERM'); await new Promise<void>(resolve => build!.once('exit', () => resolve())) }
  if (next?.exitCode === null) {
    next.kill('SIGTERM')
    await new Promise<void>((resolve) => next!.once('exit', () => resolve()))
  }
  await payload?.destroy()
  rmSync(directory, { recursive: true, force: true })
  for (const key of ['DATABASE_URI', 'PAYLOAD_SECRET', 'PAYLOAD_PUBLIC_SERVER_URL', 'OAUTH_BRIDGE_SECRET', 'AI_WORKER_TOKEN', 'SYNTHETIC_PROXY_SESSION_COOKIE']) delete process.env[key]
})

test('actual Next proxy exempts only the secret-authenticated OAuth bridge from Origin CSRF', async () => {
  const valid = await fetch(`${origin}/api/internal/oauth/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-oauth-bridge-secret': bridgeSecret, cookie: process.env.SYNTHETIC_PROXY_SESSION_COOKIE! }, body: JSON.stringify({ operation: 'resolve' }) })
  assert.equal(valid.status, 200)
  assert.deepEqual((await valid.json()).user.scopes, ['mcp:content:read', 'mcp:content:write', 'mcp:redirects:read', 'mcp:redirects:write'])
  for (const supplied of [undefined, 'wrong-secret']) {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (supplied) headers.set('x-oauth-bridge-secret', supplied)
    const denied = await fetch(`${origin}/api/internal/oauth/session`, { method: 'POST', headers, body: JSON.stringify({ operation: 'validate', userId: 'any', sessionId: 'any' }) })
    assert.equal(denied.status, 401)
  }
  const normalCookieApi = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { cookie: process.env.SYNTHETIC_PROXY_SESSION_COOKIE! } })
  assert.equal(normalCookieApi.status, 403)
  const otherInternalPath = await fetch(`${origin}/api/internal/oauth/other`, { method: 'POST' })
  assert.equal(otherInternalPath.status, 403)
}, 45_000)

test('actual Next proxy admits only the exact authenticated AI worker endpoint without Origin', async () => {
  const worker = createAIWorkerAPI({ cmsOrigin: origin, token: aiWorkerToken })
  assert.equal(await worker(), null)

  for (const supplied of [undefined, 'wrong-ai-worker-token-for-proxy-http-tests']) {
    const headers = new Headers()
    if (supplied) headers.set('authorization', `Bearer ${supplied}`)
    const denied = await fetch(`${origin}/api/internal/ai-worker/run`, { method: 'POST', headers })
    assert.equal(denied.status, 401)
  }

  const browserMutation = await fetch(`${origin}/api/ai-jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(browserMutation.status, 403)
  for (const method of ['PUT', 'PATCH']) {
    const denied = await fetch(`${origin}/api/internal/ai-worker/run`, { method })
    assert.equal(denied.status, 403)
  }
  for (const path of ['/api/internal/ai-worker/other', '/api/internal/ai-worker/run/other']) {
    const denied = await fetch(`${origin}${path}`, { method: 'POST' })
    assert.equal(denied.status, 403)
  }
}, 45_000)
