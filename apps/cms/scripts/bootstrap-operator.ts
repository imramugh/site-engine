import { getPayload } from 'payload'
import config from '../payload.config'
import { ensureSQLiteDirectory } from '../src/sqlite'
import { type IdentityProvider } from '../src/identity'
import { configuredProvider } from '../src/oidc'
import { createInitialOwnerInvitation } from '../src/invitation-enrollment'

const [email, name, provider, providerSubject] = process.argv.slice(2)
const tokenFile = process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE
const token = tokenFile ? (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() : undefined

if (!email || !name || !token || !/^[A-Za-z0-9_-]{20,}$/.test(token) || (provider !== 'google' && provider !== 'microsoft')) {
  throw new Error('Usage: BOOTSTRAP_OPERATOR_TOKEN_FILE=/secure/token pnpm bootstrap:operator <email> <name> <google|microsoft> [prebound-provider-subject]')
}

ensureSQLiteDirectory()
const settings = configuredProvider(provider as IdentityProvider)
if (!settings) throw new Error('Configure the selected OIDC provider before bootstrapping the initial owner.')
const payload = await getPayload({ config })
try {
  const invite = await createInitialOwnerInvitation(payload, { email: email.trim().toLowerCase(), provider: provider as IdentityProvider, providerIssuer: settings.issuer, providerSubject })
  const baseURL = process.env.PAYLOAD_PUBLIC_SERVER_URL
  console.info(`Created initial enrollment for ${name} (${email}). Copy this one-time sign-in link through an approved channel: ${baseURL}/api/auth/${provider}?invite=${invite}`)
  console.info('Remove the token-file mount from the runtime service now.')
} finally {
  await payload.destroy()
}
