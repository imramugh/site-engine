import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const temporary: string[] = []
const pnpm = (cwd: string, args: string[], environment: NodeJS.ProcessEnv = process.env) => execFile('corepack', ['pnpm@12.8.1', ...args], { cwd, env: { ...environment, npm_config_ignore_scripts: 'true' } })

async function packedConsumer() {
  const directory = await mkdtemp(join(tmpdir(), 'starter-packed-consumer-')); temporary.push(directory)
  const tarballs = join(directory, 'tarballs'); const store = join(directory, 'store'); const cache = join(directory, 'cache'); await mkdir(tarballs)
  for (const packageDirectory of ['packages/contract', 'packages/engine', 'packages/theme-starter']) await pnpm(join(root, packageDirectory), ['pack', '--pack-destination', tarballs])
  const zodDirectory = dirname(createRequire(join(root, 'packages/contract/package.json')).resolve('zod/package.json'))
  await pnpm(zodDirectory, ['pack', '--pack-destination', tarballs])
  const files = await readdir(tarballs)
  const tarball = (name: string) => join(tarballs, files.find(file => file.startsWith(name) && file.endsWith('.tgz'))!)
  const contract = `file:${tarball('site-engine-contract')}`; const zod = `file:${tarball('zod-')}`
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'clean-consumer', private: true, dependencies: { '@site-engine/contract': contract, '@site-engine/engine': `file:${tarball('site-engine-engine')}`, '@site-engine/theme-starter': `file:${tarball('site-engine-theme-starter')}` } }))
  await writeFile(join(directory, 'pnpm-workspace.yaml'), `overrides:\n  '@site-engine/contract': '${contract}'\n  zod: '${zod}'\n`)
  await pnpm(directory, ['install', '--offline', '--ignore-scripts', '--store-dir', store], { ...process.env, npm_config_cache: cache, XDG_CACHE_HOME: cache })
  return directory
}

afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('ENG-038 packed starter installation', () => {
  it('validates a clean installed tarball and rejects a missing required component', async () => {
    const consumer = await packedConsumer(); const validator = join(consumer, 'node_modules/.bin/site-engine-validate-theme'); const starter = join(consumer, 'node_modules/@site-engine/theme-starter')
    const { stdout } = await execFile(validator, [starter]); expect(JSON.parse(stdout)).toMatchObject({ install: { manifest: { name: 'starter' } }, receipt: { files: { './src/components/BlockRenderer.astro': expect.any(String), './fonts/DejaVuSans.ttf': expect.any(String) } } })
    await rm(join(starter, 'src/components/BlockRenderer.astro'))
    await expect(execFile(validator, [starter])).rejects.toMatchObject({ stderr: expect.stringContaining('BlockRenderer.astro') })
  }, 60_000)
})
