import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPayload } from 'payload'
import sharp from 'sharp'
import { mediaStorageDirectory } from '../src/media'
import { runRetentionCleanup } from '../src/retention'

const directory = mkdtempSync(join(tmpdir(), 'retention-media-sqlite-'))
const ledger = join(directory, 'deletions.ndjson')
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.APPLICATION_STORAGE_DIR = join(directory, 'applications')
process.env.MEDIA_STORAGE_DIR = join(directory, 'media')
process.env.PAYLOAD_SECRET = 'retention-media-test-secret-long-enough'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.retention-media.test'
const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => {
  payload = await getPayload({ config })
  writeFileSync(ledger, '')
  chmodSync(ledger, 0o600)
  process.env.RETENTION_TOMBSTONES_FILE = ledger
})
afterAll(async () => {
  await payload?.destroy()
  rmSync(directory, { recursive: true, force: true })
  delete process.env.RETENTION_TOMBSTONES_FILE
})

async function owner() {
  return payload.create({ collection: 'users', data: { email: `retention-media-${crypto.randomUUID()}@example.test`, name: 'Retention media owner', roles: ['owner'] }, overrideAccess: true })
}

async function binnedAsset(label: string) {
  const actor = await owner()
  const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#0f766e' } }).png().toBuffer()
  const asset = await payload.create({ collection: 'assets', data: { alt: `${label} asset` }, file: { data: bytes, mimetype: 'image/png', name: `${label}.png`, size: bytes.length }, user: actor, overrideAccess: true })
  const versions = []
  for (const [index, suffix] of ['first', 'second'].entries()) {
    const versionBytes = await sharp({ create: { width: 25 + index, height: 25 + index, channels: 3, background: index ? '#7c3aed' : '#ea580c' } }).png().toBuffer()
    const key = crypto.randomUUID()
    versions.push(await payload.create({
      collection: 'asset-file-versions',
      data: { parentAsset: asset.id, digest: createHash('sha256').update(versionBytes).digest('hex'), versionKey: `${asset.id}:${key}`, idempotencyKey: key, originalFilename: `${label}-${suffix}.png` },
      file: { data: versionBytes, mimetype: 'image/png', name: `${asset.id}-${suffix}.png`, size: versionBytes.length },
      user: actor,
      overrideAccess: true,
      context: { mediaReplacementVersion: true },
    }))
  }
  const expired = '2026-09-05T12:00:00.000Z'
  await payload.update({ collection: 'assets', id: asset.id, data: { deletedAt: expired, deleteAfter: expired }, overrideAccess: true, context: { mediaLifecycle: 'bin' } })
  return { actor, asset, versions }
}

function storedFiles(record: { filename?: unknown; sizes?: unknown }): string[] {
  const sizes = record.sizes && typeof record.sizes === 'object' ? Object.values(record.sizes as Record<string, { filename?: unknown }>) : []
  return [record.filename, ...sizes.map((size) => size.filename)].filter((filename): filename is string => typeof filename === 'string')
}

describe('ENG-037 media retention lifecycle on SQLite storage', () => {
  it('keeps the binned parent and remaining immutable version discoverable after a storage failure, then retries every row and file', async () => {
    const { asset, versions } = await binnedAsset('retryable-gc')
    const assetFiles = storedFiles(asset).map((filename) => join(mediaStorageDirectory(), filename))
    const versionFiles = versions.map(storedFiles).map((files) => files.map((filename) => join(mediaStorageDirectory(), filename)))
    expect([...assetFiles, ...versionFiles.flat()].every(existsSync)).toBe(true)
    const deletionOrder = await payload.find({ collection: 'asset-file-versions', where: { parentAsset: { equals: asset.id } }, limit: 0, pagination: false, depth: 0, overrideAccess: true })
    const failingVersion = deletionOrder.docs[1]!
    const deletedVersion = deletionOrder.docs[0]!

    const actualDelete = payload.delete.bind(payload)
    const deleteFailure = vi.spyOn(payload, 'delete').mockImplementation(async (args) => {
      if (args.collection === 'asset-file-versions' && args.id === failingVersion.id) throw new Error('simulated immutable version storage deletion failure')
      return actualDelete(args)
    })
    const now = new Date('2026-10-05T12:00:00.000Z')
    await expect(runRetentionCleanup(payload, now)).resolves.toMatchObject({ failed: expect.any(Number) })
    deleteFailure.mockRestore()

    await expect(payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })).resolves.toMatchObject({ id: asset.id })
    const remaining = await payload.find({ collection: 'asset-file-versions', where: { parentAsset: { equals: asset.id } }, limit: 0, pagination: false, depth: 0, overrideAccess: true })
    expect(remaining.docs).toEqual([expect.objectContaining({ id: failingVersion.id })])
    expect(assetFiles.every(existsSync)).toBe(true)
    expect(storedFiles(deletedVersion).map((filename) => join(mediaStorageDirectory(), filename)).every((file) => !existsSync(file))).toBe(true)
    expect(storedFiles(failingVersion).map((filename) => join(mediaStorageDirectory(), filename)).every(existsSync)).toBe(true)
    expect((await payload.find({ collection: 'retention-purge-jobs', where: { resourceID: { equals: asset.id } }, overrideAccess: true })).docs[0]).toMatchObject({ resourceType: 'media', state: 'failed' })

    await expect(runRetentionCleanup(payload, now)).resolves.toMatchObject({ media: expect.any(Number) })
    await expect(payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })).rejects.toMatchObject({ status: 404 })
    expect((await payload.find({ collection: 'asset-file-versions', where: { parentAsset: { equals: asset.id } }, limit: 0, pagination: false, depth: 0, overrideAccess: true })).totalDocs).toBe(0)
    expect([...assetFiles, ...versionFiles.flat()].every((file) => !existsSync(file))).toBe(true)
  })

  it('preserves an expired binned asset when an immutable publish snapshot still names it', async () => {
    const { actor, asset, versions } = await binnedAsset('snapshot-protected')
    const changeSet = await payload.create({ collection: 'change-sets', data: { name: 'Snapshot media retention fixture', actor: actor.id, state: 'approved', revision: 1, changes: [] }, user: actor, overrideAccess: true, context: { editorialInternal: true } })
    await payload.create({ collection: 'publish-snapshots', data: { contentHash: crypto.randomUUID(), changeSet: changeSet.id, reviewRevision: 1, changeHash: crypto.randomUUID(), manifest: { frozenMedia: [{ id: asset.id }] }, themeVersion: 'test', engineVersion: 'test', contractVersion: '1.4.0', approvedBy: actor.id, baselineSequence: 0 }, user: actor, overrideAccess: true })

    await expect(runRetentionCleanup(payload, new Date('2026-10-05T12:00:00.000Z'))).resolves.toMatchObject({ media: expect.any(Number) })
    await expect(payload.findByID({ collection: 'assets', id: asset.id, overrideAccess: true })).resolves.toMatchObject({ id: asset.id })
    expect((await payload.find({ collection: 'asset-file-versions', where: { parentAsset: { equals: asset.id } }, limit: 0, pagination: false, depth: 0, overrideAccess: true })).totalDocs).toBe(versions.length)
  })
})
