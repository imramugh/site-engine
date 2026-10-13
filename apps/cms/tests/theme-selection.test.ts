import { expect, test } from 'vitest'
import { BlockSchemas, CONTRACT_VERSION } from '@site-engine/contract'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { parseThemeRegistry } from '@site-engine/engine/theme-registry'
import { compatibilityForTheme, selectionCandidate } from '../src/theme-selection'

const installed = (name: string, version: string, standardBlocks: string[]) =>
  parseThemeRegistry({ themes: [{ installedAt: '2026-10-01T00:00:00.000Z', manifest: { name, version, contract: CONTRACT_VERSION, entry: './dist/renderer.js', standardBlocks, settingKeys: [], extensionBlocks: [] } }] }).get(name)!.get(version)!

test('theme selection evaluates a cross-contract candidate before checking its renderer', () => {
  const baseline = structuredClone(neutralFixture)
  baseline.settings.contractVersion = '1.8.0'
  const next = installed('synthetic-next', '1.9.0', Object.keys(BlockSchemas))

  const candidate = selectionCandidate(baseline, { id: next.manifest.name, version: next.manifest.version, contract: next.manifest.contract, manifestDigest: next.manifestDigest })
  expect(candidate.settings.contractVersion).toBe(CONTRACT_VERSION)
  expect(compatibilityForTheme(baseline, next)).toMatchObject({ compatible: true, actions: [] })
})

test('theme selection rejects an installed renderer missing a block used by the candidate', () => {
  const baseline = structuredClone(neutralFixture)
  baseline.settings.contractVersion = CONTRACT_VERSION
  baseline.pages[0]!.blocks.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'quote', quote: 'A neutral supported quotation.', attribution: 'Synthetic source', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } })
  const oldRenderer = installed('synthetic-old', '1.8.9', Object.keys(BlockSchemas).filter((type) => type !== 'quote'))

  expect(selectionCandidate(baseline, { id: oldRenderer.manifest.name, version: oldRenderer.manifest.version, contract: oldRenderer.manifest.contract, manifestDigest: oldRenderer.manifestDigest }).settings.contractVersion).toBe(CONTRACT_VERSION)
  expect(compatibilityForTheme(baseline, oldRenderer)).toMatchObject({ compatible: false, actions: expect.arrayContaining([expect.objectContaining({ action: 'hide', reason: 'unsupported-standard-block' })]) })
})
