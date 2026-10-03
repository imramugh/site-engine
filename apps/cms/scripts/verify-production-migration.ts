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
const settings = await payload.create({ collection: 'site-settings', data: { siteName: 'Production migration verifier', defaultLocale: 'en', searchEnabled: true }, draft: true, user: created, overrideAccess: false })
if (settings.searchEnabled !== true || (await payload.findByID({ collection: 'site-settings', id: settings.id, draft: true, overrideAccess: true })).searchEnabled !== true) throw new Error('Migrated Payload did not preserve a searchEnabled singleton write.')
console.info('Migrated Payload read/write verification passed.')

await payload.destroy()
