import { describe, expect, it } from 'vitest'
import { BlockSchemas, TemplateAllowedBlocks, TemplateSchema, SectionPresets } from '@site-engine/contract'
import { contractFields, galleryCatalog, sectionPresetCatalog, templateCatalog } from '../src/block-gallery-catalog'
import { recipeBlocks } from '../src/block-gallery'
import { exactGalleryLibrary, parseGalleryLibraries } from '../src/admin-branding'

describe('ENG-018 generated gallery catalogue', () => {
  it('covers the entire contract and supplies legal starting recipes for every template and section preset', () => {
    expect(galleryCatalog.map(block => block.type).sort()).toEqual(Object.keys(BlockSchemas).sort())
    expect(templateCatalog.map(template => template.id)).toEqual(TemplateSchema.options)
    expect(sectionPresetCatalog.map(preset => preset.id)).toEqual(Object.keys(SectionPresets))
    for (const template of templateCatalog) {
      expect(template.allowedBlocks).toEqual(TemplateAllowedBlocks[template.id])
      expect(recipeBlocks(template.id, template.startingBlocks).map(block => block.type)).toEqual(template.startingBlocks)
    }
    for (const preset of sectionPresetCatalog) {
      expect(preset.allowedTemplates).toContain(preset.landingTemplate)
      expect(recipeBlocks(preset.landingTemplate, preset.startingBlocks).length).toBeGreaterThan(0)
    }
  })

  it('distinguishes unconditional fields and nested conditional fields with contract limits', () => {
    expect(contractFields('hero')).toContainEqual(expect.objectContaining({ path: 'heading', required: true, limits: 'at least 1 characters; up to 120 characters' }))
    expect(contractFields('hero')).toContainEqual(expect.objectContaining({ path: 'supportPanel.heading', required: true, condition: 'supportPanel' }))
    expect(contractFields('faq')).toContainEqual(expect.objectContaining({ path: 'items[].answer', required: true, limits: 'at least 1 characters; up to 2000 characters' }))
    expect(contractFields('testimonials')).toContainEqual(expect.objectContaining({ path: 'items[].permissionConfirmed', type: 'boolean', required: true }))
    expect(contractFields('gallery')).toContainEqual(expect.objectContaining({ path: 'mediaIds', required: true, limits: 'at least 1 items; up to 12 items' }))
  })

  it('only admits local, versioned HTML libraries with bounded provenance', () => {
    const valid = { url: '/admin-branding/assets/gallery/starter@1.0.0/index.html', fixtureHash: 'a'.repeat(64), manifestDigest: 'c'.repeat(64), source: { themePackage: '@site-engine/theme-starter@1.0.0', rendererCommit: 'b'.repeat(40), contractVersion: '1.7.0' }, capabilities: ['templates', 'motion', 'execute-arbitrary-code'] }
    expect(parseGalleryLibraries({ 'starter@1.0.0': valid })).toEqual({ 'starter@1.0.0': { ...valid, capabilities: ['templates', 'motion'] } })
    const libraries = parseGalleryLibraries({ 'starter@1.0.0': valid })
    const theme = { name: 'starter', version: '1.0.0', contract: '1.7.0', manifestDigest: valid.manifestDigest }
    expect(exactGalleryLibrary(libraries, theme)).toEqual(libraries['starter@1.0.0'])
    expect(exactGalleryLibrary(libraries, { ...theme, manifestDigest: 'd'.repeat(64) })).toBeUndefined()
    expect(exactGalleryLibrary(libraries, { ...theme, contract: '1.6.0' })).toBeUndefined()
    for (const url of ['https://example.test/index.html', '/admin-branding/../admin/index.html', '/admin-branding/%2e%2e/admin.html', '/admin-branding/a.html?script=bad', '/admin-branding/a.svg']) {
      expect(parseGalleryLibraries({ 'starter@1.0.0': { ...valid, url } })).toEqual({})
    }
    expect(parseGalleryLibraries({ 'starter@1.0.0': { ...valid, fixtureHash: 'unverified' }, '../theme@1.0.0': valid })).toEqual({})
  })
})
