import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPayload, type Payload } from 'payload'
import {
  createLocalOwner,
  LocalOwnerBootstrapError,
  type LocalOwnerCredentials,
  writeLocalOwnerCredentials,
} from '../src/local-enrollment'

type SQLiteAdapter = {
  client: {
    execute: (statement: string) => Promise<unknown>
  }
}

const directory = mkdtempSync(join(tmpdir(), 'site-engine-local-owner-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-long-enough'
process.env.EMERGENCY_TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url')

let payload: Payload

function outputPath(name: string): string {
  return join(directory, name)
}

function sqlite() {
  return (payload.db as unknown as SQLiteAdapter).client
}

async function ownerCount(): Promise<number> {
  return (
    await payload.count({
      collection: 'users',
      where: { roles: { contains: 'owner' } },
      overrideAccess: true,
    })
  ).totalDocs
}

async function auditCount(): Promise<number> {
  return (
    await payload.count({
      collection: 'audit-events',
      where: { event: { equals: 'identity.local_owner_bootstrapped' } },
      overrideAccess: true,
    })
  ).totalDocs
}

beforeAll(async () => {
  const { default: config } = await import('../payload.config.js')
  payload = await getPayload({ config })
})

afterEach(async () => {
  await sqlite().execute('DROP TRIGGER IF EXISTS fail_local_owner_audit')
  await sqlite().execute('DELETE FROM audit_events')
  await sqlite().execute('DELETE FROM invitations')
  await sqlite().execute('DELETE FROM users')

  for (const name of [
    'success.json',
    'first.json',
    'second.json',
    'invite.json',
    'audit-failure.json',
    'existing-user.json',
    'regular.json',
    'symlink.json',
    'target.json',
  ]) {
    rmSync(outputPath(name), { force: true })
  }
})

afterAll(async () => {
  await payload.destroy()
  rmSync(directory, { recursive: true, force: true })
})

describe('local Owner enrollment with real SQLite', () => {
  it('writes a restricted handoff and persists only encrypted credentials', async () => {
    const credentialsFile = outputPath('success.json')

    await createLocalOwner(payload, {
      email: 'owner@example.test',
      name: 'Owner',
      credentialsFile,
    })

    expect(lstatSync(credentialsFile).mode & 0o777).toBe(0o600)
    const handoff = JSON.parse(readFileSync(credentialsFile, 'utf8')) as LocalOwnerCredentials
    const users = await payload.find({ collection: 'users', limit: 1, overrideAccess: true })
    const user = users.docs[0]

    expect(handoff.base32seed).toBeTruthy()
    expect(handoff.recoverycodes).toHaveLength(8)
    expect(user.providerSubject).toBeNull()
    expect(user.emergencyTotpSecret).not.toBe(handoff.base32seed)
    expect(user.emergencyRecoveryHashes).toHaveLength(8)
    expect(JSON.stringify(user)).not.toContain(handoff.base32seed)
    for (const recoveryCode of handoff.recoverycodes) {
      expect(JSON.stringify(user)).not.toContain(recoveryCode)
    }
    expect(await auditCount()).toBe(1)
  })

  it('allows concurrent bootstrap attempts to create exactly one Owner and one handoff', async () => {
    const first = outputPath('first.json')
    const second = outputPath('second.json')

    const results = await Promise.allSettled([
      createLocalOwner(payload, {
        email: 'first@example.test',
        name: 'First Owner',
        credentialsFile: first,
      }),
      createLocalOwner(payload, {
        email: 'second@example.test',
        name: 'Second Owner',
        credentialsFile: second,
      }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await ownerCount()).toBe(1)
    expect(await auditCount()).toBe(1)
    expect([existsSync(first), existsSync(second)].filter(Boolean)).toHaveLength(1)
  })

  it('refuses a bootstrap when a live invitation exists and removes its handoff', async () => {
    const credentialsFile = outputPath('invite.json')
    await payload.create({
      collection: 'invitations',
      data: {
        email: 'invitee@example.test',
        provider: 'google',
        providerIssuer: 'https://accounts.google.com',
        providerSubject: 'unbound:synthetic-local-bootstrap-invitation',
        tokenHash: 'test-token-hash',
        roles: ['editor'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      overrideAccess: true,
    })

    await expect(
      createLocalOwner(payload, {
        email: 'owner@example.test',
        name: 'Owner',
        credentialsFile,
      }),
    ).rejects.toBeInstanceOf(LocalOwnerBootstrapError)

    expect(existsSync(credentialsFile)).toBe(false)
    expect(await ownerCount()).toBe(0)
    expect(await auditCount()).toBe(0)
  })

  it('rolls back the Owner and removes its handoff when the audit insert aborts', async () => {
    const credentialsFile = outputPath('audit-failure.json')
    await sqlite().execute(`
      CREATE TRIGGER fail_local_owner_audit
      BEFORE INSERT ON audit_events
      BEGIN
        SELECT RAISE(FAIL, 'injected audit write failure');
      END
    `)

    await expect(
      createLocalOwner(payload, {
        email: 'owner@example.test',
        name: 'Owner',
        credentialsFile,
      }),
    ).rejects.toThrow()

    expect(existsSync(credentialsFile)).toBe(false)
    expect(await ownerCount()).toBe(0)
    expect(await auditCount()).toBe(0)
  })

  it('creates no account when the credential output parent is missing', async () => {
    const credentialsFile = join(directory, 'missing-parent', 'owner.json')

    await expect(
      createLocalOwner(payload, {
        email: 'owner@example.test',
        name: 'Owner',
        credentialsFile,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    expect(await ownerCount()).toBe(0)
    expect(await auditCount()).toBe(0)
  })

  it('leaves pre-existing regular files and symlinks unchanged', () => {
    const regular = outputPath('regular.json')
    const target = outputPath('target.json')
    const symlink = outputPath('symlink.json')
    const credentials: LocalOwnerCredentials = {
      email: 'owner@example.test',
      otpauthURI: 'otpauth://totp/example',
      base32seed: 'seed',
      recoverycodes: [],
    }
    writeFileSync(regular, 'existing regular file')
    writeFileSync(target, 'symlink target')
    symlinkSync(target, symlink)

    expect(() => writeLocalOwnerCredentials(regular, credentials)).toThrow()
    expect(() => writeLocalOwnerCredentials(symlink, credentials)).toThrow(LocalOwnerBootstrapError)
    expect(readFileSync(regular, 'utf8')).toBe('existing regular file')
    expect(readFileSync(target, 'utf8')).toBe('symlink target')
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true)
  })

  it('refuses when any user exists and removes its newly written handoff', async () => {
    await payload.create({
      collection: 'users',
      data: { email: 'existing@example.test', name: 'Existing', roles: ['editor'] },
      overrideAccess: true,
    })
    const credentialsFile = outputPath('existing-user.json')

    await expect(
      createLocalOwner(payload, {
        email: 'owner@example.test',
        name: 'Owner',
        credentialsFile,
      }),
    ).rejects.toBeInstanceOf(LocalOwnerBootstrapError)

    expect(existsSync(credentialsFile)).toBe(false)
    expect(await ownerCount()).toBe(0)
  })
})
