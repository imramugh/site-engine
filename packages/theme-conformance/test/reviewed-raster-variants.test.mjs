import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertVisualBaselines, validateVisualBaseline } from '../src/index.mjs'

const identity = { name: 'example', themeVersion: '1.0.0', engineVersion: '1.0.0' }
const primary = 'a'.repeat(64)
const variant = 'b'.repeat(64)
const baseline = () => ({ identity, screenshots: { 'home-1440.png': primary }, reviewedRasterVariants: { 'home-1440.png': [{ sha256: variant, reason: 'Reviewed one-channel raster delta.', evidence: 'evidence/raster-review.json' }] } })

test('accepts only a reviewed exact raster variant and reports it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'raster-variant-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'baseline.json')
  await writeFile(file, JSON.stringify(baseline()))
  assert.deepEqual(await assertVisualBaselines({ 'home-1440.png': primary }, { file, record: false, identity }), { matchedVariants: [] })
  assert.deepEqual(await assertVisualBaselines({ 'home-1440.png': variant }, { file, record: false, identity }), { matchedVariants: [{ filename: 'home-1440.png', sha256: variant, reason: 'Reviewed one-channel raster delta.', evidence: 'evidence/raster-review.json' }] })
  await assert.rejects(() => assertVisualBaselines({ 'home-1440.png': 'c'.repeat(64) }, { file, record: false, identity }), /Visual baseline changed/)
})

test('preserves the primary hash and rejects malformed or unknown variant entries', () => {
  assert.deepEqual(validateVisualBaseline(baseline(), identity).screenshots, { 'home-1440.png': primary })
  for (const change of [
    (value) => { value.reviewedRasterVariants['missing.png'] = value.reviewedRasterVariants['home-1440.png'] },
    (value) => { value.reviewedRasterVariants['home-1440.png'][0].sha256 = primary },
    (value) => { value.reviewedRasterVariants['home-1440.png'][0].sha256 = 'not-a-sha' },
    (value) => { value.reviewedRasterVariants['home-1440.png'][0].reason = '' },
    (value) => { value.reviewedRasterVariants['home-1440.png'][0].evidence = '' },
    (value) => { value.reviewedRasterVariants['home-1440.png'][0].extra = true },
  ]) {
    const value = baseline(); change(value); assert.throws(() => validateVisualBaseline(value, identity), /reviewedRasterVariants/)
  }
})
