import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { getPayload } from 'payload'
import sharp from 'sharp'
import { withPayloadTransaction } from '../src/auth-transaction'
import { snapshot, type CapturedChange } from '../src/editorial'
import { mediaStorageDirectory, snapshotMediaReference } from '../src/media'
import { replaceAssetFile } from '../src/media-ingestion'
import { canonicalHash } from '../src/publishing'
import { captureReviewedRollback } from '../src/reviewed-rollback'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-rollback-media-'))
const baselineFile = join(directory, 'contract-1.4.json')
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.MEDIA_STORAGE_DIR = join(directory, 'media')
process.env.PAYLOAD_SECRET = 'rollback-media-secret-that-is-long-enough'
process.env.PAYLOAD_PUBLIC_SERVER_URL = 'http://cms.test'
process.env.PREVIEW_THEME_VERSION = 'test-theme'
process.env.PREVIEW_ENGINE_VERSION = 'test-engine'
process.env.PREVIEW_CONTRACT_VERSION = '1.4.0'
writeFileSync(baselineFile, JSON.stringify({ ...neutralFixture, settings: { ...neutralFixture.settings, contractVersion: '1.4.0' } }))
process.env.INITIAL_PUBLISH_BASELINE_FILE = baselineFile

const { default: config } = await import('../payload.config.js')
let payload: Awaited<ReturnType<typeof getPayload>>
let owner: { id: string; roles?: string[] }

beforeAll(async () => {
  payload = await getPayload({ config })
  owner = await payload.create({ collection: 'users', data: { email: 'rollback-media-owner@example.test', name: 'Rollback media owner', roles: ['owner'] }, overrideAccess: true }) as typeof owner
}, 60_000)

afterAll(async () => {
  await payload?.destroy()
  rmSync(directory, { recursive: true, force: true })
})

const raster = (colour: string, width = 96, height = 64) => sharp({ create: { width, height, channels: 3, background: colour } }).png().toBuffer()

async function upload(label: string) {
  const bytes = await raster('#0f766e')
  return payload.create({
    collection: 'assets',
    data: { alt: `${label} original alt`, caption: `${label} original caption`, focalX: 22, focalY: 78 },
    file: { data: bytes, mimetype: 'image/png', name: `${label}-${randomUUID()}.png`, size: bytes.length },
    draft: true,
    user: owner as never,
    overrideAccess: true,
    context: { editorialInternal: true, mediaFocalContract: '1.4.0' },
  })
}

function baseline(asset: Record<string, unknown>) {
  const value = structuredClone(neutralFixture) as Record<string, any>
  value.settings = { ...value.settings, contractVersion: '1.4.0' }
  value.media = [...value.media, snapshotMediaReference(asset as never)]
  return value
}

function captured(before: Record<string, unknown> | null, after: Record<string, unknown> | null): CapturedChange {
  const beforeCapture = before && snapshot('assets', before, true)
  const afterCapture = after && snapshot('assets', after, true)
  return {
    collection: 'assets', id: String((after ?? before)!.id), before: beforeCapture, after: afterCapture,
    beforeHash: beforeCapture ? canonicalHash(beforeCapture) : null,
    afterHash: afterCapture ? canonicalHash(afterCapture) : null,
  }
}

async function rollback(base: Record<string, unknown>, approved: CapturedChange[]) {
  return withPayloadTransaction(payload, async (req) => {
    req.user = owner as never
    return captureReviewedRollback(payload, req, owner.id, `Rollback media ${randomUUID()}`, base as never, approved)
  }) as Promise<{ id: string; changes: CapturedChange[] }>
}

async function changeSetCount() {
  return (await payload.find({ collection: 'change-sets', limit: 0, pagination: false, depth: 0, overrideAccess: true })).totalDocs
}

