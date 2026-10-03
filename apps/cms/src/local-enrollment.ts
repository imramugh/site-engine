import { randomBytes } from 'node:crypto'
import { lstatSync, openSync, closeSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs'
import type { Payload } from 'payload'
import { Secret } from 'otpauth'
import { withPayloadTransaction } from './auth-transaction'
import { encryptSecret, recoveryHash } from './totp'

export class LocalOwnerBootstrapError extends Error {}
export type LocalOwnerCredentials = { email: string; otpauthURI: string; base32seed: string; recoverycodes: string[] }

export function writeLocalOwnerCredentials(path: string, credentials: LocalOwnerCredentials): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new LocalOwnerBootstrapError('Credential output must not be a symlink.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8' })
    fsyncSync(fd)
  } catch (error) {
    try { unlinkSync(path) } catch { /* Preserve the original write failure. */ }
    throw error
  } finally {
    closeSync(fd)
  }
}

export async function createLocalOwner(payload: Payload, input: { email: string; name: string; credentialsFile: string }) {
  const seed = new Secret({ size: 20 }).base32
  const recoverycodes = Array.from({ length: 8 }, () => randomBytes(10).toString('base64url'))
  const credentials = { email: input.email, otpauthURI: `otpauth://totp/Site%20Engine:${encodeURIComponent(input.email)}?secret=${seed}&issuer=Site%20Engine`, base32seed: seed, recoverycodes }
  writeLocalOwnerCredentials(input.credentialsFile, credentials)
  try {
    await withPayloadTransaction(payload, async (req) => {
      const users = await payload.count({ collection: 'users', overrideAccess: true, req })
      const invites = await payload.count({ collection: 'invitations', where: { acceptedAt: { equals: null }, expiresAt: { greater_than: new Date().toISOString() } }, overrideAccess: true, req })
      if (users.totalDocs || invites.totalDocs) throw new LocalOwnerBootstrapError('Local owner bootstrap is available only before users or live invitations exist.')
      const user = await payload.create({ collection: 'users', data: { email: input.email, name: input.name, roles: ['owner'], emergencyTotpSecret: encryptSecret(seed), emergencyRecoveryHashes: recoverycodes.map(recoveryHash), emergencyFailedCount: 0 }, overrideAccess: true, req })
      await payload.create({ collection: 'audit-events', data: { event: 'identity.local_owner_bootstrapped', user: user.id, detail: { source: 'operator-cli' } }, overrideAccess: true, req })
    })
  } catch (error) {
    try { unlinkSync(input.credentialsFile) } catch { /* Preserve the enrollment failure. */ }
    throw error
  }
}
