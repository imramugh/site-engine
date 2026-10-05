import type { Payload } from 'payload'
import { enqueueNotification } from './notification-settings'

const formatterCache = new Map<string, Intl.DateTimeFormat>()
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
export async function enqueueDueFollowUps(payload: Payload, now = new Date(), limit = 25): Promise<number> {
  const local = parts(now, followUpTimezone())
  if (local.hour < 8) return 0
  const result = await payload.find({ collection: 'inquiries', where: { and: [
    { nextActionDueAt: { less_than_equal: now.toISOString() } }, { nextAction: { exists: true } }, { assignee: { exists: true } },
    { spam: { not_equals: true } }, { stage: { not_in: ['won', 'lost'] } },
  ] }, sort: 'nextActionDueAt', limit, pagination: false, depth: 0, overrideAccess: true })
  let queued = 0
  for (const lead of result.docs as Array<{ id: string; assignee?: string }>) {
    const intent = await enqueueNotification(payload, undefined, { kind: 'follow-ups-due', idempotencyKey: `follow-ups-due:${lead.id}:${local.day}`, inquiry: lead.id, sourceType: 'inquiry', sourceID: lead.id, leadOwnerID: lead.assignee, payload: { day: local.day } })
    if (intent) queued += 1
  }
  return queued
}
