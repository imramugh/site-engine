import type { Payload } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
import { leadStages, type LeadStage } from './inquiries'

export class LeadSpamLifecycleError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'NOT_SPAM' | 'ALREADY_SPAM' | 'ACTIVE_SEND', message: string) { super(message) }
}

export async function classifyLeadAsSpam(payload: Payload, id: string, actor: string) {
  return withPayloadTransaction(payload, async (req) => {
    const current = await payload.find({ collection: 'inquiries', where: { id: { equals: id } }, limit: 1, depth: 0, overrideAccess: true, req })
    const lead = current.docs[0]
    if (!lead) throw new LeadSpamLifecycleError('NOT_FOUND', 'Lead not found.')
    if (lead.spam) throw new LeadSpamLifecycleError('ALREADY_SPAM', 'Lead is already classified as spam.')
    const prior = leadStages.includes(lead.stage as LeadStage) ? lead.stage as LeadStage : 'new'
    const queued = await payload.find({ collection: 'notification-outbox', where: { and: [{ inquiry: { equals: id } }, { state: { equals: 'queued' } }] }, limit: 0, pagination: false, depth: 0, overrideAccess: true, req })
    for (const intent of queued.docs) await payload.delete({ collection: 'notification-outbox', id: intent.id, overrideAccess: true, req })
    req.context.leadSpamLifecycle = true
    const updated = await payload.update({ collection: 'inquiries', id, data: { spam: true, spamMarkedAt: new Date().toISOString(), spamPreviousStage: prior }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'lead.spam_classified', user: actor, actor, detail: { lead: id, previousStage: prior, cancelledNotifications: queued.totalDocs } }, overrideAccess: true, req })
    return updated
  })
}

export async function restoreLeadFromSpam(payload: Payload, id: string, actor: string) {
  return withPayloadTransaction(payload, async (req) => {
    const current = await payload.find({ collection: 'inquiries', where: { id: { equals: id } }, limit: 1, depth: 0, overrideAccess: true, req })
    const lead = current.docs[0]
    if (!lead) throw new LeadSpamLifecycleError('NOT_FOUND', 'Lead not found.')
    if (!lead.spam) throw new LeadSpamLifecycleError('NOT_SPAM', 'Lead is not classified as spam.')
    req.context.leadSpamLifecycle = true
    const updated = await payload.update({ collection: 'inquiries', id, data: { spam: false, spamMarkedAt: null, spamPreviousStage: null, stage: 'new' }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'lead.spam_restored', user: actor, actor, detail: { lead: id, restoredStage: 'new' } }, overrideAccess: true, req })
    return updated
  })
}

/** Permanently removes an explicitly selected spam record and its mutable,
 * inquiry-bound delivery material. Immutable audit records retain IDs only. */
export async function deleteSpamLead(payload: Payload, id: string, actor: string) {
  return withPayloadTransaction(payload, async (req) => {
    const current = await payload.find({ collection: 'inquiries', where: { id: { equals: id } }, limit: 1, depth: 0, overrideAccess: true, req })
    const lead = current.docs[0]
    if (!lead) throw new LeadSpamLifecycleError('NOT_FOUND', 'Lead not found.')
    if (!lead.spam) throw new LeadSpamLifecycleError('NOT_SPAM', 'Only spam can be permanently deleted here.')

    const outbox = await payload.find({ collection: 'notification-outbox', where: { inquiry: { equals: id } }, limit: 0, pagination: false, depth: 0, overrideAccess: true, req })
    if (outbox.docs.some((item) => item.state === 'queued')) throw new LeadSpamLifecycleError('ACTIVE_SEND', 'Cancel or finish queued notifications before deleting this spam record.')
    const drafts = await payload.find({ collection: 'mail-drafts', where: { lead: { equals: id } }, limit: 0, pagination: false, depth: 0, overrideAccess: true, req })
    if (drafts.docs.some((item) => item.state === 'authorized')) throw new LeadSpamLifecycleError('ACTIVE_SEND', 'Revoke the authorized reply before deleting this spam record.')

    for (const draft of drafts.docs) {
      const grants = await payload.find({ collection: 'mail-authorizations', where: { draft: { equals: draft.id } }, limit: 0, pagination: false, depth: 0, overrideAccess: true, req })
      for (const grant of grants.docs) await payload.delete({ collection: 'mail-authorizations', id: grant.id, overrideAccess: true, req })
      await payload.delete({ collection: 'mail-drafts', id: draft.id, overrideAccess: true, req })
    }
    // Completed/failed notification rows remain as non-PII delivery history.
    for (const intent of outbox.docs) await payload.update({ collection: 'notification-outbox', id: intent.id, data: { inquiry: null }, overrideAccess: true, req })
    // The collection hook removes only outbox rows for this exact inquiry.
    req.context.leadSpamDeleteLifecycle = true
    await payload.delete({ collection: 'inquiries', id, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'lead.spam_deleted', user: actor, actor, detail: { lead: id } }, overrideAccess: true, req })
  })
}
