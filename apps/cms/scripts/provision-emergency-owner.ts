import { randomBytes } from 'node:crypto'
import { getPayload } from 'payload'
import { Secret } from 'otpauth'
import config from '../payload.config'
import { encryptSecret, recoveryHash } from '../src/totp'

const [email] = process.argv.slice(2)
if (!email) throw new Error('Usage: EMERGENCY_TOTP_ENCRYPTION_KEY=… pnpm tsx scripts/provision-emergency-owner.ts <owner-email>')
const payload = await getPayload({ config })
const found = await payload.find({ collection: 'users', where: { email: { equals: email } }, limit: 1, overrideAccess: true })
const owner = found.docs[0]
if (!owner || !owner.roles.includes('owner')) throw new Error('Emergency authentication can only be provisioned for an existing Owner.')
const secret = new Secret({ size: 20 }).base32
const recovery = Array.from({ length: 8 }, () => randomBytes(10).toString('base64url'))
await payload.update({ collection: 'users', id: owner.id, data: { emergencyTotpSecret: encryptSecret(secret), emergencyRecoveryHashes: recovery.map(recoveryHash), emergencyFailedCount: 0, emergencyFailedAt: null, emergencyLastCounter: null }, overrideAccess: true })
console.info(`TOTP secret (show once): ${secret}`)
console.info(`Recovery codes (show once):\n${recovery.join('\n')}`)

await payload.destroy()
