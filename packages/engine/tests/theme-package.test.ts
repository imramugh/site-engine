import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ThemeManifestSchema } from '@site-engine/contract'
import { validateThemePackage } from '../src/theme-package.js'

const required = ThemeManifestSchema.parse({ name: 'neutral-test', version: '1.0.0', contract: '1.0.0', entry: './dist/index.js' }).standardBlocks
const execFile = promisify(execFileCallback)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
async function fixture(change: (manifest: Record<string, unknown>, root: string) => Promise<void> | void = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'theme-package-')); await mkdir(join(root, 'dist')); await mkdir(join(root, 'src/components'), { recursive: true })
  const manifest: Record<string, unknown> = { name: 'neutral-test', version: '1.0.0', contract: '1.0.0', entry: './dist/index.js', standardBlocks: required, contractSurface: { version: 1, standardBlocks: required, templates: ['landing', 'standard', 'listing', 'pillar', 'service', 'article', 'job'], backgrounds: ['default', 'subtle', 'brand', 'accent', 'highlight', 'inverse'], logoTones: ['default', 'inverse'], components: { layout: './src/components/Layout.astro', blockRenderer: './src/components/BlockRenderer.astro' } } }
  await writeFile(join(root, 'dist/index.js'), 'export {}'); await writeFile(join(root, 'dist/index.d.ts'), 'export {}'); await writeFile(join(root, 'src/components/Layout.astro'), '<slot />'); await writeFile(join(root, 'src/components/BlockRenderer.astro'), '<slot />'); await writeFile(join(root, 'package.json'), '{"name":"neutral-test","exports":{".":{"types":"./dist/index.d.ts"}}}'); await change(manifest, root); await writeFile(join(root, 'theme.json'), JSON.stringify(manifest)); return root
}
describe('theme package validator', () => {
  it('accepts a complete extracted package and reports immutable file receipts', async () => { const root = await fixture(); try { const result = await validateThemePackage(root); expect(result.receipt.files).toHaveProperty('./dist/index.js'); } finally { await rm(root, { recursive: true, force: true }) } })
  it('rejects absent explicit surface, contradictory declarations, missing files, traversal, symlinks, and duplicate artifacts', async () => { for (const change of [async (m: any) => delete m.contractSurface, (m: any) => { m.standardBlocks = ['hero'] }, async (m: any) => { delete m.standardBlocks }, async (m: any) => { m.entry = './dist/missing.js' }, async (_m: any, root: string) => { await rm(join(root, 'dist/index.d.ts')) }, (m: any) => { m.contractSurface.components.layout = '../escape.astro' }, (m: any) => { m.contractSurface.assets = ['./dist/index.js'] }, async (_m: any, root: string) => { await rm(join(root, 'src/components/Layout.astro')); await symlink('/etc/hosts', join(root, 'src/components/Layout.astro')) }]) { const root = await fixture(change); try { await expect(validateThemePackage(root)).rejects.toThrow(); } finally { await rm(root, { recursive: true, force: true }) } } })
  it('runs the operator CLI and emits JSON only after validation', async () => { const root = await fixture(); try { const { stdout, stderr } = await execFile(process.execPath, [join(packageRoot, 'dist/theme-package-cli.js'), root]); expect(stderr).toBe(''); expect(JSON.parse(stdout)).toMatchObject({ install: { manifest: { name: 'neutral-test' } }, receipt: { files: { './dist/index.js': expect.any(String) } } }) } finally { await rm(root, { recursive: true, force: true }) } })
  it('returns an actionable nonzero CLI error for an invalid extracted package', async () => { const root = await fixture(async m => delete m.contractSurface); try { await expect(execFile(process.execPath, [join(packageRoot, 'dist/theme-package-cli.js'), root])).rejects.toMatchObject({ stderr: expect.stringContaining('contractSurface') }) } finally { await rm(root, { recursive: true, force: true }) } })
})
