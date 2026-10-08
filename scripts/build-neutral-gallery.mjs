#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createConformanceFixture } from '../packages/theme-conformance/src/index.mjs'
import { createGalleryFixture, createGalleryLibraryModel, galleryHash, galleryLibraryDocument, galleryLibraryScript, galleryLibraryStyles } from '../packages/theme-conformance/src/gallery-library.mjs'
import { buildSnapshot } from '../packages/theme-conformance/harness/build-snapshot.mjs'
import { deriveRoutes } from '../packages/engine/dist/index.js'
import { manifestDigest } from '../packages/engine/dist/theme-registry.js'
import { BackgroundSchema, BlockSchemas, SectionPresets, TemplateSchema, ThemeManifestSchema, SiteSnapshotSchema } from '../packages/contract/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const rendererManifest = ThemeManifestSchema.parse(JSON.parse(await readFile(join(root, 'packages/theme-starter/theme.json'), 'utf8')))
const themeManifestPath = option('--theme-manifest')
const manifest = ThemeManifestSchema.parse(JSON.parse(await readFile(themeManifestPath ? resolve(root, themeManifestPath) : join(root, 'packages/theme-starter/theme.json'), 'utf8')))
const name = manifest.name
const version = manifest.version
const contract = manifest.contract
for (const field of ['name', 'version', 'contract']) if (option(`--${field}`) !== undefined && option(`--${field}`) !== manifest[field]) throw new Error(`--${field} must match the parsed theme manifest. Supply --theme-manifest for a different theme identity.`)
if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !/^\d+\.\d+\.\d+$/.test(version) || !/^1\.\d+\.\d+$/.test(contract)) throw new Error('Invalid neutral gallery identity.')
const key = `${name}@${version}`
// URL path segments must satisfy the snapshot renderer's conservative base
// path policy. Keep the human/package identity in metadata, not the path.
const pathKey = `${name}-v${version.replaceAll('.', '-')}`
const base = `/admin-branding/assets/gallery-libraries/${pathKey}`
const output = join(root, 'apps/cms/public', base)
const indexPath = join(root, 'apps/cms/public/admin-branding/gallery-libraries.json')
const source = createConformanceFixture()
source.settings.contractVersion = contract
// Contract 1.4 supports the contact form but not its 1.5 topic/consent
// presentation. The neutral fixture must be valid for the pinned renderer.
if (Number(contract.split('.')[1]) < 5) for (const page of source.pages) for (const block of page.blocks) {
  if (block.type === 'contact') {
    delete block.inquiryTopicLabel
    delete block.inquiryTopics
    delete block.inquiryConsentLabel
  }
}
const presetIntents = Object.fromEntries(Object.entries(manifest.motion?.intentFallbacks ?? {}).map(([intent, preset]) => [preset, intent]))
// This is the neutral renderer's declared motion preview surface. Other
// blocks remain selectable in the gallery but correctly disable its presets.
const motionBlocks = ['hero', 'featureGrid', 'faq', 'cta', 'richText', 'media', 'gallery']
const fixture = createGalleryFixture(source, { backgrounds: BackgroundSchema.options, presets: manifest.motion?.presets ?? [], presetIntents, motionBlocks })
SiteSnapshotSchema.parse(fixture)
const fixtureHash = galleryHash(fixture)
const rendererCommit = process.env.SITE_ENGINE_SOURCE_COMMIT ?? (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch { throw new Error('SITE_ENGINE_SOURCE_COMMIT is required when the source checkout has no Git metadata.') } })()
const rendererDirty = (() => {
  try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' }) } catch { return undefined }
  try { execFileSync('git', ['diff', '--quiet'], { cwd: root, stdio: 'ignore' }); return false } catch { return true }
})()
const provenance = { themePackage: `@site-engine/theme-starter@${rendererManifest.version}`, rendererCommit, sourceDirty: rendererDirty, contractVersion: contract }
const descriptor = { url: `${base}/index.html`, fixtureHash, manifestDigest: manifestDigest(manifest), source: provenance, capabilities: ['templates', 'presets', 'variants', 'extensions', 'viewport', 'background', 'motion'] }
const routes = deriveRoutes(fixture, fixture.settings.homepageId).routes
const routeFor = page => {
  if (!page) throw new Error('Gallery fixture page is missing.')
  const route = routes.find(route => route.page.id === page.id)
  if (!route) throw new Error(`Gallery route missing for ${page.slug}`)
  return `renders${route.path.replace(/\/$/, '')}/index.html`
}
const pageBySlug = slug => fixture.pages.find(page => page.slug === slug)
const blocks = Object.keys(BlockSchemas).map(id => ({ id, label: id.replace(/([a-z])([A-Z])/g, '$1 $2'), block: id, route: routeFor(fixture.pages.find(page => page.blocks.some(block => block.type === id))) }))
const templates = TemplateSchema.options.map(id => ({ id, label: id, route: routeFor(fixture.pages.find(page => page.template === id)) }))
const backgrounds = BackgroundSchema.options.map(id => ({ id, label: id, route: routeFor(pageBySlug(`gallery-background-${id}`)) }))
const motionSlug = (id, type) => `gallery-motion-${id}-${type.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`
const motions = (manifest.motion?.presets ?? []).map(id => ({ id, label: id, routes: Object.fromEntries(motionBlocks.map(type => [type, routeFor(pageBySlug(motionSlug(id, type)))])) }))
const common = [
  ...['content', 'wide', 'full'].map(id => ({ id: `width-${id}`, label: `Width: ${id}`, route: routeFor(pageBySlug(`gallery-width-${id}`)) })),
  ...['compact', 'default', 'spacious'].map(id => ({ id: `spacing-${id}`, label: `Spacing: ${id}`, route: routeFor(pageBySlug(`gallery-spacing-${id}`)) })),
  ...['default', 'inverse'].map(id => ({ id: `logo-${id}`, label: `Logo tone: ${id}`, route: routeFor(pageBySlug(`gallery-logo-${id}`)) })),
  ...fixture.pages.filter(page => page.slug.startsWith('gallery-feature-grid-')).map(page => ({ id: page.slug, label: page.title, route: routeFor(page) })),
]
const sectionRoutes = Object.fromEntries(Object.keys(SectionPresets).map(id => [id, routeFor(pageBySlug(`gallery-section-${id}`))]))
const model = createGalleryLibraryModel({ themeKey: key, fixtureHash, blocks, templates, motions, extensions: [], backgrounds, common, sectionRoutes })
const work = await mkdtemp(join(tmpdir(), 'neutral-gallery-'))
try {
  const input = join(work, 'fixture.json')
  await writeFile(input, JSON.stringify(fixture))
  const built = await buildSnapshot({ input, outputRoot: work, basePath: `${base}/renders`, publicOrigin: 'https://example.test', timeoutMs: 120_000, versionPins: { themeVersion: version, engineVersion: '1.0.1', contractVersion: contract } })
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  await rename(built.output, join(output, 'renders'))
  await writeFile(join(output, 'index.html'), galleryLibraryDocument({ title: `Theme gallery: ${key}`, ...model }))
  await writeFile(join(output, 'library.json'), JSON.stringify(model))
  await writeFile(join(output, 'library.js'), galleryLibraryScript)
  await writeFile(join(output, 'library.css'), galleryLibraryStyles)
  await writeFile(join(output, 'fixture.json'), JSON.stringify(fixture))
  await writeFile(join(output, 'provenance.json'), JSON.stringify({ ...descriptor, modelHash: galleryHash(model) }))
  let libraries = {}
  if (args.includes('--merge')) { try { libraries = JSON.parse(await readFile(indexPath, 'utf8')).blockGalleryLibraries ?? {} } catch {} }
  libraries[key] = descriptor
  await mkdir(dirname(indexPath), { recursive: true })
  await writeFile(indexPath, `${JSON.stringify({ blockGalleryLibraries: libraries }, null, 2)}\n`)
  console.log(`Built actual rendered gallery for ${key}: ${blocks.length} blocks, ${templates.length} templates and ${Object.keys(sectionRoutes).length} section presets.`)
} finally { await rm(work, { recursive: true, force: true }) }
