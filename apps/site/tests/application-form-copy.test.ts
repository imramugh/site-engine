import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { applicationFormCopy, neutralApplicationFormCopy } from '../src/lib/application-form-copy'

test('uses neutral copy only when application-form.json is absent and validates staged theme copy strictly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'application-form-copy-'))
  try {
    expect(applicationFormCopy(root)).toEqual(neutralApplicationFormCopy)
    await writeFile(join(root, 'application-form.json'), JSON.stringify({ schemaVersion: 1, submitLabel: 'Send <application>', resumeRequired: 'Attach your CV.' }))
    expect(applicationFormCopy(root)).toMatchObject({ submitLabel: 'Send <application>', resumeRequired: 'Attach your CV.' })
    await writeFile(join(root, 'application-form.json'), '{'); expect(() => applicationFormCopy(root)).toThrow('valid JSON'); await writeFile(join(root, 'application-form.json'), 'x'.repeat(8_193)); expect(() => applicationFormCopy(root)).toThrow('8 KiB');
    for (const [value, message] of [
      [{ schemaVersion: 1, unsupported: 'x' }, 'unsupported key'],
      [{ schemaVersion: 2 }, 'schemaVersion'],
      [{ schemaVersion: 1, submitLabel: 4 }, 'submitLabel'],
      [{ schemaVersion: 1, submitLabel: 'bad\u0000copy' }, 'submitLabel'],
    ] as const) { await writeFile(join(root, 'application-form.json'), JSON.stringify(value)); expect(() => applicationFormCopy(root)).toThrow(message) }
    await writeFile(join(root, 'outside.json'), '{}'); await rm(join(root, 'application-form.json')); await symlink(join(root, 'outside.json'), join(root, 'application-form.json')); expect(() => applicationFormCopy(root)).toThrow('regular file'); await rm(join(root, 'application-form.json')); await symlink(join(root, 'missing.json'), join(root, 'application-form.json')); expect(() => applicationFormCopy(root)).toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
