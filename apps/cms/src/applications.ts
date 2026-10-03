import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, constants, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const maxBytes = 5_000_000; const maxUncompressed = 20_000_000
export const applicationStorage = () => resolve(process.env.APPLICATION_STORAGE_DIR || './data/applications')

/** Read only the original immutable upload; never follow a substituted symlink. */
export async function readResume(key: string): Promise<Buffer> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid resume key')
  const handle = await open(resolve(applicationStorage(), key), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error('Invalid resume file')
    const bytes = await handle.readFile()
    if (createHash('sha256').update(bytes).digest('hex') !== key.slice(-64)) throw new Error('Resume content changed')
    return bytes
  } finally {
    await handle.close()
  }
}
type Entry = { compressed: number; uncompressed: number; method: number; offset: number }
function entries(data: Buffer) {
  const end = data.lastIndexOf(Buffer.from('PK\x05\x06')); if (end < 0 || end + 22 > data.length) throw new Error('Resume content does not match DOCX.')
  const count = data.readUInt16LE(end + 10); const size = data.readUInt32LE(end + 12); const start = data.readUInt32LE(end + 16)
  if (!count || count > 1000 || start + size > end) throw new Error('Resume content does not match DOCX.')
  const result = new Map<string, Entry>(); let offset = start; let total = 0
  for (let i = 0; i < count; i += 1) { if (offset + 46 > start + size || data.readUInt32LE(offset) !== 0x02014b50) throw new Error('Resume content does not match DOCX.'); const flags = data.readUInt16LE(offset + 8); const method = data.readUInt16LE(offset + 10); const compressed = data.readUInt32LE(offset + 20); const uncompressed = data.readUInt32LE(offset + 24); const nameLength = data.readUInt16LE(offset + 28); const extra = data.readUInt16LE(offset + 30); const comment = data.readUInt16LE(offset + 32); const local = data.readUInt32LE(offset + 42); const next = offset + 46 + nameLength + extra + comment; if (next > start + size || flags & 1 || ![0, 8].includes(method) || uncompressed > maxUncompressed || (compressed && uncompressed / compressed > 100)) throw new Error('Resume content does not match DOCX.'); total += uncompressed; if (total > maxUncompressed) throw new Error('Resume content does not match DOCX.'); const name = data.subarray(offset + 46, offset + 46 + nameLength).toString(); if (!name || name.includes('..') || name.startsWith('/') || name.includes('\\') || /(?:^|\/)vba(?:Project|Data)\.(?:bin|xml)$/i.test(name) || result.has(name)) throw new Error('Resume content does not match DOCX.'); result.set(name, { compressed, uncompressed, method, offset: local }); offset = next }
  if (offset !== start + size) throw new Error('Resume content does not match DOCX.'); return result
}
function content(data: Buffer, entry: Entry) { if (entry.offset + 30 > data.length || data.readUInt32LE(entry.offset) !== 0x04034b50 || data.readUInt16LE(entry.offset + 8) !== entry.method) throw new Error('Resume content does not match DOCX.'); const nameLength = data.readUInt16LE(entry.offset + 26); const name = data.subarray(entry.offset + 30, entry.offset + 30 + nameLength).toString(); if (!name) throw new Error('Resume content does not match DOCX.'); const start = entry.offset + 30 + nameLength + data.readUInt16LE(entry.offset + 28); const end = start + entry.compressed; if (end > data.length) throw new Error('Resume content does not match DOCX.'); const value = entry.method === 8 ? inflateRawSync(data.subarray(start, end), { maxOutputLength: maxUncompressed }) : data.subarray(start, end); if (value.length !== entry.uncompressed) throw new Error('Resume content does not match DOCX.'); return value }
export function validateResume(file: { data: Buffer; mimetype: string; size: number; name: string }) { if (file.size !== file.data.length || !['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.mimetype) || file.size < 1 || file.size > maxBytes) throw new Error('Resume must be a PDF or DOCX no larger than 5 MiB.'); if (file.mimetype === 'application/pdf' && !file.data.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Resume content does not match PDF.'); if (file.mimetype.includes('officedocument')) { const found = entries(file.data); const types = found.get('[Content_Types].xml'); const document = found.get('word/document.xml'); const typeXML = types && content(file.data, types).toString(); if (!types || !document || !typeXML?.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') || /macroEnabled|vbaProject/i.test(typeXML) || [...found.entries()].some(([name, entry]) => name.endsWith('.rels') && /TargetMode\s*=\s*["']External["']/i.test(content(file.data, entry).toString())) || !/<w:document\b/.test(content(file.data, document).toString())) throw new Error('Resume content does not match DOCX.') } }
export function storeResume(file: { data: Buffer; name: string }) { const directory = applicationStorage(); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); const key = `${randomUUID()}-${createHash('sha256').update(file.data).digest('hex')}`; writeFileSync(resolve(directory, key), file.data, { mode: 0o600, flag: 'wx' }); return key }
export function removeResume(key: string) { try { unlinkSync(resolve(applicationStorage(), key)) } catch { /* Missing temporary files are already clean. */ } }
