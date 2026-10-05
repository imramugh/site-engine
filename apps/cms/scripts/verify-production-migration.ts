import { getPayload } from 'payload'
import config from '../payload.config'

const payload = await getPayload({ config })
const email = `migration-${Date.now()}@example.test`
const created = await payload.create({ collection: 'users', data: { email, name: 'Migration verifier', roles: ['owner'] }, overrideAccess: true })
const read = await payload.findByID({ collection: 'users', id: created.id, overrideAccess: true })
if (read.email !== email) throw new Error('Migrated Payload read/write verification failed.')
const suffix = Date.now().toString(36)
const createSection = (name: string) => payload.create({
  collection: 'sections',
  data: {
    name,
    summary: `Synthetic ${name} section used to verify scoped page slugs after a production migration.`,
    slug: `${name.toLowerCase()}-${suffix}`,
    allowedTemplates: ['standard'],
  },
  user: created,
  overrideAccess: false,
})
const first = await createSection('First')
const second = await createSection('Second')
const pageData = (sectionId: string) => ({
  title: 'Shared root page',
  summary: 'Synthetic root page used to verify scoped page slug constraints after a production migration.',
  slug: `shared-root-${suffix}`,
  sectionId,
  template: 'standard' as const,
})
const firstPage = await payload.create({ collection: 'pages', data: { ...pageData(first.id), noindex: true }, user: created, overrideAccess: false })
if (firstPage._status !== 'draft') throw new Error('Migrated Payload did not preserve normal draft page behavior.')
if (firstPage.noindex !== true || (await payload.findByID({ collection: 'pages', id: firstPage.id, draft: true, overrideAccess: true })).noindex !== true) throw new Error('Migrated Payload did not preserve a noindex page write.')
await payload.create({ collection: 'pages', data: pageData(second.id), user: created, overrideAccess: false })
try {
  await payload.create({ collection: 'pages', data: pageData(first.id), user: created, overrideAccess: false })
  throw new Error('Migrated Payload accepted duplicate root sibling slugs.')
} catch (error) {
  if (error instanceof Error && error.message === 'Migrated Payload accepted duplicate root sibling slugs.') throw error
  const fieldErrors = (error as { data?: { errors?: Array<{ path?: string }> } }).data?.errors
  if (!fieldErrors?.some((field) => field.path === 'slug')) throw error
}
const crawlerPolicy = { searchEngines: false, aiSearchAndAnswers: true, aiModelTraining: false }
const settings = await payload.create({ collection: 'site-settings', data: { siteName: 'Production migration verifier', defaultLocale: 'en', searchEnabled: true, crawlerPolicy }, draft: true, user: created, overrideAccess: false })
const migratedSettings = await payload.findByID({ collection: 'site-settings', id: settings.id, draft: true, overrideAccess: true })
if (settings.searchEnabled !== true || migratedSettings.searchEnabled !== true) throw new Error('Migrated Payload did not preserve a searchEnabled singleton write.')
if (JSON.stringify(migratedSettings.crawlerPolicy) !== JSON.stringify(crawlerPolicy)) throw new Error('Migrated Payload did not preserve a crawler policy singleton write.')
const inquiry = await payload.create({ collection: 'inquiries', data: { email: `lead-${suffix}@example.test`, message: 'Synthetic preserved lead draft migration verification.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: `migration-lead-${suffix}`, stage: 'new' }, overrideAccess: true })
const leadDraft = await payload.create({ collection: 'mail-drafts', data: { lead: inquiry.id, threadID: `lead-${suffix}`, recipient: inquiry.email, sender: created.email, subject: 'Lead migration reply', body: 'Synthetic preserved lead draft.', attachmentHashes: [], revision: 1, state: 'prepared' }, overrideAccess: true, context: { migrationFixture: true } })
const authorization = await payload.create({ collection: 'mail-authorizations', data: { draft: leadDraft.id, digest: 'a'.repeat(64), draftRevision: 1, authorizedBy: created.id, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
const application = await payload.create({ collection: 'applications', data: { name: 'Migration applicant', email: `application-${suffix}@example.test`, coverLetter: 'Synthetic application reply migration verification.', consent: true, jobId: `migration-job-${suffix}`, resumeKey: 'legacy', idempotencyKey: `migration-application-${suffix}` }, overrideAccess: true })
const applicationDraft = await payload.create({ collection: 'mail-drafts', data: { application: application.id, threadID: `application-${suffix}`, recipient: application.email, sender: created.email, subject: 'Application migration reply', body: 'Synthetic application draft.', attachmentHashes: [], revision: 1, state: 'prepared' }, overrideAccess: true, context: { migrationFixture: true } })
await payload.create({ collection: 'retention-settings', data: { key: `migration-${suffix}`, spamDays: 31, mediaBinDays: 32 }, overrideAccess: true })
await payload.create({ collection: 'deletion-tombstones', data: { resourceType: 'inquiry', resourceID: inquiry.id, deletedAt: new Date().toISOString() }, overrideAccess: true })
await payload.create({ collection: 'retention-purge-jobs', data: { resourceType: 'application', resourceID: application.id, state: 'queued', attempts: 0 }, overrideAccess: true })
const [retention, tombstone, job, storedLead, storedAuthorization, storedApplication] = await Promise.all([
  payload.find({ collection: 'retention-settings', where: { key: { equals: `migration-${suffix}` } }, limit: 1, depth: 0, overrideAccess: true }), payload.find({ collection: 'deletion-tombstones', where: { resourceID: { equals: inquiry.id } }, limit: 1, depth: 0, overrideAccess: true }), payload.find({ collection: 'retention-purge-jobs', where: { resourceID: { equals: application.id } }, limit: 1, depth: 0, overrideAccess: true }), payload.findByID({ collection: 'mail-drafts', id: leadDraft.id, depth: 0, overrideAccess: true }), payload.findByID({ collection: 'mail-authorizations', id: authorization.id, depth: 0, overrideAccess: true }), payload.findByID({ collection: 'mail-drafts', id: applicationDraft.id, depth: 0, overrideAccess: true }),
])
if (retention.docs[0]?.spamDays !== 31 || tombstone.docs[0]?.resourceID !== inquiry.id || job.docs[0]?.resourceID !== application.id || storedLead.lead !== inquiry.id || storedAuthorization.draft !== leadDraft.id || storedApplication.application !== application.id) throw new Error('Migrated Payload did not preserve retention or application-reply writes.')
console.info('Migrated Payload read/write verification passed.')

await payload.destroy()
