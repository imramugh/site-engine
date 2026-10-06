import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { resolveOutgoingAttachments } from '../src/outgoing-attachments'

const directories: string[] = []
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }) })
const uuid = '11111111-1111-4111-8111-111111111111'

test('resolves a server-owned asset into immutable bounded delivery metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'outgoing-attachment-')); directories.push(directory); process.env.MEDIA_STORAGE_DIR = directory
  writeFileSync(join(directory, 'brief.pdf'), Buffer.from('%PDF-safe attachment'))
  const payload = { findByID: async ({ collection }: { collection: string }) => collection === 'users' ? { roles: ['sales'] } : { currentFile: { filename: 'brief.pdf', originalFilename: 'brief.pdf', mimeType: 'application/pdf' } } } as any
  await expect(resolveOutgoingAttachments(payload, { target: 'lead', targetID: uuid, actorID: uuid, attachments: [{ source: 'asset', id: uuid }] })).resolves.toMatchObject([{ source: 'asset', sourceID: uuid, filename: 'brief.pdf', mimeType: 'application/pdf', size: 20, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }])
})

test('rejects cross-target resumes, unsafe source IDs, unavailable files, and unauthorized roles', async () => {
  const payload = { findByID: async ({ collection }: { collection: string }) => collection === 'users' ? { roles: ['sales'] } : { currentFile: { filename: '../escape', originalFilename: 'x.pdf', mimeType: 'application/pdf' } } } as any
  await expect(resolveOutgoingAttachments(payload, { target: 'lead', targetID: uuid, actorID: uuid, attachments: [{ source: 'application-resume', id: uuid }] })).rejects.toThrow('attachment_not_available')
  await expect(resolveOutgoingAttachments(payload, { target: 'lead', targetID: uuid, actorID: uuid, attachments: [{ source: 'asset', id: 'nope' }] })).rejects.toThrow('invalid_reply_attachments')
  await expect(resolveOutgoingAttachments(payload, { target: 'lead', targetID: uuid, actorID: uuid, attachments: [{ source: 'asset', id: uuid }] })).rejects.toThrow('attachment_not_available')
})

test.each(['quoted"name.pdf', `deleted${String.fromCharCode(127)}name.pdf`, 'line\r\nname.pdf'])('rejects an unsafe descriptor filename before confirmation: %j', async (originalFilename) => {
  const directory = mkdtempSync(join(tmpdir(), 'outgoing-attachment-')); directories.push(directory); process.env.MEDIA_STORAGE_DIR = directory
  writeFileSync(join(directory, 'stored.pdf'), Buffer.from('%PDF-safe attachment'))
  const payload = { findByID: async ({ collection }: { collection: string }) => collection === 'users' ? { roles: ['sales'] } : { currentFile: { filename: 'stored.pdf', originalFilename, mimeType: 'application/pdf' } } } as any
  await expect(resolveOutgoingAttachments(payload, { target: 'lead', targetID: uuid, actorID: uuid, attachments: [{ source: 'asset', id: uuid }] })).rejects.toThrow('attachment_not_available')
})
