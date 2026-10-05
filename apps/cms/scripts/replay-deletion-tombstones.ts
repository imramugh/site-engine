import { readFileSync, statSync } from 'node:fs'
import { getPayload } from 'payload'
import config from '../payload.config'
import { reapplyDeletionTombstones, writeDeletionTombstone } from '../src/retention'

const source = process.env.RETENTION_TOMBSTONES_FILE
if (!source || !source.startsWith('/')) throw new Error('RETENTION_TOMBSTONES_FILE must be an absolute ledger path.')
const stat = statSync(source)
if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Deletion ledger must be a regular mode-0600/0640 file.')
const rows = readFileSync(source, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { resourceType?: unknown; resourceID?: unknown; deletedAt?: unknown })
for (const row of rows) if (!['application', 'inquiry', 'media'].includes(String(row.resourceType)) || typeof row.resourceID !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.resourceID) || typeof row.deletedAt !== 'string' || Number.isNaN(Date.parse(row.deletedAt))) throw new Error('Deletion ledger contains an invalid entry.')
const payload = await getPayload({ config })
try {
  for (const row of rows) await writeDeletionTombstone(payload, undefined, row.resourceType as 'application' | 'inquiry' | 'media', row.resourceID as string)
  const applied = await reapplyDeletionTombstones(payload)
  console.log(`Replayed ${rows.length} deletion ledger entries; reapplied ${applied} purges.`)
} finally { await payload.destroy() }
