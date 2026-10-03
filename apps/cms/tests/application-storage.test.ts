import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { readResume, storeResume } from '../src/applications'

let directory: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('returns exact uploaded bytes and rejects altered content, traversal and substituted symlinks', async () => {
  directory = await mkdtemp(join(tmpdir(), 'application-storage-'))
  vi.stubEnv('APPLICATION_STORAGE_DIR', directory)
  const data = Buffer.from('%PDF-1.7\nSynthetic resume\n%%EOF\n')
  const key = storeResume({ data, name: 'resume.pdf' })
  expect(await readResume(key)).toEqual(data)
  await expect(readResume('../outside')).rejects.toThrow('Invalid resume key')
  await writeFile(join(directory, key), 'changed')
  await expect(readResume(key)).rejects.toThrow('Resume content changed')
  const outside = join(directory, 'outside.pdf')
  await writeFile(outside, data)
  await rm(join(directory, key))
  await symlink(outside, join(directory, key))
  await expect(readResume(key)).rejects.toThrow()
})
