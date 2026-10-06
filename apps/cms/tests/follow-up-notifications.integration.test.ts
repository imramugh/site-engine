import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'

const directory = mkdtempSync(join(tmpdir(), 'follow-up-notifications-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'follow-up-notifications-secret', PAYLOAD_PUBLIC_SERVER_URL: 'http://cms.test', FOLLOW_UPS_TIMEZONE: 'America/Toronto' })
const { default: config } = await import('../payload.config.js')
const { enqueueDueFollowUps } = await import('../src/follow-up-notifications.js')
let payload: Awaited<ReturnType<typeof getPayload>>
beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }) })

async function lead(email: string, assignee: string, values: Record<string, unknown> = {}) {
  return payload.create({ collection: 'inquiries', data: { email, message: 'Synthetic follow-up fixture.', topic: 'project', sourcePage: '/synthetic', consentedAt: '2026-10-05T00:00:00.000Z', consentBasis: 'staff-recorded', idempotencyKey: `follow-up:${email}`, stage: 'contacted', assignee, nextAction: 'Call back', nextActionDueAt: '2026-10-05T00:00:00.000Z', ...values }, overrideAccess: true })
}
test('due assigned active leads enqueue once after 08:00 local time and exclude inactive records', async () => {
  const user = await payload.create({ collection: 'users', data: { email: 'follow-ups@example.test', name: 'Follow ups', roles: ['sales'] }, overrideAccess: true })
  const due = await lead('due@example.test', user.id)
  for (let index = 0; index < 25; index += 1) await lead(`queued-${index}@example.test`, user.id)
  await lead('won@example.test', user.id, { stage: 'won' })
  await lead('empty@example.test', user.id, { nextAction: '' })
  await lead('unassigned@example.test', user.id, { assignee: null })
  expect(await enqueueDueFollowUps(payload, new Date('2026-10-05T11:59:00.000Z'))).toBe(0)
  await Promise.all([enqueueDueFollowUps(payload, new Date('2026-10-05T12:00:00.000Z')), enqueueDueFollowUps(payload, new Date('2026-10-05T12:00:00.000Z'))])
  await enqueueDueFollowUps(payload, new Date('2026-10-05T12:00:00.000Z'))
  const outbox = await payload.find({ collection: 'notification-outbox', where: { inquiry: { equals: due.id } }, limit: 10, depth: 0, overrideAccess: true })
  expect(outbox.totalDocs).toBe(1)
  expect(outbox.docs[0]).toMatchObject({ kind: 'follow-ups-due', idempotencyKey: `follow-ups-due:${due.id}:2026-10-05`, payload: { day: '2026-10-05' } })
  const all = await payload.find({ collection: 'notification-outbox', where: { kind: { equals: 'follow-ups-due' } }, limit: 10, depth: 0, overrideAccess: true })
  expect(all.totalDocs).toBe(26)
})
test('DST fallback uses the local calendar day as the durable idempotency boundary', async () => {
  const user = await payload.create({ collection: 'users', data: { email: 'dst-follow-ups@example.test', name: 'DST Follow ups', roles: ['sales'] }, overrideAccess: true })
  const due = await lead('dst-due@example.test', user.id, { nextActionDueAt: '2026-11-01T00:00:00.000Z' })
  await enqueueDueFollowUps(payload, new Date('2026-11-01T13:00:00.000Z'))
  await enqueueDueFollowUps(payload, new Date('2026-11-01T18:00:00.000Z'))
  const outbox = await payload.find({ collection: 'notification-outbox', where: { inquiry: { equals: due.id } }, limit: 10, depth: 0, overrideAccess: true })
  expect(outbox.totalDocs).toBe(1)
  expect(outbox.docs[0]?.idempotencyKey).toBe(`follow-ups-due:${due.id}:2026-11-01`)
})
