import { createHash, randomUUID } from 'node:crypto'
import { INQUIRY_TOPIC_VALUES, type InquiryTopicValue } from '@site-engine/contract'
import type { Payload } from 'payload'
import { hasRole } from './access'
import { withPayloadTransaction } from './auth-transaction'

export const inquiryTopics = INQUIRY_TOPIC_VALUES
export const leadStages = ['new', 'qualified', 'contacted', 'proposal', 'won', 'lost'] as const
export type InquiryTopic = InquiryTopicValue
export type LeadStage = typeof leadStages[number]

export type InquiryInput = {
  email: string
  message: string
  topic: InquiryTopic
  sourcePage: string
  consent: boolean
  consentBasis: 'visitor-confirmed' | 'staff-recorded'
  idempotencyKey: string
  name?: string
  telephone?: string
  company?: string
  honeypot?: string
}

export type FieldErrors = Record<string, string>
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const idempotency = /^[a-zA-Z0-9_-]{16,128}$/

function optionalText(value: unknown, max: number, field: string, errors: FieldErrors): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.trim().length > max || controlCharacters.test(value)) {
    errors[field] = `Enter at most ${max} characters without control characters.`
    return undefined
  }
  return value.trim()
}

/** Validate a public form payload without ever interpreting its message as markup. */
export function validateInquiry(value: unknown): { input?: InquiryInput; errors: FieldErrors } {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const errors: FieldErrors = {}
  const normalizedEmail = typeof record.email === 'string' ? record.email.trim().toLowerCase() : ''
  const message = typeof record.message === 'string' ? record.message.trim() : ''
  const sourcePage = typeof record.sourcePage === 'string' ? record.sourcePage.trim() : ''
  const topic = record.topic
  const key = typeof record.idempotencyKey === 'string' ? record.idempotencyKey : ''
  if (!email.test(normalizedEmail) || normalizedEmail.length > 254) errors.email = 'Enter a valid email address.'
  if (!message || message.length > 5_000 || controlCharacters.test(message)) errors.message = 'Enter a message of up to 5,000 characters.'
  if (!sourcePage || sourcePage.length > 240 || !/^\/(?!\/)[a-z0-9/_-]*$/i.test(sourcePage)) errors.sourcePage = 'Enter a safe source page path.'
  if (!inquiryTopics.includes(topic as InquiryTopic)) errors.topic = 'Choose an inquiry topic.'
  if (record.consent !== true) errors.consent = 'Consent is required before sending an inquiry.'
  if (!idempotency.test(key)) errors.idempotencyKey = 'This form request cannot be accepted. Refresh and try again.'
  let name: string | undefined
  if (record.name !== undefined && record.name !== null && record.name !== '') {
    if (typeof record.name !== 'string' || !record.name.trim() || record.name.trim().length > 160 || controlCharacters.test(record.name)) errors.name = 'Enter a name of up to 160 characters without control characters.'
    else name = record.name.trim()
  }
  const telephone = optionalText(record.telephone, 48, 'telephone', errors)
  const company = optionalText(record.company, 160, 'company', errors)
  if (Object.keys(errors).length) return { errors }
  return { errors, input: { email: normalizedEmail, message, sourcePage, topic: topic as InquiryTopic, consent: true, consentBasis: 'visitor-confirmed', idempotencyKey: key, name, telephone, company, honeypot: typeof record.honeypot === 'string' ? record.honeypot : undefined } }
}

export function canTransitionLead(from: LeadStage, to: LeadStage): boolean {
  if (from === to) return true
  if (from === 'new') return ['qualified', 'contacted', 'lost'].includes(to)
  if (from === 'qualified') return ['contacted', 'lost'].includes(to)
  if (from === 'contacted') return ['qualified', 'proposal', 'lost'].includes(to)
  if (from === 'proposal') return ['won', 'lost', 'contacted'].includes(to)
  return false
}

