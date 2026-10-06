import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPayload } from 'payload'
const directory = mkdtempSync(join(tmpdir(), 'mailbox-scheduler-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'mailbox-scheduler-test-secret', PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test' })
const { default: config } = await import('../payload.config.js')
const { runMailboxSyncCycle } = await import('../src/mailbox-sync-worker.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
beforeEach(async () => { await payload.delete({ collection: 'mailbox-configurations', where: {}, overrideAccess: true }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }) })
const create = (name: string, extra: Record<string, unknown> = {}) => payload.create({ collection: 'mailbox-configurations', data: { name, aliases: [], verifiedAliases: [], provider: 'google', primaryAddress: `${name}@example.test`, host: 'gmail.googleapis.com', port: 443, security: 'tls', username: name, credentialRevision: name, health: 'connected', ...extra }, overrideAccess: true, context: { mailboxInternal: true } })
const read = (id: string) => payload.findByID({ collection: 'mailbox-configurations', id, overrideAccess: true })
test('failed mailbox backoff survives a new cycle and cannot starve another mailbox', async () => {
  const now = Date.now(); const first = await create('failed', { inboundLastSyncedAt: new Date(now - 20_000).toISOString() }); const second = await create('healthy', { inboundLastSyncedAt: new Date(now - 10_000).toISOString() })
  const called: string[] = []
  await runMailboxSyncCycle(payload, { sync: async (_payload, id) => { called.push(id); throw new Error('provider unavailable') } }, now)
  expect(called).toEqual([first.id])
  expect(await read(first.id)).toMatchObject({ inboundFailureCount: 1, inboundLastError: 'sync_failed', inboundNextAttemptAt: new Date(now + 2000).toISOString() })
  const result = await runMailboxSyncCycle(payload, { sync: async (_payload, id) => { called.push(id); return { skipped: false, processed: 2 } } }, now + 1)
  expect(result).toEqual({ mailbox: second.id, processed: 2 }); expect(called).toEqual([first.id, second.id])
  expect(await read(second.id)).toMatchObject({ inboundFailureCount: 0, inboundLastError: null })
})
test('eligibility is applied before pagination across many delayed mailboxes', async () => {
  const now = Date.now()
  for (let index = 0; index < 26; index++) await create(`delayed-${index}`, { inboundNextAttemptAt: new Date(now + 60_000).toISOString() })
  const ready = await create('ready')
  expect(await runMailboxSyncCycle(payload, { sync: async () => ({ skipped: false, processed: 1 }) }, now)).toEqual({ mailbox: ready.id, processed: 1 })
})
test('a real deadline cancels the active operation and overlapping polls share one cycle', async () => {
  const mailbox = await create('slow'); let calls = 0; let finished = false
  const dependencies = { budgetMS: 50, sync: async (_payload: unknown, _id: string, _fetcher: unknown, signal?: AbortSignal) => {
    calls++
    await new Promise<void>((_resolve, reject) => { if (signal?.aborted) reject(signal.reason); else signal?.addEventListener('abort', () => reject(signal.reason), { once: true }) }).finally(() => { finished = true })
    return { skipped: false as const, processed: 1 }
  } }
  const started = Date.now(); const first = runMailboxSyncCycle(payload, dependencies); const second = runMailboxSyncCycle(payload, dependencies)
  expect(first).toBe(second)
  expect(await first).toEqual({ mailbox: mailbox.id, processed: 0 }); expect(calls).toBe(1); expect(finished).toBe(true); expect(Date.now() - started).toBeLessThan(2000)
  expect(await read(mailbox.id)).toMatchObject({ inboundLastError: 'sync_timeout', inboundFailureCount: 1 })
})
