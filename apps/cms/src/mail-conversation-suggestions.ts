import { createHash } from 'node:crypto'
import type { Payload } from 'payload'
import { withPayloadTransaction } from './auth-transaction'

const locks = new Map<string, Promise<void>>()
async function exclusive<T>(key: string, fn: () => Promise<T>) { const prior = locks.get(key) ?? Promise.resolve(); let release: () => void = () => undefined; const current = new Promise<void>(resolve => { release = resolve }); locks.set(key, current); await prior; try { return await fn() } finally { release(); if (locks.get(key) === current) locks.delete(key) } }
const relationID = (value: unknown) => typeof value === 'string' ? value : String((value as { id?: string } | null)?.id ?? '')
const email = (value: unknown) => String(value ?? '').trim().toLowerCase()
const addressHash = (value: unknown) => createHash('sha256').update(email(value)).digest('hex')

/** Explicitly binds a safe, same-address suggestion; it never imports message content. */
export async function adoptMailConversationSuggestion(payload: Payload, input: { suggestionID: string; target: 'lead' | 'application'; targetID: string; actor: string }) {
  return exclusive(input.suggestionID, () => withPayloadTransaction(payload, async req => {
    const suggestion = await payload.findByID({ collection: 'mail-conversation-suggestions', id: input.suggestionID, depth: 0, overrideAccess: true, req })
    if (suggestion.target !== input.target) throw new Error('suggestion_not_usable')
    // Validate the requested target and its current mailbox mapping before the
    // idempotent path too. Otherwise an adopted suggestion could disclose its
    // thread ID to a different record on a later retry.
    const collection = input.target === 'lead' ? 'inquiries' : 'applications'
    const record = await payload.findByID({ collection, id: input.targetID, depth: 0, overrideAccess: true, req }) as { email?: string }
    if (addressHash(record.email) !== suggestion.addressHash) throw new Error('suggestion_not_usable')
    const area = input.target === 'lead' ? 'leads' : 'careers'
    const mapping = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: area } }, limit: 1, depth: 0, overrideAccess: true, req })
    if (relationID(mapping.docs[0]?.mailbox) !== relationID(suggestion.mailbox)) throw new Error('suggestion_not_usable')
    const existing = await payload.find({ collection: 'mail-threads', where: { and: [{ mailbox: { equals: suggestion.mailbox } }, { provider: { equals: suggestion.provider } }, { providerConversationID: { equals: suggestion.providerConversationID } }] }, limit: 1, depth: 0, overrideAccess: true, req })
    const prior = existing.docs[0]
    if (suggestion.adoptedAt) {
      const bound = prior && (input.target === 'lead' ? relationID(prior.lead) === input.targetID : relationID(prior.application) === input.targetID)
      if (bound) return prior
      throw new Error('suggestion_not_usable')
    }
    const thread = prior ?? await payload.create({ collection: 'mail-threads', data: { [input.target]: input.targetID, mailbox: suggestion.mailbox, provider: suggestion.provider, providerConversationID: suggestion.providerConversationID } as never, overrideAccess: true, req })
    const bound = input.target === 'lead' ? relationID(thread.lead) === input.targetID : relationID(thread.application) === input.targetID
    if (!bound) throw new Error('suggestion_not_usable')
    await payload.update({ collection: 'mail-conversation-suggestions', id: suggestion.id, data: { adoptedAt: new Date().toISOString(), adoptedBy: input.actor }, overrideAccess: true, req })
    await payload.create({ collection: 'audit-events', data: { event: 'mail.conversation_adopted', user: input.actor, actor: input.actor, detail: { suggestion: suggestion.id, target: input.target, targetID: input.targetID, mailbox: relationID(suggestion.mailbox), provider: suggestion.provider } }, overrideAccess: true, req })
    return thread
  }))
}
