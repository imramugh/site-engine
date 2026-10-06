import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload, type Payload } from 'payload'
import { authorizationDigest, authorizeMailDraft, cancelPreparedMailDraft, consumeMailAuthorization, revokeMailAuthorization } from '../src/mail-authorizations'
import { hashOpaqueToken, newOpaqueToken } from '../src/identity'
import { classifyLeadAsSpam, restoreLeadFromSpam } from '../src/lead-spam-lifecycle'
import { prepareReply, sendReply, setReplyDeliveryForTest } from '../src/mail-replies'
import { sendAreaMail } from '../src/mailboxes'

const directory = mkdtempSync(join(tmpdir(), 'site-engine-mail-authorizations-'))
process.env.DATABASE_URI = `file:${join(directory, 'cms.sqlite')}`
process.env.PAYLOAD_SECRET = 'test-secret-that-is-long-enough-for-local-mail-authorizations'
const { default: config } = await import('../payload.config.js')
let payload: Payload

beforeAll(async () => { payload = await getPayload({ config }) })
afterAll(async () => { await payload?.destroy(); rmSync(directory, { recursive: true, force: true }) })

type Actor = { id: string; sessionToken: string }
type Draft = { id: string; recipient: string; sender: string; subject: string; body: string; attachmentHashes: string[]; lead: string; revision: number }

async function actor(role: 'owner' | 'sales' | 'hiring'): Promise<Actor> {
  const user = await payload.create({ collection: 'users', data: { email: `${role}-${randomUUID()}@example.test`, name: role, roles: [role] }, overrideAccess: true })
  const sessionToken = newOpaqueToken()
  const now = Date.now()
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(sessionToken), user: user.id, authenticatedAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }, overrideAccess: true })
  return { id: user.id, sessionToken }
}

async function draft(): Promise<Draft> {
  const lead = await payload.create({
    collection: 'inquiries',
    data: { email: `lead-${randomUUID()}@example.test`, message: 'Please send more information about this project.', topic: 'general', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: randomUUID(), stage: 'new' },
    draft: false, overrideAccess: true,
  })
  const created = await payload.create({
    collection: 'mail-drafts',
    data: { lead: lead.id, threadID: randomUUID(), recipient: lead.email, sender: 'team@example.test', subject: 'Project follow-up', body: 'Thank you for your enquiry.', attachmentHashes: ['first-attachment'], revision: 1, state: 'prepared' },
    draft: false, overrideAccess: true,
  })
  return await payload.findByID({ collection: 'mail-drafts', id: created.id, depth: 0, overrideAccess: true }) as Draft
}

const future = () => new Date(Date.now() + 60_000)

