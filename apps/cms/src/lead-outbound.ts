import type { Payload, PayloadRequest } from 'payload'

/** Re-read the canonical inquiry inside the caller's transaction before any
 * new outbound intent is prepared or consumed. */
export async function assertLeadAcceptsOutbound(payload: Payload, id: string, req?: PayloadRequest) {
  const current = await payload.find({ collection: 'inquiries', where: { id: { equals: id } }, limit: 1, depth: 0, overrideAccess: true, req })
  if (!current.docs[0]) throw new Error('lead_not_found')
  if (current.docs[0].spam) throw new Error('lead_is_spam')
  return current.docs[0]
}
