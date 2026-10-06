import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const directory = mkdtempSync(join(tmpdir(), 'mail-attachments-'))
Object.assign(process.env, { DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`, PAYLOAD_SECRET: 'mail-attachments-test-secret-long-enough', PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64url'), MAILBOX_GOOGLE_CLIENT_ID: 'client', MAILBOX_GOOGLE_CLIENT_SECRET: 'secret' })
const { default: config } = await import('../payload.config.js')
const { completeMailboxOAuth, startMailboxOAuth } = await import('../src/mailbox-oauth.js')
const { downloadMatchedMailAttachment } = await import('../src/mail-attachments.js')
let payload: Awaited<ReturnType<typeof getPayload>>

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload.destroy(); rmSync(directory, { recursive: true, force: true }) })

test('retrieves only a matched record attachment through the fixed Gmail API path', async () => {
  const owner = await payload.create({ collection: 'users', data: { email: 'attachment-owner@example.test', name: 'Owner', roles: ['owner'] }, overrideAccess: true })
  const state = new URL(await startMailboxOAuth(payload, 'google', owner.id, 'attachment-session')).searchParams.get('state')!
  const mailbox = await completeMailboxOAuth(payload, 'google', state, 'code', owner.id, 'attachment-session', async (url) => url.includes('/token') ? Response.json({ access_token: 'setup-access', refresh_token: 'refresh' }) : url.endsWith('/profile') ? Response.json({ emailAddress: 'attachment-mailbox@example.test' }) : Response.json({ sendAs: [{ sendAsEmail: 'attachment-mailbox@example.test', verificationStatus: 'accepted' }] }))
  const lead = await payload.create({ collection: 'inquiries', data: { email: 'same-address@example.test', message: 'lead', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: crypto.randomUUID(), stage: 'new' }, overrideAccess: true })
  const application = await payload.create({ collection: 'applications', data: { name: 'Same address', email: lead.email, coverLetter: 'application', consent: true, jobId: crypto.randomUUID(), resumeKey: 'resume', idempotencyKey: crypto.randomUUID(), status: 'new' }, overrideAccess: true })
  const thread = await payload.create({ collection: 'mail-threads', data: { lead: lead.id, mailbox: mailbox.id, provider: 'google', providerConversationID: 'thread' }, overrideAccess: true })
  const message = await payload.create({ collection: 'mail-thread-messages', data: { thread: thread.id, lead: lead.id, mailbox: mailbox.id, providerMessageID: 'message+opaque', direction: 'inbound', sender: lead.email, recipient: mailbox.primaryAddress, subject: 'Attachment', body: 'body', receivedAt: new Date().toISOString(), attachmentMetadata: [{ name: 'cv.pdf', contentType: 'application/pdf', size: 4, providerAttachmentID: 'attachment+/opaque' }] }, overrideAccess: true })
  const calls: string[] = []
  const fetcher = async (url: string) => { calls.push(url); if (url.includes('/token')) return Response.json({ access_token: 'download-access' }); if (url.includes('/messages/message%2Bopaque/attachments/attachment%2B%2Fopaque')) return Response.json({ data: Buffer.from('file').toString('base64url') }); throw new Error(`unexpected ${url}`) }
  await expect(downloadMatchedMailAttachment(payload, { target: 'lead', targetID: lead.id, messageID: message.id, attachment: 0 }, fetcher)).resolves.toMatchObject({ data: new Uint8Array(Buffer.from('file')), contentType: 'application/pdf', filename: 'cv.pdf' })
  await expect(downloadMatchedMailAttachment(payload, { target: 'application', targetID: application.id, messageID: message.id, attachment: 0 }, fetcher)).rejects.toThrow('attachment_not_found')
  expect(calls.filter(url => url.includes('/attachments/'))).toHaveLength(1)
  expect(calls.find(url => url.includes('/attachments/'))).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/message%2Bopaque/attachments/attachment%2B%2Fopaque')
})