describe('local mail authorization transactions', () => {
  it('consumes an accepted delivery once and marks an ambiguous delivery unknown without retry', async () => {
    const owner = await actor('owner'); const prepared = await draft(); await payload.update({ collection: 'mail-drafts', id: prepared.id, data: { attachmentHashes: [] }, overrideAccess: true }); const grant = await authorizeMailDraft(payload, owner, prepared.id, future()); let calls = 0
    setReplyDeliveryForTest(async () => { calls += 1; throw new Error('accepted_then_audit_lost') })
    await expect(sendReply(payload, owner, grant.id)).rejects.toThrow('accepted_then_audit_lost')
    expect(calls).toBe(1)
    expect(await payload.findByID({ collection: 'mail-drafts', id: prepared.id, depth: 0, overrideAccess: true })).toMatchObject({ state: 'delivery-unknown' })
    await expect(sendReply(payload, owner, grant.id)).rejects.toThrow('authorization_not_usable')
    expect(calls).toBe(1); setReplyDeliveryForTest()
  })
  it('dispatches the exact confirmed envelope even when persisted draft content changes during consumption', async () => {
    const owner = await actor('owner'); const prepared = await draft()
    await payload.update({ collection: 'mail-drafts', id: prepared.id, data: { attachmentHashes: [] }, overrideAccess: true })
    const grant = await authorizeMailDraft(payload, owner, prepared.id, future())
    const create = payload.create.bind(payload)
    payload.create = async (args) => {
      const result = await create(args as never)
      if (args.collection === 'audit-events' && (args.data as { event?: string }).event === 'mail.authorization_consumed') {
        await payload.update({ collection: 'mail-drafts', id: prepared.id, data: { body: 'Changed after authorization was consumed.' }, overrideAccess: true, req: args.req })
      }
      return result as never
    }
    let delivered: unknown
    setReplyDeliveryForTest(async (_payload, _area, envelope) => { delivered = envelope; return { provider: 'smtp', messageID: 'synthetic-confirmed-message' } })
    try {
      await sendReply(payload, owner, grant.id)
      expect(delivered).toMatchObject({ body: prepared.body, recipient: prepared.recipient, subject: prepared.subject })
      await expect(authorizeMailDraft(payload, owner, prepared.id, future())).rejects.toThrow('draft_not_prepared')
    } finally { payload.create = create; setReplyDeliveryForTest() }
  })

  it('does not silently omit attachments from an authorized draft', async () => {
    const owner = await actor('owner'); const prepared = await draft()
    const grant = await authorizeMailDraft(payload, owner, prepared.id, future())
    await expect(sendReply(payload, owner, grant.id)).rejects.toThrow('reply_attachments_not_supported')
    expect(await payload.findByID({ collection: 'mail-authorizations', id: grant.id, overrideAccess: true })).toMatchObject({ consumedAt: null })
  })

  it('isolates lead and hiring correspondence by staff role and blocks direct draft writes', async () => {
    const sales = await actor('sales'); const hiring = await actor('hiring'); const owner = await actor('owner')
    const leadDraft = await draft()
    const application = await payload.create({ collection: 'applications', data: { name: 'Synthetic applicant', email: 'applicant@example.test', coverLetter: 'Private hiring correspondence.', consent: true, jobId: randomUUID(), resumeKey: 'test-only', idempotencyKey: randomUUID() }, overrideAccess: true })
    const appDraft = await prepareReply(payload, 'application', application.id, owner.id, { sender: 'team@example.test', subject: 'Private hiring reply', body: 'Private hiring content.' })
    const salesUser = await payload.findByID({ collection: 'users', id: sales.id, overrideAccess: true })
    const hiringUser = await payload.findByID({ collection: 'users', id: hiring.id, overrideAccess: true })
    const salesDrafts = await payload.find({ collection: 'mail-drafts', user: salesUser, overrideAccess: false, limit: 0, pagination: false })
    const hiringDrafts = await payload.find({ collection: 'mail-drafts', user: hiringUser, overrideAccess: false, limit: 0, pagination: false })
    expect(salesDrafts.docs.map(item => item.id)).toContain(leadDraft.id)
    expect(salesDrafts.docs.map(item => item.id)).not.toContain(appDraft.id)
    expect(hiringDrafts.docs.map(item => item.id)).toEqual([appDraft.id])
    await expect(payload.update({ collection: 'mail-drafts', id: leadDraft.id, user: salesUser, overrideAccess: false, data: { body: 'Unreviewed change.' } })).rejects.toMatchObject({ status: 403 })
    await expect(payload.find({ collection: 'mail-authorizations', user: salesUser, overrideAccess: false })).rejects.toMatchObject({ status: 403 })
  })

  it('refuses preparation for a spam lead before persisting a reply', async () => {
    const user = await actor('owner')
    const lead = await payload.create({ collection: 'inquiries', data: { email: `spam-prepare-${randomUUID()}@example.test`, message: 'Spam.', topic: 'general', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: randomUUID(), stage: 'new', spam: true, spamMarkedAt: new Date().toISOString(), spamPreviousStage: 'new' }, overrideAccess: true })
    await expect(prepareReply(payload, 'lead', lead.id, user.id, { sender: 'team@example.test', subject: 'No send', body: 'No send' })).rejects.toThrow('lead_is_spam')
    expect((await payload.find({ collection: 'mail-drafts', where: { lead: { equals: lead.id } }, overrideAccess: true })).totalDocs).toBe(0)
  })
  it('consumes a grant exactly once when two SQLite transactions race', async () => {
    const owner = await actor('owner')
    const prepared = await draft()
    const grant = await authorizeMailDraft(payload, owner, prepared.id, future())
    const authorizedDraft = await payload.findByID({ collection: 'mail-drafts', id: prepared.id, depth: 0, overrideAccess: true })
    expect({ grantRevision: grant.draftRevision, grantDigest: grant.digest, draftRevision: authorizedDraft.revision, digest: authorizationDigest(authorizedDraft as Draft), state: authorizedDraft.state }).toEqual(expect.objectContaining({ grantRevision: 1, draftRevision: 1, state: 'authorized' }))

    const results = await Promise.allSettled([
      consumeMailAuthorization(payload, owner, grant.id),
      consumeMailAuthorization(payload, owner, grant.id),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)

    const persisted = await payload.findByID({ collection: 'mail-authorizations', id: grant.id, depth: 0, overrideAccess: true })
    expect(persisted.consumedAt).toBeTruthy()
    const audits = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mail.authorization_consumed' } }, depth: 0, limit: 0, pagination: false, overrideAccess: true })
    expect(audits.docs.filter((event) => (event.detail as { grant?: string }).grant === grant.id)).toHaveLength(1)
  })

  it.each([
    ['recipient', 'another@example.test'],
    ['body', 'The approved text was edited.'],
    ['threadID', 'different-provider-thread'],
    ['attachmentHashes', ['first-attachment', 'second-attachment']],
  ] as const)('invalidates the grant when its %s changes', async (field, value) => {
    const owner = await actor('owner')
    const prepared = await draft()
    const grant = await authorizeMailDraft(payload, owner, prepared.id, future())
    const changed = await payload.update({ collection: 'mail-drafts', id: prepared.id, data: { [field]: value }, overrideAccess: true }) as Draft

    expect(changed.revision).toBe(prepared.revision + 1)
    expect(authorizationDigest(changed)).not.toBe(grant.digest)
    const invalidated = await payload.findByID({ collection: 'mail-authorizations', id: grant.id, depth: 0, overrideAccess: true })
    expect(invalidated.revokedAt).toBeTruthy()
    await expect(consumeMailAuthorization(payload, owner, grant.id)).rejects.toThrow('authorization_not_usable')
  })

  it('rejects expired and revoked grants without consuming them', async () => {
    const owner = await actor('owner')
    const expiredDraft = await draft()
    const expired = await authorizeMailDraft(payload, owner, expiredDraft.id, future())
    await expect(consumeMailAuthorization(payload, owner, expired.id, new Date('2099-01-01T00:00:00.000Z'))).rejects.toThrow('authorization_not_usable')

    const revokedDraft = await draft()
    const revoked = await authorizeMailDraft(payload, owner, revokedDraft.id, future())
    await revokeMailAuthorization(payload, owner, revoked.id)
    await expect(consumeMailAuthorization(payload, owner, revoked.id)).rejects.toThrow('authorization_not_usable')
    const grants = await Promise.all([expired.id, revoked.id].map((id) => payload.findByID({ collection: 'mail-authorizations', id, depth: 0, overrideAccess: true })))
    expect(grants.map((grant) => grant.consumedAt)).toEqual([null, null])
    expect(await payload.findByID({ collection: 'mail-drafts', id: expiredDraft.id, depth: 0, overrideAccess: true })).toMatchObject({ state: 'expired' })
    expect(await payload.findByID({ collection: 'mail-drafts', id: revokedDraft.id, depth: 0, overrideAccess: true })).toMatchObject({ state: 'canceled' })
  })

  it('rolls back an expiry transition when its mandatory audit cannot persist', async () => {
    const owner = await actor('owner'); const prepared = await draft(); const grant = await authorizeMailDraft(payload, owner, prepared.id, future())
    const create = payload.create.bind(payload)
    payload.create = async (args) => { if (args.collection === 'audit-events' && (args.data as { event?: string }).event === 'mail.authorization_expired') throw new Error('audit unavailable'); return create(args as never) }
    try {
      await expect(consumeMailAuthorization(payload, owner, grant.id, new Date('2099-01-01T00:00:00.000Z'))).rejects.toThrow('audit unavailable')
      expect(await payload.findByID({ collection: 'mail-drafts', id: prepared.id, depth: 0, overrideAccess: true })).toMatchObject({ state: 'authorized' })
    } finally { payload.create = create }
  })

  it('durably cancels a prepared draft without creating a grant', async () => {
    const sales = await actor('sales'); const prepared = await draft()
    await expect(cancelPreparedMailDraft(payload, sales, prepared.id)).resolves.toBeUndefined()
    expect(await payload.findByID({ collection: 'mail-drafts', id: prepared.id, depth: 0, overrideAccess: true })).toMatchObject({ state: 'canceled' })
    await expect(authorizeMailDraft(payload, sales, prepared.id, future())).rejects.toThrow('draft_not_prepared')
    const audits = await payload.find({ collection: 'audit-events', where: { event: { equals: 'mail.draft_cancelled' } }, limit: 0, pagination: false, depth: 0, overrideAccess: true })
    expect(audits.docs.some(item => (item.detail as { draft?: string }).draft === prepared.id)).toBe(true)
  })

  it('allows only a fresh canonical role for the selected draft domain', async () => {
    const owner = await actor('owner'); const sales = await actor('sales'); const hiring = await actor('hiring'); const leadDraft = await draft()
    await expect(authorizeMailDraft(payload, sales, leadDraft.id, future())).resolves.toMatchObject({ authorizedBy: expect.objectContaining({ id: sales.id }) })
    await expect(authorizeMailDraft(payload, hiring, leadDraft.id, future())).rejects.toThrow('mail_authorization_required')
    const application = await payload.create({ collection: 'applications', data: { name: 'Applicant', email: `app-${randomUUID()}@example.test`, coverLetter: 'Private.', consent: true, jobId: randomUUID(), resumeKey: 'test-only', idempotencyKey: randomUUID() }, overrideAccess: true })
    const applicationDraft = await prepareReply(payload, 'application', application.id, owner.id, { sender: 'team@example.test', subject: 'Hiring', body: 'Private hiring reply.' })
    await expect(authorizeMailDraft(payload, sales, applicationDraft.id, future())).rejects.toThrow('mail_authorization_required')
    const hiringGrant = await authorizeMailDraft(payload, hiring, applicationDraft.id, future())
    await payload.update({ collection: 'users', id: hiring.id, data: { roles: ['sales'] }, overrideAccess: true })
    await expect(consumeMailAuthorization(payload, hiring, hiringGrant.id)).rejects.toThrow('mail_authorization_required')
    await payload.update({ collection: 'users', id: sales.id, data: { disabled: true }, overrideAccess: true })
    await expect(consumeMailAuthorization(payload, sales, (await payload.find({ collection: 'mail-authorizations', where: { draft: { equals: leadDraft.id } }, limit: 1, depth: 0, overrideAccess: true })).docs[0]!.id)).rejects.toThrow('mail_authorization_required')
  })

  it('rejects caller role claims and stale authentication against canonical state', async () => {
    const owner = await actor('owner'); const sales = await actor('sales'); const prepared = await draft()
    await expect(authorizeMailDraft(payload, { ...sales, roles: ['owner'] } as unknown as Actor, prepared.id, future())).resolves.toMatchObject({ authorizedBy: expect.objectContaining({ id: sales.id }) })
    const session = await payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(owner.sessionToken) } }, limit: 1, depth: 0, overrideAccess: true })
    await payload.update({ collection: 'auth-sessions', id: session.docs[0]!.id, data: { authenticatedAt: new Date(Date.now() - 16 * 60_000).toISOString() }, overrideAccess: true })
    await expect(authorizeMailDraft(payload, owner, prepared.id, future())).rejects.toThrow('mail_authorization_required')
  })

  it('never lets an old cancelled grant cancel or expire a re-authorized draft', async () => {
    const owner = await actor('owner'); const prepared = await draft()
    const first = await authorizeMailDraft(payload, owner, prepared.id, future())
    await revokeMailAuthorization(payload, owner, first.id)
    await payload.update({ collection: 'mail-drafts', id: prepared.id, data: { body: 'Edited exact envelope.' }, overrideAccess: true })
    const second = await authorizeMailDraft(payload, owner, prepared.id, future())
    await expect(revokeMailAuthorization(payload, owner, first.id)).rejects.toThrow('authorization_not_usable')
    await expect(consumeMailAuthorization(payload, owner, first.id, new Date('2099-01-01T00:00:00.000Z'))).rejects.toThrow('authorization_not_usable')
    expect(await payload.findByID({ collection: 'mail-drafts', id: prepared.id, depth: 0, overrideAccess: true })).toMatchObject({ state: 'authorized' })
    expect(await payload.findByID({ collection: 'mail-authorizations', id: second.id, depth: 0, overrideAccess: true })).toMatchObject({ revokedAt: null, consumedAt: null })
  })

  it('revokes prior grants on spam classification and never revives them on restore', async () => {
    const owner = await actor('owner')
    const prepared = await draft()
    const grant = await authorizeMailDraft(payload, owner, prepared.id, future())
    await classifyLeadAsSpam(payload, prepared.lead, owner.id)
    expect(await payload.findByID({ collection: 'mail-drafts', id: prepared.id, depth: 0, overrideAccess: true })).toMatchObject({ state: 'revoked' })
    expect(await payload.findByID({ collection: 'mail-authorizations', id: grant.id, depth: 0, overrideAccess: true })).toMatchObject({ revokedAt: expect.any(String), consumedAt: null })
    await expect(consumeMailAuthorization(payload, owner, grant.id)).rejects.toThrow('lead_is_spam')
    await expect(authorizeMailDraft(payload, owner, prepared.id, future())).rejects.toThrow('lead_is_spam')
    await restoreLeadFromSpam(payload, prepared.lead, owner.id)
    await expect(consumeMailAuthorization(payload, owner, grant.id)).rejects.toThrow('authorization_not_usable')
  })

  it('rejects creating or rebinding a draft to a spam inquiry', async () => {
    const prepared = await draft()
    const spam = await payload.create({ collection: 'inquiries', data: { email: `spam-${randomUUID()}@example.test`, message: 'Spam.', topic: 'general', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: randomUUID(), stage: 'new', spam: true, spamMarkedAt: new Date().toISOString(), spamPreviousStage: 'new' }, overrideAccess: true })
    await expect(payload.create({ collection: 'mail-drafts', data: { lead: spam.id, threadID: randomUUID(), recipient: spam.email, sender: 'team@example.test', subject: 'Blocked', body: 'Blocked', attachmentHashes: [], revision: 1, state: 'prepared' }, overrideAccess: true })).rejects.toThrow('lead_is_spam')
    await expect(payload.update({ collection: 'mail-drafts', id: prepared.id, data: { lead: spam.id }, overrideAccess: true })).rejects.toThrow('lead_is_spam')
  })

  it('rolls back consumption if its mandatory audit write fails', async () => {
    const owner = await actor('owner')
    const prepared = await draft()
    const grant = await authorizeMailDraft(payload, owner, prepared.id, future())
    const originalCreate = payload.create.bind(payload)
    ;(payload as unknown as { create: typeof payload.create }).create = async (args) => {
      const audit = args as { collection?: string; data?: { event?: string } }
      if (audit.collection === 'audit-events' && audit.data?.event === 'mail.authorization_consumed') throw new Error('mandatory_audit_failure')
      return originalCreate(args as never)
    }
    try {
      await expect(consumeMailAuthorization(payload, owner, grant.id)).rejects.toThrow('mandatory_audit_failure')
    } finally {
      ;(payload as unknown as { create: typeof payload.create }).create = originalCreate
    }
    const persistedGrant = await payload.findByID({ collection: 'mail-authorizations', id: grant.id, depth: 0, overrideAccess: true })
    const persistedDraft = await payload.findByID({ collection: 'mail-drafts', id: prepared.id, depth: 0, overrideAccess: true })
    expect(persistedGrant.consumedAt).toBeNull()
    expect(persistedDraft.state).toBe('authorized')
  })
  it('dispatches an approved Google reply only through its persisted provider thread', async () => {
    Object.assign(process.env, { PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.reply.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64url'), MAILBOX_GOOGLE_CLIENT_ID: 'google-client', MAILBOX_GOOGLE_CLIENT_SECRET: 'google-secret' })
    const { startMailboxOAuth, completeMailboxOAuth } = await import('../src/mailbox-oauth.js')
    const owner = await actor('owner')
    const state = new URL(await startMailboxOAuth(payload, 'google', owner.id, owner.sessionToken)).searchParams.get('state')!
    const mailbox = await completeMailboxOAuth(payload, 'google', state, 'code', owner.id, owner.sessionToken, async (url) => url.includes('/token') ? Response.json({ access_token: 'setup', refresh_token: 'refresh' }) : url.endsWith('/profile') ? Response.json({ emailAddress: 'team@example.test' }) : Response.json({ sendAs: [{ sendAsEmail: 'team@example.test', verificationStatus: 'accepted' }] }))
    const lead = await payload.create({ collection: 'inquiries', data: { email: 'threaded@example.test', message: 'Threaded', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: randomUUID(), stage: 'new' }, overrideAccess: true })
    const thread = await payload.create({ collection: 'mail-threads', data: { lead: lead.id, mailbox: mailbox.id, provider: 'google', providerConversationID: 'google-thread' }, overrideAccess: true })
    await payload.create({ collection: 'mail-thread-messages', data: { thread: thread.id, mailbox: mailbox.id, lead: lead.id, providerMessageID: 'google-message', rfcMessageID: '<google-message@example.test>', rfcReferences: '<root@example.test>', direction: 'inbound', sender: lead.email, recipient: 'team@example.test', subject: 'Reply', body: 'Original', receivedAt: new Date().toISOString(), attachmentMetadata: [] }, overrideAccess: true })
    await (payload as any).create({ collection: 'mailbox-area-mappings', data: { area: 'leads', mailbox: mailbox.id, senderAddress: 'team@example.test' }, overrideAccess: true, context: { mailboxInternal: true } })
    const draft = await prepareReply(payload, 'lead', lead.id, owner.id, { sender: 'team@example.test', subject: 'Reply', body: 'Approved body', threadID: 'google-thread' })
    const grant = await authorizeMailDraft(payload, owner, draft.id, future())
    let sent: any
    setReplyDeliveryForTest((service, area, message) => sendAreaMail(service, area, message, async (url, init) => {
      if (url.includes('/token')) return Response.json({ access_token: 'access' })
      if (url.endsWith('/profile')) return Response.json({ emailAddress: 'team@example.test' })
      if (url.endsWith('/settings/sendAs')) return Response.json({ sendAs: [{ sendAsEmail: 'team@example.test', verificationStatus: 'accepted' }] })
      if (url.endsWith('/messages/send')) { sent = JSON.parse(String(init.body)); return Response.json({ id: 'sent-id', threadId: 'google-thread' }) }
      throw new Error(`unexpected ${url}`)
    }))
    try {
      await expect(sendReply(payload, owner, grant.id)).resolves.toEqual({ provider: 'google', messageID: 'sent-id' })
      expect(sent.threadId).toBe('google-thread')
      expect(Buffer.from(sent.raw, 'base64url').toString()).toContain('To: threaded@example.test\r\nFrom: team@example.test\r\nSubject: Reply')
      expect(Buffer.from(sent.raw, 'base64url').toString()).toContain('In-Reply-To: <google-message@example.test>\r\nReferences: <root@example.test> <google-message@example.test>')
      expect(Buffer.from(sent.raw, 'base64url').toString()).not.toContain('In-Reply-To: google-message')
      expect(await payload.findByID({ collection: 'mail-drafts', id: draft.id, depth: 0, overrideAccess: true })).toMatchObject({ state: 'sent' })
      await expect(sendReply(payload, owner, grant.id)).rejects.toThrow('authorization_not_usable')
    } finally { setReplyDeliveryForTest() }
  })
  it('sends an approved initial Google message and binds only its returned provider thread', async () => {
    Object.assign(process.env, { PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.reply.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64url'), MAILBOX_GOOGLE_CLIENT_ID: 'google-client', MAILBOX_GOOGLE_CLIENT_SECRET: 'google-secret' })
    const { startMailboxOAuth, completeMailboxOAuth } = await import('../src/mailbox-oauth.js')
    const owner = await actor('owner')
    const state = new URL(await startMailboxOAuth(payload, 'google', owner.id, owner.sessionToken)).searchParams.get('state')!
    const mailbox = await completeMailboxOAuth(payload, 'google', state, 'code', owner.id, owner.sessionToken, async (url) => url.includes('/token') ? Response.json({ access_token: 'setup', refresh_token: 'refresh' }) : url.endsWith('/profile') ? Response.json({ emailAddress: 'initial@example.test' }) : Response.json({ sendAs: [{ sendAsEmail: 'initial@example.test', verificationStatus: 'accepted' }] }))
    const lead = await payload.create({ collection: 'inquiries', data: { email: 'initial-recipient@example.test', message: 'Initial', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: randomUUID(), stage: 'new' }, overrideAccess: true })
    const existingMapping = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: 'leads' } }, limit: 1, depth: 0, overrideAccess: true })
    await payload.update({ collection: 'mailbox-area-mappings', id: existingMapping.docs[0].id, data: { mailbox: mailbox.id, senderAddress: 'initial@example.test' }, overrideAccess: true, context: { mailboxInternal: true } })
    const draft = await prepareReply(payload, 'lead', lead.id, owner.id, { sender: 'initial@example.test', subject: 'Initial subject', body: 'Approved initial body' })
    const grant = await authorizeMailDraft(payload, owner, draft.id, future())
    let sent: { raw?: string; threadId?: string } | undefined
    setReplyDeliveryForTest((service, area, message) => sendAreaMail(service, area, message, async (url, init) => {
      if (url.includes('/token')) return Response.json({ access_token: 'access' })
      if (url.endsWith('/profile')) return Response.json({ emailAddress: 'initial@example.test' })
      if (url.endsWith('/settings/sendAs')) return Response.json({ sendAs: [{ sendAsEmail: 'initial@example.test', verificationStatus: 'accepted' }] })
      if (url.endsWith('/messages/send')) { sent = JSON.parse(String(init.body)); return Response.json({ id: 'initial-message', threadId: 'initial-thread' }) }
      throw new Error(`unexpected ${url}`)
    }))
    try {
      await expect(sendReply(payload, owner, grant.id)).resolves.toEqual({ provider: 'google', messageID: 'initial-message', threadID: 'initial-thread' })
      expect(sent?.threadId).toBeUndefined()
      const mime = Buffer.from(sent?.raw ?? '', 'base64url').toString()
      expect(mime).toContain('To: initial-recipient@example.test\r\nFrom: initial@example.test\r\nSubject: Initial subject')
      expect(mime).toContain('Message-ID: <')
      expect(mime).not.toContain('In-Reply-To:')
      const threads = await payload.find({ collection: 'mail-threads', where: { and: [{ lead: { equals: lead.id } }, { mailbox: { equals: mailbox.id } }] }, limit: 10, depth: 0, overrideAccess: true })
      expect(threads.docs).toHaveLength(1)
      expect(threads.docs[0]).toMatchObject({ provider: 'google', providerConversationID: 'initial-thread' })
      const messages = await payload.find({ collection: 'mail-thread-messages', where: { thread: { equals: threads.docs[0].id } }, limit: 10, depth: 0, overrideAccess: true })
      expect(messages.docs).toMatchObject([{ providerMessageID: 'initial-message', direction: 'outbound', sender: 'initial@example.test', recipient: 'initial-recipient@example.test', subject: 'Initial subject', body: 'Approved initial body', rfcMessageID: expect.stringMatching(/^<[^>]+>$/) }])
      await expect(sendReply(payload, owner, grant.id)).rejects.toThrow('authorization_not_usable')
    } finally { setReplyDeliveryForTest() }
  })
  it('binds an initial Microsoft draft with immutable IDs and never retries an ambiguous send', async () => {
    Object.assign(process.env, { PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.reply.test', INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64url'), MAILBOX_MICROSOFT_CLIENT_ID: 'microsoft-client', MAILBOX_MICROSOFT_CLIENT_SECRET: 'microsoft-secret' })
    const { startMailboxOAuth, completeMailboxOAuth } = await import('../src/mailbox-oauth.js')
    const owner = await actor('owner')
    const state = new URL(await startMailboxOAuth(payload, 'microsoft', owner.id, owner.sessionToken)).searchParams.get('state')!
    const mailbox = await completeMailboxOAuth(payload, 'microsoft', state, 'code', owner.id, owner.sessionToken, async (url) => url.includes('/token') ? Response.json({ access_token: 'setup', refresh_token: 'refresh' }) : Response.json({ mail: 'graph-initial@example.test' }))
    const lead = await payload.create({ collection: 'inquiries', data: { email: 'graph-recipient@example.test', message: 'Graph', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: randomUUID(), stage: 'new' }, overrideAccess: true })
    const mapping = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: 'leads' } }, limit: 1, depth: 0, overrideAccess: true })
    await payload.update({ collection: 'mailbox-area-mappings', id: mapping.docs[0].id, data: { mailbox: mailbox.id, senderAddress: 'graph-initial@example.test' }, overrideAccess: true, context: { mailboxInternal: true } })
    const draft = await prepareReply(payload, 'lead', lead.id, owner.id, { sender: 'graph-initial@example.test', subject: 'Graph initial', body: 'Approved Graph body' })
    const grant = await authorizeMailDraft(payload, owner, draft.id, future())
    const calls: Array<{ url: string; init: RequestInit }> = []
    setReplyDeliveryForTest((service, area, message) => sendAreaMail(service, area, message, async (url, init) => {
      calls.push({ url, init })
      if (url.includes('/token')) return Response.json({ access_token: 'access' })
      if (url.includes('/v1.0/me?')) return Response.json({ mail: 'graph-initial@example.test' })
      if (url.endsWith('/v1.0/me/messages')) return Response.json({ id: 'immutable-message', conversationId: 'graph-conversation' })
      if (url.endsWith('/v1.0/me/messages/immutable-message/send')) return new Response(null, { status: 202 })
      throw new Error(`unexpected ${url}`)
    }))
    try {
      await expect(sendReply(payload, owner, grant.id)).resolves.toEqual({ provider: 'microsoft', messageID: 'immutable-message', threadID: 'graph-conversation' })
      const graphCalls = calls.filter(call => call.url.includes('graph.microsoft.com'))
      expect(graphCalls.map(call => call.url)).toEqual(expect.arrayContaining(['https://graph.microsoft.com/v1.0/me/messages', 'https://graph.microsoft.com/v1.0/me/messages/immutable-message/send']))
      expect(graphCalls.every(call => new Headers(call.init.headers).get('prefer') === 'IdType="ImmutableId"')).toBe(true)
      await expect(payload.find({ collection: 'mail-threads', where: { and: [{ lead: { equals: lead.id } }, { providerConversationID: { equals: 'graph-conversation' } }] }, limit: 1, depth: 0, overrideAccess: true })).resolves.toMatchObject({ docs: [expect.objectContaining({ mailbox: mailbox.id })] })
      await expect(sendReply(payload, owner, grant.id)).rejects.toThrow('authorization_not_usable')
    } finally { setReplyDeliveryForTest() }

    const ambiguous = await prepareReply(payload, 'lead', lead.id, owner.id, { sender: 'graph-initial@example.test', subject: 'Ambiguous Graph', body: 'One attempt only' })
    const ambiguousGrant = await authorizeMailDraft(payload, owner, ambiguous.id, future())
    let sends = 0
    setReplyDeliveryForTest((service, area, message) => sendAreaMail(service, area, message, async (url) => {
      if (url.includes('/token')) return Response.json({ access_token: 'access' })
      if (url.includes('/v1.0/me?')) return Response.json({ mail: 'graph-initial@example.test' })
      if (url.endsWith('/v1.0/me/messages')) return Response.json({ id: 'ambiguous-message', conversationId: 'ambiguous-conversation' })
      if (url.endsWith('/v1.0/me/messages/ambiguous-message/send')) { sends += 1; throw new Error('connection dropped after acceptance') }
      throw new Error(`unexpected ${url}`)
    }))
    try {
      await expect(sendReply(payload, owner, ambiguousGrant.id)).rejects.toThrow()
      await expect(sendReply(payload, owner, ambiguousGrant.id)).rejects.toThrow('authorization_not_usable')
      expect(sends).toBe(1)
      await expect(payload.findByID({ collection: 'mail-drafts', id: ambiguous.id, depth: 0, overrideAccess: true })).resolves.toMatchObject({ state: 'delivery-unknown' })
    } finally { setReplyDeliveryForTest() }
  })

})
