import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'
import { BackgroundSchema, LogoToneSchema, TemplateSchema, ThemeInstallSchema, ThemeManifestSchema } from '@site-engine/contract'

const blocks = ThemeManifestSchema.parse({ name: 'contract-surface', version: '1.0.0', contract: '1.0.0', entry: './dist/index.js' }).standardBlocks.slice().sort()
const same = (actual: readonly string[], expected: readonly string[]) => actual.length === expected.length && new Set(actual).size === actual.length && actual.slice().sort().every((value, index) => value === expected[index])
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
async function regular(root: string, path: string) {
  if (!path.startsWith('./') || path.includes('..') || path.includes('\\')) throw new Error(`Unsafe package path: ${path}`)
  const file = resolve(root, path); if (relative(root, file).startsWith(`..${sep}`)) throw new Error(`Package path escapes root: ${path}`)
  const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 5_000_000) throw new Error(`Package artifact is not a safe regular file: ${path}`)
  return [path, digest(await readFile(file))] as const
}
/** Validates a trusted, already-extracted theme package without executing it. */
export async function validateThemePackage(directory: string) {
  const root = await realpath(directory); const themeBytes = await readFile(resolve(root, 'theme.json')); const packageBytes = await readFile(resolve(root, 'package.json'))
  const manifest = ThemeManifestSchema.parse(JSON.parse(themeBytes.toString())); const surface = manifest.contractSurface
  if (!surface) throw new Error('New theme installs require contractSurface version 1.')
  if (!same(manifest.standardBlocks, surface.standardBlocks) || !same(surface.standardBlocks, blocks) || !same(surface.templates, [...TemplateSchema.options].sort()) || !same(surface.backgrounds, [...BackgroundSchema.options].sort()) || !same(surface.logoTones, [...LogoToneSchema.options].sort())) throw new Error('contractSurface must declare each required contract value exactly once.')
  const files = await Promise.all([regular(root, manifest.entry), regular(root, surface.components.layout), regular(root, surface.components.blockRenderer), ...(surface.assets ?? []).map(path => regular(root, path))])
  return { install: ThemeInstallSchema.parse({ manifest, installedAt: new Date().toISOString() }), receipt: { manifestDigest: digest(themeBytes), files: Object.fromEntries([['theme.json', digest(themeBytes)], ['package.json', digest(packageBytes)], ...files]) } }
}
