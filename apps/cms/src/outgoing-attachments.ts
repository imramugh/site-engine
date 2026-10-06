import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { Payload } from 'payload'
import { readResume } from './applications'
import { mediaFilePath } from './media'

const maxCount = 5
const maxBytes = 10 * 1024 * 1024
const allowed = new Set(['image/avif', 'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type OutgoingAttachment = { source: 'asset' | 'application-resume'; sourceID: string; filename: string; mimeType: string; size: number; sha256: string }

const safeName = (value: unknown) => typeof value === 'string' && /^[^\u0000-\u001f\\/]{1,240}$/.test(value) ? value : undefined
const roleAllowed = (roles: unknown, target: 'lead' | 'application') => Array.isArray(roles) && (roles.includes('owner') || (target === 'lead' ? roles.includes('sales') : roles.includes('hiring')))

/** Resolves only server-owned asset IDs or the current target application's resume.
 * The returned immutable metadata is what confirmation binds; delivery remains disabled. */
export async function resolveOutgoingAttachments(payload: Payload, input: { target: 'lead' | 'application'; targetID: string; actorID: string; attachments?: unknown }): Promise<OutgoingAttachment[]> {
  if (input.attachments === undefined) return []
  if (!Array.isArray(input.attachments) || input.attachments.length > maxCount) throw new Error('invalid_reply_attachments')
  const actor = await payload.findByID({ collection: 'users', id: input.actorID, depth: 0, overrideAccess: true }) as { roles?: unknown; disabled?: unknown }
  if (actor.disabled || !roleAllowed(actor.roles, input.target)) throw new Error('mail_authorization_required')
  const output: OutgoingAttachment[] = []
  let total = 0
  for (const item of input.attachments) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_reply_attachments')
    const source = (item as { source?: unknown }).source
    if (source === 'asset') {
      const sourceID = (item as { id?: unknown }).id
      if (typeof sourceID !== 'string' || !id.test(sourceID)) throw new Error('invalid_reply_attachments')
      const asset = await payload.findByID({ collection: 'assets', id: sourceID, depth: 0, user: actor as never, overrideAccess: false }) as { deletedAt?: unknown; currentFile?: unknown }
      const file = asset.currentFile as { filename?: unknown; originalFilename?: unknown; mimeType?: unknown; filesize?: unknown } | undefined
      const filename = safeName(file?.originalFilename) ?? safeName(file?.filename)
      const mimeType = typeof file?.mimeType === 'string' ? file.mimeType : ''
      if (asset.deletedAt || !filename || !allowed.has(mimeType) || !safeName(file?.filename)) throw new Error('attachment_not_available')
      const path = mediaFilePath(String(file!.filename)); const size = statSync(path).size
      if (size < 1 || size > maxBytes) throw new Error('attachment_not_available')
      const bytes = readFileSync(path); if (size !== bytes.length) throw new Error('attachment_not_available')
      output.push({ source: 'asset', sourceID, filename, mimeType, size, sha256: createHash('sha256').update(bytes).digest('hex') })
    } else if (source === 'application-resume') {
      if (input.target !== 'application' || (item as { id?: unknown }).id !== input.targetID) throw new Error('attachment_not_available')
      const application = await payload.findByID({ collection: 'applications', id: input.targetID, depth: 0, overrideAccess: true }) as { resumeKey?: unknown }
      if (typeof application.resumeKey !== 'string') throw new Error('attachment_not_available')
      const bytes = await readResume(application.resumeKey); const mimeType = bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      output.push({ source: 'application-resume', sourceID: input.targetID, filename: 'resume.' + (mimeType === 'application/pdf' ? 'pdf' : 'docx'), mimeType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    } else throw new Error('invalid_reply_attachments')
    total += output.at(-1)!.size
    if (total > maxBytes || !allowed.has(output.at(-1)!.mimeType)) throw new Error('invalid_reply_attachments')
  }
  if (new Set(output.map((attachment) => `${attachment.source}:${attachment.sourceID}`)).size !== output.length) throw new Error('invalid_reply_attachments')
  return output
}