export function csvEscape(value: unknown): string {
  const text = String(value ?? '')
  // A leading spreadsheet formula marker becomes visible text when opened in a CSV client.
  const safe = /^(?:[\p{White_Space}\p{Cc}\u200b\ufeff])*[=+\-@]/u.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

export class InquiryRateLimitedError extends Error {}
export class InquiryCapacityError extends Error {}
export class InquiryIdempotencyCollisionError extends Error {}
export class LeadAssigneeError extends Error {}
const inFlightIdempotency = new Map<string, Promise<unknown>>()
export const INQUIRY_GLOBAL_PER_MINUTE = Number.isInteger(Number(process.env.INQUIRY_GLOBAL_PER_MINUTE)) ? Math.max(1, Number(process.env.INQUIRY_GLOBAL_PER_MINUTE)) : 100

export function inquiryFingerprint(input: InquiryInput): string {
  return createHash('sha256').update(JSON.stringify({ email: input.email, message: input.message, topic: input.topic, sourcePage: input.sourcePage, name: input.name ?? '', telephone: input.telephone ?? '', company: input.company ?? '', consentBasis: input.consentBasis })).digest('base64url')
}

export async function validateLeadAssignee(payload: Payload, value: unknown): Promise<string | null> {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new LeadAssigneeError('Choose an active sales or owner user as assignee.')
  try {
    const user = await payload.findByID({ collection: 'users', id: value, depth: 0, overrideAccess: true })
    if (user.disabled || !hasRole(user, ['owner', 'sales'])) throw new LeadAssigneeError('Choose an active sales or owner user as assignee.')
    return user.id
  } catch (error) {
    if (error instanceof LeadAssigneeError) throw error
    throw new LeadAssigneeError('Choose an active sales or owner user as assignee.')
  }
}

async function persistAcceptedInquiry(payload: Payload, input: InquiryInput, actor?: { id: string }) {
  if (input.honeypot?.trim()) return { suppressed: true as const }
  return withPayloadTransaction(payload, async (req) => {
    const duplicate = await payload.find({ collection: 'inquiries', where: { idempotencyKey: { equals: input.idempotencyKey } }, limit: 1, depth: 0, overrideAccess: true, req })
    if (duplicate.docs[0]) {
      const existing = duplicate.docs[0]
      const existingFingerprint = inquiryFingerprint({ email: existing.email, message: existing.message, topic: existing.topic, sourcePage: existing.sourcePage, consent: true, consentBasis: 'visitor-confirmed', idempotencyKey: input.idempotencyKey, name: existing.name ?? undefined, telephone: existing.telephone ?? undefined, company: existing.company ?? undefined })
      if (existingFingerprint !== inquiryFingerprint(input)) throw new InquiryIdempotencyCollisionError('This submission key is already in use.')
      return { inquiry: existing, duplicate: true as const }
    }
    const globalRecent = await payload.count({ collection: 'inquiries', where: { createdAt: { greater_than: new Date(Date.now() - 60_000).toISOString() } }, overrideAccess: true, req })
    if (globalRecent.totalDocs >= INQUIRY_GLOBAL_PER_MINUTE) throw new InquiryCapacityError('Inquiry intake is temporarily busy. Please try again shortly.')
    const recent = await payload.find({
      collection: 'inquiries',
      where: { and: [{ email: { equals: input.email } }, { createdAt: { greater_than: new Date(Date.now() - 60_000).toISOString() } }] },
      limit: 1, depth: 0, overrideAccess: true, req,
    })
    if (recent.docs.length) throw new InquiryRateLimitedError('Please wait before sending another inquiry.')
    const urgent = input.topic === 'active-incident'
    const inquiry = await payload.create({
      collection: 'inquiries',
      data: { email: input.email, message: input.message, topic: input.topic, sourcePage: input.sourcePage, consentedAt: new Date().toISOString(), consentBasis: input.consentBasis, idempotencyKey: input.idempotencyKey, name: input.name, telephone: input.telephone, company: input.company, stage: 'new', urgent },
      overrideAccess: true, req,
    })
    if (actor) await payload.create({ collection: 'audit-events', data: { event: 'lead.created', user: actor.id, actor: actor.id, detail: { lead: inquiry.id, consentBasis: input.consentBasis } }, overrideAccess: true, req })
    const event = { inquiry: inquiry.id, topic: input.topic, sourcePage: input.sourcePage, urgent }
    await payload.create({ collection: 'notification-outbox', data: { inquiry: inquiry.id, kind: 'lead-received', idempotencyKey: `lead-received:${input.idempotencyKey}`, state: 'queued', payload: event, availableAt: new Date().toISOString() }, overrideAccess: true, req })
    if (urgent) await payload.create({ collection: 'notification-outbox', data: { inquiry: inquiry.id, kind: 'urgent-lead-alert', idempotencyKey: `urgent-lead-alert:${input.idempotencyKey}`, state: 'queued', payload: event, availableAt: new Date().toISOString() }, overrideAccess: true, req })
    return { inquiry, duplicate: false as const }
  })
}

/** Serialize same-key retries inside this CMS process before opening SQLite's immediate transaction. */
export async function createAcceptedInquiry(payload: Payload, input: InquiryInput, actor?: { id: string }) {
  if (input.honeypot?.trim()) return { suppressed: true as const }
  const active = inFlightIdempotency.get(input.idempotencyKey)
  if (active) {
    await active
    return createAcceptedInquiry(payload, input, actor)
  }
  const operation = persistAcceptedInquiry(payload, input, actor)
  inFlightIdempotency.set(input.idempotencyKey, operation)
  try { return await operation } finally { if (inFlightIdempotency.get(input.idempotencyKey) === operation) inFlightIdempotency.delete(input.idempotencyKey) }
}

export function manualInquiryInput(value: unknown): { input?: InquiryInput; errors: FieldErrors } {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const result = validateInquiry({ ...record, sourcePage: record.sourcePage || '/manual', idempotencyKey: `manual_${randomUUID().replaceAll('-', '')}` })
  if (!result.input) return result
  if (record.consentBasis !== 'staff-recorded') return { errors: { consentBasis: 'Record the consent basis before creating a manual lead.' } }
  return { errors: {}, input: { ...result.input, consentBasis: 'staff-recorded' } }
}
