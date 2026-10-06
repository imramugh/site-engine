import type { Payload } from 'payload'
import { enqueueNotification } from './notification-settings'

const formatterCache = new Map<string, Intl.DateTimeFormat>()
let currentRun: Promise<number> | undefined
function parts(now: Date, zone: string) {
  let formatter = formatterCache.get(zone)
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); formatterCache.set(zone, formatter) }
  const value = Object.fromEntries(formatter.formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value])) as Record<string, string>
  return { day: `${value.year}-${value.month}-${value.day}`, hour: Number(value.hour) }
}
export function followUpTimezone(): string {
  const zone = process.env.FOLLOW_UPS_TIMEZONE ?? 'UTC'
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(); return zone } catch { return 'UTC' }
}

/** Creates at most `limit` daily durable intents. It is safe to rerun after 08:00 local time. */
export async function enqueueDueFollowUps(payload: Payload, now = new Date(), limit = 100): Promise<number> {
  if (currentRun) return currentRun
  const run = enqueueDueFollowUpsLocked(payload, now, limit)
  currentRun = run
  try { return await run } finally { if (currentRun === run) currentRun = undefined }
}
async function enqueueDueFollowUpsLocked(payload: Payload, now: Date, limit: number): Promise<number> {
  const local = parts(now, followUpTimezone())
  if (local.hour < 8) return 0
  let queued = 0
  let page = 1; let scanned = 0
  while (scanned < limit) {
    const result = await payload.find({ collection: 'inquiries', where: { and: [
      { nextActionDueAt: { less_than_equal: now.toISOString() } }, { nextAction: { exists: true } }, { nextAction: { not_equals: '' } }, { assignee: { exists: true } },
      { spam: { not_equals: true } }, { stage: { not_in: ['won', 'lost'] } },
    ] }, sort: 'nextActionDueAt', limit: Math.min(25, limit - scanned), page, depth: 0, overrideAccess: true })
    for (const lead of result.docs as Array<{ id: string; assignee?: string }>) {
      const intent = await enqueueNotification(payload, undefined, { kind: 'follow-ups-due', idempotencyKey: `follow-ups-due:${lead.id}:${local.day}`, inquiry: lead.id, sourceType: 'inquiry', sourceID: lead.id, leadOwnerID: lead.assignee, payload: { day: local.day } })
      if (intent) queued += 1
    }
    scanned += result.docs.length
    if (!result.hasNextPage || result.docs.length === 0) break
    page += 1
  }
  return queued
}
