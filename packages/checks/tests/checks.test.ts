import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactName, inspectBoundaries, withIsolatedSqlitePath } from '../src/index.js'

const workspaces: string[] = []

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'site-engine-boundaries-'))
  workspaces.push(root)
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents)
  }
  return root
}

function manifest(extra = ''): string {
  return `{ "name": "fixture", "type": "module"${extra} }`
}

function workspaceFiles(source: Partial<Record<'contract' | 'starter', string>>, manifests: Partial<Record<'contract' | 'starter', string>> = {}): Record<string, string> {
  return {
    'packages/contract/package.json': manifests.contract ?? manifest(),
    'packages/contract/src/index.ts': source.contract ?? 'export const contract = true\n',
    'packages/theme-starter/package.json': manifests.starter ?? manifest(),
    'packages/theme-starter/src/index.ts': source.starter ?? 'export const starter = true\n',
  }
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ENG-028 regression helpers', () => {
  it('names artifacts without fixture text', () => expect(artifactName('ENG-028', 'chromium', 'home page is accessible')).toBe('ENG-028-chromium-home-page-is-accessible'))
  it('creates and removes an isolated SQLite location', async () => { let database = ''; await withIsolatedSqlitePath(async (path) => { database = path; await expect(access(path)).rejects.toThrow() }); await expect(access(database)).rejects.toThrow() })
})

describe('public package boundaries', () => {
  it('allows starter source to import the public contract', async () => {
    const root = await fixture(workspaceFiles({ starter: "import { contract } from '@site-engine/contract'\nexport { contract }\n" }))
    await expect(inspectBoundaries(root)).resolves.toEqual([])
  })

  it('rejects a prohibited Astro import', async () => {
    const root = await fixture({
      ...workspaceFiles({}),
      'packages/theme-starter/src/Component.astro': "---\nimport Engine from '@site-engine/engine'\n---\n<Engine />\n",
    })
    await expect(inspectBoundaries(root)).resolves.toContain('packages/theme-starter/src/Component.astro imports prohibited @site-engine/engine')
  })

  it('rejects a prohibited dynamic subpath import', async () => {
    const root = await fixture(workspaceFiles({ contract: "await import('@site-engine/theme-starter/components/Layout.astro')\n" }))
    await expect(inspectBoundaries(root)).resolves.toContain('packages/contract/src/index.ts imports prohibited @site-engine/theme-starter/components/Layout.astro')
  })

  it('rejects a relative package escape', async () => {
    const root = await fixture(workspaceFiles({ starter: "import '../../../engine/src/index.js'\n" }))
    await expect(inspectBoundaries(root)).resolves.toContain('packages/theme-starter/src/index.ts imports outside its package: ../../../engine/src/index.js')
  })

  it('rejects prohibited development dependencies', async () => {
    const root = await fixture(workspaceFiles({}, { starter: manifest(', "devDependencies": { "@site-engine/engine": "workspace:*" }') }))
    await expect(inspectBoundaries(root)).resolves.toContain('@site-engine/theme-starter must not declare @site-engine/engine')
  })
})
