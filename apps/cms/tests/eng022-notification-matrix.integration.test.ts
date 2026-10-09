import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { getPayload } from 'payload'
import { createAcceptedInquiry, validateInquiry } from '../src/inquiries'
import { transitionChangeSet } from '../src/editorial'
import { withPayloadTransaction } from '../src/auth-transaction'
import { enqueueDueFollowUps } from '../src/follow-up-notifications'
import { configureIntegration, testIntegrationConnection } from '../src/integration-configuration'
import { monitorIntegrationHealth } from '../src/integration-health-monitor'
import { retryPublishJob } from '../src/publishing'
import { dispatchOneNotification } from '../src/notification-dispatch'

const directory = mkdtempSync(join(tmpdir(), 'eng022-notification-matrix-'))
Object.assign(process.env, {
  DATABASE_URI: `file:${join(directory, 'cms.sqlite')}`,
  PAYLOAD_SECRET: 'eng022-notification-matrix-test-secret',
  PAYLOAD_PUBLIC_SERVER_URL: 'https://cms.example.test',
  INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 22).toString('base64url'),
  MAIL_TEST_SMTP_LOOPBACK: '1',
  FOLLOW_UPS_TIMEZONE: 'America/Toronto',
})

const { default: config } = await import('../payload.config.js')
const mailboxes = await import('../src/mailboxes.js')
let payload: Awaited<ReturnType<typeof getPayload>>
let smtp: Server
let port = 0
const messages: string[] = []

