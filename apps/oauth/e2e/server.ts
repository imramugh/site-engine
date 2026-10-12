import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOAuthService, type SessionUser } from '../src/index.ts'

const port = Number(process.env.OAUTH_E2E_PORT ?? '4312')
const origin = `http://127.0.0.1:${port}`
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'site-engine-oauth-e2e-'))
const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' })

function sessionFrom(request: Parameters<NonNullable<Parameters<typeof createOAuthService>[0]['sessionBridge']>['resolve']>[0]): SessionUser | undefined {
  const value = /(?:^|;\s*)oauth_e2e_session=([^;]+)/.exec(request.headers.cookie ?? '')?.[1]
  if (value === 'staff') return { id: 'synthetic-staff', sessionId: 'synthetic-staff-session', enabled: true, scopes: ['mcp:content:read', 'mcp:leads:read'] }
  if (value === 'other') return { id: 'synthetic-other', sessionId: 'synthetic-other-session', enabled: true, scopes: ['mcp:content:read'] }
  if (value === 'disabled') return { id: 'synthetic-disabled', sessionId: 'synthetic-disabled-session', enabled: false, scopes: ['mcp:content:read'] }
  return undefined
}

const service = createOAuthService({
  issuer: `${origin}/oauth`, resource: `${origin}/mcp`, databasePath: join(fixtureDirectory, 'oauth.sqlite'),
  cookieKeys: ['synthetic-oauth-e2e-cookie-key-one', 'synthetic-oauth-e2e-cookie-key-two'],
  jwks: { keys: [{ ...signingKey, kid: 'oauth-e2e-key', use: 'sig', alg: 'RS256' }] },
  sessionBridge: {
    resolve: async request => sessionFrom(request),
    find: async (id, sessionId) => {
      const users = [
        { id: 'synthetic-staff', sessionId: 'synthetic-staff-session', enabled: true, scopes: ['mcp:content:read', 'mcp:leads:read'] },
        { id: 'synthetic-other', sessionId: 'synthetic-other-session', enabled: true, scopes: ['mcp:content:read'] },
      ] as const
      return users.find(user => user.id === id && user.sessionId === sessionId)
    },
  },
  brandingDirectory: process.env.OAUTH_E2E_BRANDING_DIR || undefined,
})

service.server.listen(port, '127.0.0.1')
