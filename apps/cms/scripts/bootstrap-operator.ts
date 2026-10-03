import { getPayload } from 'payload'
import config from '../payload.config'
import { ensureSQLiteDirectory } from '../src/sqlite'
import { hashOpaqueToken, newOpaqueToken, type IdentityProvider } from '../src/identity'
import { configuredProvider } from '../src/oidc'

const [email, name, provider, providerSubject] = process.argv.slice(2)
const tokenFile = process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE
const token = tokenFile ? (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() : undefined

if (!email || !name || !token || (provider !== 'google' && provider !== 'microsoft') || !providerSubject) {
  throw new Error('Usage: BOOTSTRAP_OPERATOR_TOKEN_FILE=/secure/token pnpm bootstrap:operator <email> <name> <google|microsoft> <verified-provider-subject>')
}

ensureSQLiteDirectory()
const settings = configuredProvider(provider as IdentityProvider)
if (!settings) throw new Error('Configure the selected OIDC provider before bootstrapping the initial owner.')
const payload = await getPayload({ config })
const existing = await payload.find({ collection: 'users', limit: 1, overrideAccess: true })
if (existing.totalDocs > 0) throw new Error('An operator already exists; use the authenticated admin invitation flow.')

await payload.create({
  collection: 'users',
  data: { email, name, roles: ['owner'], invitedAt: new Date().toISOString(), provider, providerIssuer: settings.issuer, providerSubject },
  overrideAccess: false,
  context: { bootstrapOperatorToken: token },
})
const invite = newOpaqueToken()
await payload.create({
  collection: 'invitations',
  data: { email, provider: provider as IdentityProvider, providerIssuer: settings.issuer, providerSubject, roles: ['owner'], tokenHash: hashOpaqueToken(invite), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
  overrideAccess: true,
})
const baseURL = process.env.PAYLOAD_PUBLIC_SERVER_URL
console.info(`Created the initial owner for ${email}. Copy this one-time sign-in link through an approved channel: ${baseURL}/api/auth/${provider}?invite=${invite}`)
console.info('Remove the token-file mount from the runtime service now.')