describe('ENG-010 reviewed media rollback on SQLite storage', () => {
  it('restores approved asset metadata to a reviewable draft while retaining its uploaded bytes', async () => {
    const original = await upload('metadata') as unknown as Record<string, unknown>
    const changed = await payload.update({
      collection: 'assets', id: String(original.id),
      data: { alt: 'Metadata replacement alt', caption: 'Metadata replacement caption', focalX: 67, focalY: 31 },
      draft: true, user: owner as never, overrideAccess: true, context: { editorialInternal: true, mediaFocalContract: '1.4.0' },
    }) as unknown as Record<string, unknown>

    const set = await rollback(baseline(changed), [captured(original, changed)])
    const restored = await payload.findByID({ collection: 'assets', id: String(original.id), depth: 0, draft: true, overrideAccess: true }) as unknown as Record<string, unknown>
    const change = set.changes[0]!
    expect(restored).toMatchObject({ alt: original.alt, caption: original.caption, focalX: original.focalX, focalY: original.focalY })
    expect(change).toMatchObject({ collection: 'assets', id: original.id, after: expect.objectContaining({ alt: original.alt, caption: original.caption, focalX: original.focalX, focalY: original.focalY }) })
    expect(change.after).toEqual(snapshot('assets', restored, true))
    expect(existsSync(join(mediaStorageDirectory(), String(restored.filename)))).toBe(true)
  })

  it('restores the retained immutable prior file version for a reviewed replacement rollback', async () => {
    const original = await upload('replacement') as unknown as Record<string, unknown>
    const before = await payload.findByID({ collection: 'assets', id: String(original.id), depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const originalReference = snapshotMediaReference(before as never)
    const replacementBytes = await raster('#7c3aed', 128, 80)
    await replaceAssetFile({ payload, assetID: String(original.id), idempotencyKey: randomUUID(), file: { data: replacementBytes, mimetype: 'image/png', name: 'rollback-replacement.png', size: replacementBytes.length }, user: owner })
    const replaced = await payload.findByID({ collection: 'assets', id: String(original.id), depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const replacementReference = snapshotMediaReference(replaced as never)
    expect(replacementReference.filename).not.toBe(originalReference.filename)
    const capturedReplacement = await payload.find({ collection: 'change-sets', where: { actor: { equals: owner.id } }, limit: 0, pagination: false, depth: 0, overrideAccess: true })
    const replacementSet = capturedReplacement.docs.find((set) => Array.isArray(set.changes) && set.changes.some((change: any) => change.collection === 'assets' && change.id === original.id))!
    await payload.update({ collection: 'change-sets', id: replacementSet.id, data: { state: 'published' }, overrideAccess: true, context: { editorialInternal: true } })

    const set = await rollback(baseline(replaced), [captured(before, replaced)])
    const restored = await payload.findByID({ collection: 'assets', id: String(original.id), depth: 0, draft: true, overrideAccess: true }) as unknown as Record<string, unknown>
    const restoredReference = snapshotMediaReference(restored as never)
    expect(restored).toMatchObject({ currentFileVersion: null, currentFile: null })
    expect(restoredReference).toEqual(originalReference)
    expect(readFileSync(join(mediaStorageDirectory(), restoredReference.filename))).toEqual(readFileSync(join(mediaStorageDirectory(), originalReference.filename)))
    expect(set.changes[0]!.after).toEqual(snapshot('assets', restored, true))
  })

  it('refuses binned or purged assets before creating a rollback draft or mutating media', async () => {
    for (const lifecycle of ['binned', 'purged'] as const) {
      const original = await upload(lifecycle) as unknown as Record<string, unknown>
      const changed = await payload.update({ collection: 'assets', id: String(original.id), data: { alt: `${lifecycle} later alt` }, draft: true, user: owner as never, overrideAccess: true, context: { editorialInternal: true, mediaFocalContract: '1.4.0' } }) as unknown as Record<string, unknown>
      const approved = captured(original, changed)
      const base = baseline(changed)
      if (lifecycle === 'binned') await payload.update({ collection: 'assets', id: String(original.id), data: { deletedAt: new Date().toISOString(), deleteAfter: new Date(Date.now() + 86_400_000).toISOString() }, overrideAccess: true, context: { mediaLifecycle: 'bin' } })
      else await payload.delete({ collection: 'assets', id: String(original.id), overrideAccess: true, context: { retentionPurge: true } })
      const beforeSets = await changeSetCount()

      await expect(rollback(base, [approved])).rejects.toThrow(/unavailable|deletion bin|purged/i)
      expect(await changeSetCount()).toBe(beforeSets)
      if (lifecycle === 'binned') expect(await payload.findByID({ collection: 'assets', id: String(original.id), depth: 0, overrideAccess: true })).toMatchObject({ alt: changed.alt, deletedAt: expect.any(String) })
      else await expect(payload.findByID({ collection: 'assets', id: String(original.id), depth: 0, overrideAccess: true })).rejects.toThrow()
    }
  })

  it('turns an approved added asset into a reviewed public removal while retaining its local bytes', async () => {
    const added = await upload('added') as unknown as Record<string, unknown>
    const filename = String(added.filename)
    const bytes = readFileSync(join(mediaStorageDirectory(), filename))
    const currentBaseline = baseline(added)
    const set = await rollback(currentBaseline, [captured(null, added)])
    const change = set.changes[0]!
    expect(change).toMatchObject({ collection: 'assets', id: added.id, after: null, retainedDraftHash: expect.any(String) })
    expect(await payload.findByID({ collection: 'assets', id: String(added.id), depth: 0, draft: true, overrideAccess: true })).toMatchObject({ id: added.id, alt: added.alt })
    expect(readFileSync(join(mediaStorageDirectory(), filename))).toEqual(bytes)
  })
})
