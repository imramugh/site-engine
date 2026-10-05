import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { getPayload } from 'payload'
import config from '../payload.config'
import { reapplyDeletionTombstones, writeDeletionTombstone } from '../src/retention'

const source = process.env.RETENTION_TOMBSTONES_FILE
if (!source || !source.startsWith('/')) throw new Error('RETENTION_TOMBSTONES_FILE must be an absolute ledger path.')
const descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW)
let content: string
try {
  const stat = fstatSync(descriptor)
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('Deletion ledger must be a regular mode-0600 file.')
  content = readFileSync(descriptor, 'utf8')
} finally { closeSync(descriptor) }
if (content && !content.endsWith('\n')) throw new Error('Deletion ledger ends with an incomplete entry.')
const rows = content.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as { resourceType?: unknown; resourceID?: unknown; deletedAt?: unknown } } catch { throw new Error('Deletion ledger contains an invalid entry.') } })
for (const row of rows) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'deletedAt,resourceID,resourceType' || !['application', 'inquiry', 'media'].includes(String(row.resourceType)) || typeof row.resourceID !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.resourceID) || typeof row.deletedAt !== 'string' || Number.isNaN(Date.parse(row.deletedAt))) throw new Error('Deletion ledger contains an invalid entry.')
}
const payload = await getPayload({ config })
try {
  for (const row of rows) await writeDeletionTombstone(payload, undefined, row.resourceType as 'application' | 'inquiry' | 'media', row.resourceID as string, row.deletedAt as string)
  const applied = await reapplyDeletionTombstones(payload)
  console.log(`Replayed ${rows.length} deletion ledger entries; reapplied ${applied} purges.`)
} finally { await payload.destroy() }