beforeAll(async () => {
  payload = await getPayload({ config })
  smtp = createServer((socket) => {
    let buffer = ''; let data = false
    socket.write('220 eng022-loopback ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      while (true) {
        if (data) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          messages.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false; socket.write('250 queued\r\n'); continue
        }
        const end = buffer.indexOf('\r\n'); if (end < 0) return
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (/^EHLO /i.test(line)) socket.write('250-loopback\r\n250 AUTH PLAIN\r\n')
        else if (/^AUTH PLAIN /i.test(line)) socket.write('235 authenticated\r\n')
        else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 accepted\r\n')
        else if (/^DATA$/i.test(line)) { data = true; socket.write('354 continue\r\n') }
        else if (/^QUIT$/i.test(line)) { socket.write('221 bye\r\n'); socket.end() }
        else socket.write('250 ok\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', () => { port = (smtp.address() as { port: number }).port; resolve() }))
})

afterAll(async () => {
  await payload?.destroy()
  await new Promise<void>((resolve) => smtp.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
  for (const key of ['INTEGRATION_CREDENTIAL_ENCRYPTION_KEY', 'MAIL_TEST_SMTP_LOOPBACK', 'FOLLOW_UPS_TIMEZONE']) delete process.env[key]
})

async function deliverAll() {
  for (let attempt = 0; attempt < 30; attempt += 1) if (!await dispatchOneNotification(payload)) return
  throw new Error('Notification queue did not drain')
}

test('ENG-022 persists and safely delivers notification intents from every production event source', async () => {
  const owner = await payload.create({ collection: 'users', data: { name: 'Matrix Owner', email: 'matrix-owner@example.test', roles: ['owner'] }, overrideAccess: true })
  const editor = await payload.create({ collection: 'users', data: { name: 'Matrix Editor', email: 'matrix-editor@example.test', roles: ['editor'] }, overrideAccess: true })
  const sales = await payload.create({ collection: 'users', data: { name: 'Matrix Sales', email: 'matrix-sales@example.test', roles: ['sales'] }, overrideAccess: true })
  const hiring = await payload.create({ collection: 'users', data: { name: 'Matrix Hiring', email: 'matrix-hiring@example.test', roles: ['hiring'] }, overrideAccess: true })
  const approver = await payload.create({ collection: 'users', data: { name: 'Matrix Approver', email: 'matrix-approver@example.test', roles: ['approver'] }, overrideAccess: true })
  const incident = await payload.create({ collection: 'urgent-contacts', data: { name: 'Matrix Incident', email: 'matrix-incident@example.test', mobile: '+14165550199', enabled: true }, overrideAccess: true })
  const mailbox = await mailboxes.configureSMTPMailbox(payload, { name: 'Matrix SMTP', primaryAddress: 'notices@example.test', aliases: [], host: '127.0.0.1', port, security: 'starttls', username: 'matrix-user', password: 'matrix-password' }, owner.id)
  await mailboxes.testSMTPMailbox(payload, mailbox.id, owner.id)
  await mailboxes.setMailboxArea(payload, { area: 'notifications', mailbox: mailbox.id, senderAddress: 'notices@example.test' }, owner.id)
  await payload.create({ collection: 'notification-user-preferences', data: { user: sales.id, mutedKinds: ['new-lead'] }, overrideAccess: true })
  await payload.create({ collection: 'notification-user-preferences', data: { user: owner.id, mutedKinds: ['active-incident-lead'] }, overrideAccess: true })

  const routine = validateInquiry({ email: 'routine-lead@example.test', message: 'Routine inquiry body must not leave the CMS.', topic: 'project', sourcePage: '/contact', consent: true, idempotencyKey: 'eng022-routine-lead-key' }).input!
  const urgent = validateInquiry({ email: 'urgent-lead@example.test', message: 'Urgent inquiry body must not leave the CMS.', topic: 'active-incident', sourcePage: '/contact', consent: true, idempotencyKey: 'eng022-urgent-lead-key' }).input!
  const routineResult = await createAcceptedInquiry(payload, routine)
  const urgentResult = await createAcceptedInquiry(payload, urgent)
  if ('suppressed' in routineResult || 'suppressed' in urgentResult) throw new Error('Fixture inquiry was unexpectedly suppressed')

  const application = await payload.create({ collection: 'applications', data: { name: 'Matrix Applicant', email: 'matrix-applicant@example.test', coverLetter: 'Application private body must not leave the CMS.', consent: true, jobId: '00000000-0000-4000-8000-000000000022', resumeKey: '00000000-0000-4000-8000-000000000024-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', idempotencyKey: '00000000-0000-4000-8000-000000000023' }, overrideAccess: true })
  const section = await payload.create({ collection: 'sections', data: { name: 'Matrix review section', summary: 'A synthetic section used to create a real review notification.', slug: 'matrix-review', allowedTemplates: ['standard'] }, user: editor, overrideAccess: false })
  const set = (await payload.find({ collection: 'change-sets', where: { actor: { equals: editor.id } }, limit: 1, depth: 0, overrideAccess: true })).docs[0]!
  await withPayloadTransaction(payload, req => transitionChangeSet({ payload, req, actor: editor, id: set.id, action: 'submit' }))

  await payload.update({ collection: 'inquiries', id: routineResult.inquiry.id, data: { stage: 'contacted', assignee: sales.id, nextAction: 'Call fixture lead', nextActionDueAt: '2026-10-05T00:00:00.000Z' }, overrideAccess: true })
  await enqueueDueFollowUps(payload, new Date('2026-10-05T12:00:00.000Z'))

  const pricing = { monthlyCapMicroUsd: null, inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, pricingSource: 'https://prices.example.test/eng022', pricingAsOf: '2026-10-05T00:00:00.000Z' }
  await configureIntegration(payload, { provider: 'openrouter', model: 'provider/model', credential: 'matrix-provider-credential', fallbackProvider: null, pricing, actor: owner.id })
  await testIntegrationConnection(payload, { provider: 'openrouter', actor: owner.id, now: new Date('2026-10-05T12:00:00.000Z') }, async () => ({ ok: true, code: 'connected' }))
  expect(await monitorIntegrationHealth(payload, new Date('2026-10-05T12:05:00.000Z'), async ({ provider }) => provider === 'openrouter' ? ({ ok: false, code: 'unavailable' }) : ({ ok: true, code: 'connected' }))).toBeGreaterThanOrEqual(1)

  const publishSet = await payload.create({ collection: 'change-sets', data: { name: 'Matrix publish failure', actor: owner.id, state: 'approved', revision: 1, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: 'a'.repeat(64), changeSet: publishSet.id, reviewRevision: 1, changeHash: 'b'.repeat(64), manifest: {}, themeVersion: '1.0.0', engineVersion: 'test', contractVersion: '1.0.0', approvedBy: owner.id, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
  const publish = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: 'eng022-publish-failure', sequence: 1, snapshot: snapshot.id, changeSet: publishSet.id, reviewRevision: 1, changeHash: 'b'.repeat(64), includedChangeKeys: [], status: 'processing', attempts: 1, leaseToken: 'matrix-publish-lease', leaseExpiresAt: new Date('2026-10-05T14:00:00.000Z').toISOString(), correlationID: 'matrix-publish-correlation' }, overrideAccess: true, context: { editorialInternal: true } })
  await withPayloadTransaction(payload, req => retryPublishJob(payload, req, publish.id, 'matrix-publish-lease', 'PRIVATE_WORKER_ERROR', new Date('2026-10-05T13:30:00.000Z'), 1))

  const outboxes = await payload.find({ collection: 'notification-outbox', limit: 100, pagination: false, depth: 0, overrideAccess: true })
  expect(outboxes.docs.map(item => item.kind)).toEqual(expect.arrayContaining(['new-lead', 'active-incident-lead', 'new-job-application', 'change-set-submitted', 'follow-ups-due', 'publish-or-integration-failed']))
  expect(outboxes.docs.filter(item => item.kind === 'publish-or-integration-failed')).toHaveLength(2)
  const review = outboxes.docs.find(item => item.kind === 'change-set-submitted')!
  expect(review).toMatchObject({ recipientRules: ['approver'], recipients: expect.arrayContaining([expect.objectContaining({ id: approver.id })]) })
  const applicationIntent = outboxes.docs.find(item => item.sourceID === application.id)!
  expect(applicationIntent).toMatchObject({ recipientRules: ['hiring', 'owner'], recipients: expect.arrayContaining([expect.objectContaining({ id: hiring.id }), expect.objectContaining({ id: owner.id })]) })
  const urgentIntent = outboxes.docs.find(item => item.kind === 'active-incident-lead')!
  expect(urgentIntent).toMatchObject({ recipients: expect.arrayContaining([expect.objectContaining({ id: owner.id }), expect.objectContaining({ id: incident.id })]) })

  const before = messages.length
  await deliverAll()
  expect(messages).toHaveLength(before + 10)
  const delivered = messages.slice(before).join('\n')
  for (const sensitive of ['Routine inquiry body must not leave the CMS.', 'Urgent inquiry body must not leave the CMS.', 'Application private body must not leave the CMS.', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'PRIVATE_WORKER_ERROR', 'matrix-provider-credential']) expect(delivered).not.toContain(sensitive)
  expect(delivered).toContain('Open: https://cms.example.test/operations')
  expect(delivered).toContain(`Reference: ${urgentIntent.id}`)
  const salesMessages = messages.slice(before).filter(message => message.includes('To: matrix-sales@example.test'))
  expect(salesMessages).toHaveLength(1)
  expect(salesMessages[0]).toContain('Event: follow-ups-due')
  expect(messages.slice(before).filter(message => message.includes('To: matrix-sales@example.test') && message.includes('Event: new-lead'))).toHaveLength(0)
  expect(messages.slice(before).filter(message => message.includes('To: matrix-owner@example.test') && message.includes('Event: active-incident-lead'))).toHaveLength(1)

  const deliveries = await payload.find({ collection: 'notification-deliveries', limit: 100, pagination: false, depth: 0, overrideAccess: true })
  expect(deliveries.docs.some(item => (item.recipient as { id?: string })?.id === sales.id && item.state === 'failed' && item.failureCode === 'recipient-no-longer-eligible')).toBe(true)
  expect(deliveries.docs.filter(item => (item.recipient as { id?: string })?.id === owner.id && item.state === 'delivered').length).toBeGreaterThan(1)
  expect(deliveries.docs.some(item => (item.recipient as { id?: string })?.id === incident.id && item.state === 'delivered')).toBe(true)
  const audit = await payload.find({ collection: 'audit-events', limit: 500, pagination: false, depth: 0, overrideAccess: true })
  expect(audit.docs.map(item => item.event)).toEqual(expect.arrayContaining(['integration.outage', 'publish.failed', 'editorial.change_set_submit']))
  expect(JSON.stringify(audit.docs)).not.toContain('matrix-provider-credential')
  expect(section.id).toEqual(expect.any(String))
})
