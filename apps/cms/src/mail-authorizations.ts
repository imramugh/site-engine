import { createHash } from 'node:crypto'

export type MailGrant = { recipient: string; sender: string; subject: string; body: string; attachmentHashes: string[]; lead: string; revision: number }
export const normalizeBody = (body: string) => body.replace(/\r\n/g, '\n').trim()
export const authorizationDigest = (draft: MailGrant) => createHash('sha256').update(JSON.stringify({ ...draft, recipient: draft.recipient.trim().toLowerCase(), sender: draft.sender.trim().toLowerCase(), subject: draft.subject.trim(), body: normalizeBody(draft.body), attachmentHashes: [...draft.attachmentHashes].sort() })).digest('hex')
export const authorizationUsable = (grant: { digest: string; expiresAt: string; revokedAt?: string | null; consumedAt?: string | null; draftRevision: number }, draft: MailGrant, now = new Date()) => !grant.revokedAt && !grant.consumedAt && new Date(grant.expiresAt) > now && grant.draftRevision === draft.revision && grant.digest === authorizationDigest(draft)
