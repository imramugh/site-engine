import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'vitest'

async function port(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test('compiled CLI starts when Node receives its relative Docker command path', async () => {
  const listenPort = await port()
  assert(existsSync(join(import.meta.dirname, '../dist/server.js')), 'Build workspace packages before running the compiled CLI test.')
  const directory = mkdtempSync(join(tmpdir(), 'site-engine-oauth-entrypoint-'))
  const databasePath = join(directory, 'oauth.sqlite')
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })
  const child = spawn(process.execPath, ['apps/oauth/dist/server.js'], {
    cwd: join(import.meta.dirname, '../../..'),
    env: {
      ...process.env, PORT: String(listenPort), OAUTH_ISSUER: `http://127.0.0.1:${listenPort}/oauth`, OAUTH_RESOURCE: `http://127.0.0.1:${listenPort}/mcp`, OAUTH_DATABASE_PATH: databasePath,
      OAUTH_COOKIE_KEYS: 'entrypoint-cookie-key-one,entrypoint-cookie-key-two', OAUTH_JWKS: JSON.stringify({ keys: [{ ...jwk, kid: 'entrypoint-key', use: 'sig', alg: 'RS256' }] }),
    },
    stdio: 'ignore',
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    let response: Response | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, 'Compiled OAuth server exited before becoming ready.')
      try { response = await fetch(`http://127.0.0.1:${listenPort}/.well-known/oauth-protected-resource/mcp`) } catch {}
      if (response?.ok) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(response?.status, 200)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)
