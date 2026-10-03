import { getPayload } from 'payload'
import config from '../payload.config'
import { ensureSQLiteDirectory } from '../src/sqlite'

const [email, name] = process.argv.slice(2)
const tokenFile = process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE
const token = tokenFile ? (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() : undefined

if (!email || !name || !token) {
  throw new Error('Usage: BOOTSTRAP_OPERATOR_TOKEN_FILE=/secure/token pnpm bootstrap:operator <email> <name>')
}

ensureSQLiteDirectory()
const payload = await getPayload({ config })
const existing = await payload.find({ collection: 'users', limit: 1, overrideAccess: true })
if (existing.totalDocs > 0) throw new Error('An operator already exists; use the authenticated admin invitation flow.')

await payload.create({
  collection: 'users',
  data: { email, name, roles: ['owner'], invitedAt: new Date().toISOString() },
  overrideAccess: false,
  context: { bootstrapOperatorToken: token },
})
console.info(`Created the initial owner for ${email}. Remove the token-file mount from the runtime service now.`)
