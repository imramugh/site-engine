import { ValidationError, type CollectionConfig, type PayloadRequest, type AccessResult } from 'payload'
import { randomUUID } from 'node:crypto'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { ChangeSetSchema, CmsPageFieldConfig, PageSchema, RedirectSchema, SectionSchema, SiteSettingsDraftSchema, StyleGuideSchema, ThemeSelectionSchema } from '@site-engine/contract'
import { bootstrapOnly, freshStaff, hasRole, ownerOrSelfOrBootstrap, roles, staff } from './access'
import { serverSessionStrategy } from './identity'
import { incompatibleBlocks, validatePageTree, validateSectionTemplatePolicy, type FieldIssue, type TreePage, type TreeSection } from './tree/validation'
import { captureChange } from './editorial'
import { canTransitionLead, inquiryTopics, leadStages, validateLeadAssignee, type LeadStage } from './inquiries'
import { normalizedRedirect, validateRedirectSet } from './redirect-lifecycle'
import { loadThemeRegistry, verifyInstalledThemeSelection } from '@site-engine/engine/theme-registry'
import { MEDIA_VARIANTS, assertReferencedAssetsAreAccessible, ensureMediaStorageDirectory, mediaMetadataIssues, mediaStorageDirectory, validateRasterUpload } from './media'
import { mediaFocalContractVersion } from './media-workspace'
import { loadInitialPreviewBaseline } from './review-preview'
import { enqueueNotification } from './notification-settings'
import { preserveApplicationIntake } from './applications'
import { assertLeadAcceptsOutbound } from './lead-outbound'

const editorialRoles = ['owner', 'approver', 'editor'] as const

async function purgePrivateCorrespondence(req: PayloadRequest, target: 'lead' | 'application', id: string) {
  const drafts = await req.payload.find({ collection: 'mail-drafts', where: { [target]: { equals: id } }, pagination: false, limit: 0, depth: 0, overrideAccess: true, req })
  for (const draft of drafts.docs) {
    await req.payload.delete({ collection: 'mail-authorizations', where: { draft: { equals: draft.id } }, overrideAccess: true, req })
    await req.payload.delete({ collection: 'mail-drafts', id: draft.id, overrideAccess: true, req })
  }
  const notificationOutboxes = await req.payload.find({ collection: 'notification-outbox', where: { and: [{ sourceType: { equals: target === 'lead' ? 'inquiry' : 'application' } }, { sourceID: { equals: id } }] }, pagination: false, limit: 0, depth: 0, overrideAccess: true, req })
  for (const outbox of notificationOutboxes.docs) {
    const receipts = await req.payload.find({ collection: 'notification-deliveries', where: { outbox: { equals: outbox.id } }, pagination: false, limit: 0, depth: 0, overrideAccess: true, req })
    if (receipts.docs.some((receipt) => receipt.state === 'processing' && new Date(String(receipt.leaseExpiresAt ?? 0)).getTime() > Date.now())) throw new Error('Notification delivery is actively sending.')
    for (const receipt of receipts.docs) await req.payload.delete({ collection: 'notification-deliveries', id: receipt.id, overrideAccess: true, req })
    await req.payload.delete({ collection: 'notification-outbox', id: outbox.id, overrideAccess: true, req })
  }
  if (target === 'application') {
    const notes = await req.payload.find({ collection: 'audit-events', where: { event: { equals: 'application.note_added' } }, pagination: false, limit: 0, depth: 0, overrideAccess: true, req })
    for (const note of notes.docs) {
      if ((note.detail as { applicationID?: string } | null)?.applicationID === id) {
        // Preserve the event identity and time, removing the private hiring note.
        await req.payload.update({ collection: 'audit-events', id: note.id, data: { detail: { applicationID: id, retentionRedacted: true } }, overrideAccess: true, req })
      }
    }
  }
}


const editorialAccess = {
  create: staff(['owner', 'editor']),
  read: staff(editorialRoles),
  update: staff(['owner', 'editor']),
  // Deletes do not yet have a reversible capture representation. The discard
  // lifecycle uses an internal, transactional delete for newly created drafts;
  // ordinary API deletes stay unavailable until archival is implemented.
  delete: () => false,
}

// Approvers may revise page copy and blocks through the captured draft
// workflow. Broader content structure, media, redirects and administration
// retain their narrower Owner/Editor policies.
const pageEditorialAccess = {
  ...editorialAccess,
  update: staff(editorialRoles),
}

// Page titles follow the shared PageSchema. Other CMS collections define their
// own title fields and do not inherit this page-specific contract boundary.
const pageTitle = {
  name: 'title', type: 'text' as const, required: true,
  minLength: CmsPageFieldConfig.title.minLength,
  maxLength: CmsPageFieldConfig.title.maxLength,
}
// Listings need enough context to be useful. This UI policy is deliberately
// stricter than PageSchema's storage minimum of one non-whitespace character.
const editorialPageSummaryMinLength = 24

function contractError(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }, req?: PayloadRequest, collection?: string): void {
  if (result.success) return
  const errors = result.error?.issues.map(({ path, message }) => ({ path: path.join('.'), message })) ?? []
  if (req && collection) throw new ValidationError({ collection, errors, req })
  throw new Error(errors.map(({ path, message }) => `${path}: ${message}`).join('; '))
}

function fieldErrors(issues: FieldIssue[], req: PayloadRequest, collection: string): void {
  if (issues.length) throw new ValidationError({ collection, errors: issues.map(({ field, message }) => ({ path: field, message })), req })
}

function relationId(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value.id
  return undefined
}

function relationIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(relationId).filter((id): id is string => Boolean(id)) : []
}

function treePage(value: Record<string, unknown>): TreePage {
  return {
    id: String(value.id),
    sectionId: relationId(value.sectionId) ?? '',
    parentId: relationId(value.parentId),
    slug: String(value.slug ?? ''),
    template: value.template as TreePage['template'],
    blocks: (value.blocks ?? []) as TreePage['blocks'],
    title: typeof value.title === 'string' ? value.title : undefined,
  }
}

function treeSection(value: Record<string, unknown>): TreeSection {
  return { id: String(value.id), allowedTemplates: (value.allowedTemplates ?? []) as TreeSection['allowedTemplates'] }
}

export const Users: CollectionConfig = {
  slug: 'users',
  auth: { disableLocalStrategy: true, strategies: [serverSessionStrategy] },
  admin: { useAsTitle: 'email', group: 'Administration' },
  access: {
    create: bootstrapOnly,
    read: ownerOrSelfOrBootstrap,
    update: freshStaff(['owner']),
    delete: freshStaff(['owner']),
  },
  hooks: {
    beforeDelete: [async ({ id, req }) => {
      const target = await req.payload.findByID({ collection: 'users', id, depth: 0, overrideAccess: true, req })
      if (!target.roles?.includes('owner') || target.disabled) return
      const owners = await req.payload.find({ collection: 'users', where: { roles: { contains: 'owner' } }, limit: 200, depth: 0, overrideAccess: true, req })
      if (owners.docs.filter((user) => !user.disabled).length <= 1) throw new ValidationError({ collection: 'users', errors: [{ path: 'roles', message: 'At least one active Owner is required.' }], req })
    }],
    beforeChange: [async ({ data, originalDoc, operation, req }) => {
      if (operation !== 'update' || !originalDoc?.roles?.includes('owner') || originalDoc.disabled) return data
      const proposedRoles = Array.isArray(data.roles) ? data.roles : originalDoc.roles
      const proposedDisabled = data.disabled === undefined ? Boolean(originalDoc.disabled) : Boolean(data.disabled)
      if (!proposedDisabled && proposedRoles.includes('owner')) return data
      const owners = await req.payload.find({ collection: 'users', where: { roles: { contains: 'owner' } }, limit: 200, depth: 0, overrideAccess: true, req })
      if (owners.docs.filter((user) => !user.disabled).length <= 1) throw new ValidationError({ collection: 'users', errors: [{ path: 'roles', message: 'At least one active Owner is required.' }], req })
      return data
    }],
    afterChange: [async ({ doc, previousDoc, operation, req }) => {
      const disabledNow = doc.disabled === true && previousDoc?.disabled !== true
      const rolesChanged = operation === 'update' && JSON.stringify(doc.roles) !== JSON.stringify(previousDoc?.roles)
      if (!disabledNow && !rolesChanged) return doc
      const event = disabledNow ? 'identity.disabled' : 'identity.roles_changed'
      await req.payload.update({ collection: 'auth-sessions', where: { user: { equals: doc.id } }, data: { revokedAt: new Date().toISOString() }, overrideAccess: true, req })
      await req.payload.create({ collection: 'audit-events', data: { event, user: doc.id, actor: req.user?.id }, overrideAccess: true, req })
      return doc
    }],
  },
  fields: [
    { name: 'email', type: 'email', required: true, unique: true },
    { name: 'name', type: 'text', required: true },
    { name: 'roles', type: 'select', hasMany: true, required: true, options: [...roles] },
    { name: 'disabled', type: 'checkbox', defaultValue: false },
    { name: 'invitedAt', type: 'date', admin: { readOnly: true } },
    { name: 'provider', type: 'select', options: ['google', 'microsoft'], admin: { readOnly: true } },
    { name: 'providerIssuer', type: 'text', admin: { readOnly: true } },
    { name: 'providerSubject', type: 'text', admin: { readOnly: true } },
    { name: 'emergencyTotpSecret', access: { read: () => false, update: () => false, create: () => false }, type: 'text', admin: { hidden: true } },
    { name: 'emergencyRecoveryHashes', access: { read: () => false, update: () => false, create: () => false }, type: 'json', admin: { hidden: true } },
    { name: 'emergencyLastCounter', access: { read: () => false, update: () => false, create: () => false }, type: 'number', admin: { hidden: true } },
    { name: 'emergencyFailedAt', access: { read: () => false, update: () => false, create: () => false }, type: 'date', admin: { hidden: true } },
    { name: 'emergencyFailedCount', access: { read: () => false, update: () => false, create: () => false }, type: 'number', defaultValue: 0, admin: { hidden: true } },
  ],
}

export const Invitations: CollectionConfig = {
  slug: 'invitations', admin: { useAsTitle: 'email', group: 'Administration' },
  // The service route is the sole writer: direct collection operations cannot
  // spoof health, credential fingerprints, or audit history.
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  fields: [
    { name: 'email', type: 'email', required: true, unique: true },
    { name: 'provider', type: 'select', required: true, options: ['google', 'microsoft'] },
    { name: 'providerIssuer', type: 'text', required: true, admin: { description: 'Trusted configured issuer for this invite.' } },
    { name: 'providerSubject', type: 'text', required: true, defaultValue: () => `unbound:${randomUUID()}`, admin: { hidden: true, readOnly: true } },
    { name: 'requiredSubject', type: 'text', admin: { description: 'Optional prebound verified OIDC subject. Enrollment always requires the one-time invitation.' } },
    { name: 'tokenHash', type: 'text', required: true, unique: true, admin: { readOnly: true, description: 'Opaque invite credential hash; its original value is never shown in admin.' } },
    { name: 'roles', type: 'select', hasMany: true, required: true, options: [...roles] },
    { name: 'expiresAt', type: 'date', required: true },
    { name: 'acceptedAt', type: 'date', admin: { readOnly: true } },
  ],
}

export const AuthSessions: CollectionConfig = {
  slug: 'auth-sessions', admin: { hidden: true },
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  fields: [
    { name: 'tokenHash', type: 'text', required: true, unique: true },
    { name: 'user', type: 'relationship', relationTo: 'users', required: true },
    { name: 'authenticatedAt', type: 'date', required: true },
    { name: 'lastSeenAt', type: 'date', required: true },
    { name: 'expiresAt', type: 'date', required: true },
    { name: 'revokedAt', type: 'date' },
  ],
}

export const AuthTransactions: CollectionConfig = {
  slug: 'auth-transactions', admin: { hidden: true },
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  fields: [
    { name: 'stateHash', type: 'text', required: true, unique: true },
    { name: 'nonce', type: 'text', required: true },
    { name: 'verifier', type: 'text', required: true },
    { name: 'provider', type: 'select', required: true, options: ['google', 'microsoft'] },
    { name: 'invitation', type: 'relationship', relationTo: 'invitations' },
    { name: 'expiresAt', type: 'date', required: true },
    { name: 'consumedAt', type: 'date' },
  ],
}

export const AuditEvents: CollectionConfig = {
  slug: 'audit-events', admin: { useAsTitle: 'event', group: 'Administration' },
  access: { create: () => false, read: staff(['owner']), update: () => false, delete: () => false },
  fields: [
    { name: 'event', type: 'text', required: true },
    { name: 'user', type: 'relationship', relationTo: 'users' },
    { name: 'actor', type: 'relationship', relationTo: 'users' },
    { name: 'detail', type: 'json' },
  ],
}

export const Pages: CollectionConfig = {
  slug: 'pages',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'slug', 'parent', 'updatedAt'] },
  versions: { drafts: { autosave: true }, maxPerDoc: 50 },
  access: pageEditorialAccess,
  hooks: {
    beforeChange: [async ({ data, originalDoc, req }) => {
    data = { ...originalDoc, ...data }
    const archived = data.status === 'archived' && req.context.archiveInternal
    if (data._status === 'published' || data.status === 'published' || (data.status === 'archived' && !archived)) throw new Error('Publishing is unavailable; archive status changes are only available through the editorial workflow.')
    const id = data.id ?? originalDoc?.id ?? randomUUID()
    contractError(PageSchema.safeParse({
      id,
      sectionId: relationId(data.sectionId),
      parentId: relationId(data.parentId),
      title: data.title,
      summary: data.summary,
      slug: data.slug,
      template: data.template,
      status: archived ? 'archived' : 'draft',
      blocks: data.blocks ?? [],
      kicker: typeof data.kicker === 'string' && data.kicker.trim() ? data.kicker : undefined,
      lede: typeof data.lede === 'string' && data.lede.trim() ? data.lede : undefined,
      seoDescription: typeof data.seoDescription === 'string' && data.seoDescription.trim() ? data.seoDescription : undefined,
      noindex: data.noindex === true,
      publishedAt: data.publishedAt ?? undefined,
      lastReviewed: data.lastReviewed ?? undefined,
      jobPosting: data.jobPosting ?? undefined,
      businessCase: data.businessCase ?? undefined,
    }), req, 'pages')
    const sectionId = relationId(data.sectionId)
    const [sections, pages] = await Promise.all([
      req.payload.find({ collection: 'sections', where: { id: { equals: sectionId } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req }),
      req.payload.find({ collection: 'pages', limit: 0, pagination: false, depth: 0, draft: true, overrideAccess: true, req }),
    ])
    const candidate = treePage({ ...data, id, sectionId, parentId: relationId(data.parentId) })
    await assertReferencedAssetsAreAccessible(req.payload, req, data.blocks ?? [])
    fieldErrors([
      ...incompatibleBlocks(candidate.template, candidate.blocks),
      ...validatePageTree(candidate, pages.docs.map((page) => treePage(page as unknown as Record<string, unknown>)), sections.docs[0] ? treeSection(sections.docs[0] as unknown as Record<string, unknown>) : undefined),
    ], req, 'pages')
      return { ...data, id, status: archived ? 'archived' : 'draft', _status: 'draft' }
    }],
    afterChange: [async ({ doc, previousDoc, operation, req }) => {
      await captureChange({ collection: 'pages', doc: doc as Record<string, unknown>, previousDoc: previousDoc as Record<string, unknown> | undefined, operation, req })
      return doc
    }],
    beforeDelete: [async ({ id, req }) => {
      const children = await req.payload.find({ collection: 'pages', where: { parentId: { equals: id } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req })
      fieldErrors(children.totalDocs ? [{ field: 'parentId', message: 'Move or delete child pages before deleting this page.' }] : [], req, 'pages')
    }],
  },
  fields: [
    pageTitle,
    {
      name: 'slug', type: 'text', required: true,
      validate: (value: unknown) => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
        ? true : 'Use a lowercase URL segment, such as about-us.',
    },
    { name: 'sectionId', type: 'relationship', relationTo: 'sections', required: true, admin: { description: 'Required content section.' } },
    { name: 'parentId', type: 'relationship', relationTo: 'pages', admin: { description: 'Parent page for tree-oriented navigation.' } },
    { name: 'summary', type: 'textarea', required: true, minLength: editorialPageSummaryMinLength, maxLength: CmsPageFieldConfig.summary.maxLength, admin: { description: 'Write one or two sentences for listings and editorial context.' } },
    { name: 'template', type: 'select', required: true, defaultValue: 'standard', options: CmsPageFieldConfig.templateOptions },
    { name: 'status', type: 'select', defaultValue: 'draft', options: ['draft', 'published', 'archived'], admin: { readOnly: true } },
    { name: 'blocks', type: 'json', defaultValue: [] },
    { name: 'kicker', type: 'text', maxLength: 160, admin: { description: 'Short service-page context shown above the page title.' } },
    { name: 'lede', type: 'textarea', maxLength: 500, admin: { description: 'Service-page introduction shown with the page title.' } },
    { name: 'seoDescription', type: 'text', maxLength: 160 },
    { name: 'noindex', type: 'checkbox', defaultValue: false, admin: { description: 'Keep this published page out of search engines and the public site search index.' } },
    { name: 'publishedAt', type: 'date', admin: { description: 'Article publication date.' } },
    { name: 'lastReviewed', type: 'date', admin: { description: 'Date this service or article was last reviewed.' } },
    { name: 'jobPosting', type: 'json', admin: { description: 'Job posting date, employment type, location, and optional closing date.' } },
    { name: 'businessCase', type: 'json', admin: { description: 'Article-only client or anonymized client, industry, challenge, approach, outcome, services, and publication date.' } },
  ],
}

export const Sections: CollectionConfig = {
  slug: 'sections', admin: { useAsTitle: 'name' }, versions: { drafts: true }, access: editorialAccess,
  hooks: {
    beforeChange: [async ({ data, originalDoc, req }) => {
    data = { ...originalDoc, ...data }
    const id = data.id ?? originalDoc?.id ?? randomUUID()
    contractError(SectionSchema.safeParse({ id, name: data.name, summary: data.summary ?? undefined, slug: data.slug ?? '', landingPageId: relationIds(data.landingPageId)[0], allowedTemplates: data.allowedTemplates, pageIds: relationIds(data.pageIds) }), req, 'sections')
    const pages = await req.payload.find({ collection: 'pages', limit: 0, pagination: false, depth: 0, draft: true, overrideAccess: true, req })
    fieldErrors(validateSectionTemplatePolicy(treeSection({ ...data, id }), pages.docs.map((page) => treePage(page as unknown as Record<string, unknown>))), req, 'sections')
      return { ...data, id, _status: 'draft' }
    }],
    afterChange: [async ({ doc, previousDoc, operation, req }) => {
      await captureChange({ collection: 'sections', doc: doc as Record<string, unknown>, previousDoc: previousDoc as Record<string, unknown> | undefined, operation, req })
      return doc
    }],
    beforeDelete: [async ({ id, req }) => {
      const pages = await req.payload.find({ collection: 'pages', where: { sectionId: { equals: id } }, limit: 1, depth: 0, draft: true, overrideAccess: true, req })
      fieldErrors(pages.totalDocs ? [{ field: 'sectionId', message: 'Move or delete pages before deleting this section.' }] : [], req, 'sections')
    }],
  },
  fields: [{ name: 'name', type: 'text', required: true }, { name: 'summary', type: 'textarea', maxLength: 300 }, { name: 'slug', type: 'text', required: true, unique: true, defaultValue: '' }, { name: 'landingPageId', type: 'relationship', relationTo: 'pages' }, { name: 'allowedTemplates', type: 'select', hasMany: true, required: true, options: ['landing', 'standard', 'listing', 'pillar', 'service', 'article', 'job'] }, { name: 'pageIds', type: 'relationship', relationTo: 'pages', hasMany: true }],
}

export const Assets: CollectionConfig = {
  slug: 'assets', admin: { useAsTitle: 'alt', group: 'Content', defaultColumns: ['alt', 'filename', 'updatedAt'] }, access: editorialAccess,
  upload: {
    staticDir: (() => { ensureMediaStorageDirectory(); return mediaStorageDirectory() })(),
    mimeTypes: ['image/avif', 'image/jpeg', 'image/png', 'image/webp'],
    pasteURL: false,
    imageSizes: Object.entries(MEDIA_VARIANTS).map(([name, size]) => ({
      name,
      width: size.width,
      height: size.height,
      fit: 'inside' as const,
      withoutEnlargement: true,
      formatOptions: { format: size.format },
    })),
  },
  hooks: {
    // Payload can remove existing files while generating upload data, before validation.
    // Reject byte-changing operations before that stage to preserve pinned snapshots.
    beforeOperation: [async ({ args, operation, req }) => {
      if (operation !== 'update') return args
      const immutableMessage = 'Upload a new asset to replace image bytes; existing snapshots retain their original files.'
      if (req.file) throw new Error(immutableMessage)
      return args
    }],
    beforeValidate: [async ({ data, originalDoc, req }) => {
      const focalContract = await mediaFocalContractVersion(req.payload, await loadInitialPreviewBaseline(), req)
      const focalValueChanged = (value: unknown, previous: unknown) => value != null && Number(value) !== Number(previous ?? 50)
      const focalChanged = originalDoc
        ? focalValueChanged(data?.focalX, originalDoc.focalX) || focalValueChanged(data?.focalY, originalDoc.focalY)
        : focalValueChanged(data?.focalX, 50) || focalValueChanged(data?.focalY, 50)
      if (focalChanged && !focalContract) throw new Error('Focal-point editing requires an active contract 1.4 theme.')
      req.context.mediaFocalContract = focalContract
      const issues = mediaMetadataIssues(data ?? {})
      if (issues.length) fieldErrors(issues, req, 'assets')
      if (req.file) await validateRasterUpload(req.file)
      return data
    }],
    beforeChange: [async ({ data, originalDoc, req }) => {
      const filePointerChanged = originalDoc
        ? (data.currentFile !== undefined && JSON.stringify(data.currentFile) !== JSON.stringify(originalDoc.currentFile)) || (data.currentFileVersion !== undefined && relationId(data.currentFileVersion) !== relationId(originalDoc.currentFileVersion))
        : data.currentFile != null || data.currentFileVersion != null
      if (!req.context.mediaReplacement && filePointerChanged) throw new Error('Asset file-version pointers are server-owned.')
      const lifecycle = req.context.mediaLifecycle
      const serverTransition = lifecycle === 'bin' || lifecycle === 'restore'
      const directLifecycleWrite = data.restoreFromBin === true || Boolean(originalDoc
        ? (data.deletedAt !== undefined && data.deletedAt !== originalDoc.deletedAt) || (data.deleteAfter !== undefined && data.deleteAfter !== originalDoc.deleteAfter)
        : data.deletedAt || data.deleteAfter)
      if (!serverTransition && directLifecycleWrite) throw new Error('Asset deletion lifecycle fields are server-owned.')
      if (originalDoc?.deletedAt && !serverTransition) throw new Error('Assets in the deletion bin must be restored through the media lifecycle.')
      const next = { ...data }
      delete next.restoreFromBin
      if (serverTransition && lifecycle === 'bin') { if (!next.deletedAt || !next.deleteAfter) throw new Error('Deletion bin timestamps are required.'); }
      if (serverTransition && lifecycle === 'restore') {
        const purged = await req.payload.find({ collection: 'deletion-tombstones', where: { and: [{ resourceType: { equals: 'media' } }, { resourceID: { equals: String(originalDoc?.id) } }] }, limit: 1, depth: 0, overrideAccess: true, req })
        if (purged.docs.length) throw new Error('Permanent media purge has started; this asset cannot be restored.')
        next.deletedAt = null; next.deleteAfter = null
      }
      return next
    }],
    afterChange: [async ({ doc, previousDoc, operation, req }) => {
      await captureChange({ collection: 'assets', doc: doc as Record<string, unknown>, previousDoc: previousDoc as Record<string, unknown> | undefined, operation, req })
      return doc
    }],
  },
  fields: [
    { name: 'alt', type: 'text', required: false, maxLength: 240 },
    { name: 'decorative', type: 'checkbox', defaultValue: false },
    { name: 'caption', type: 'textarea', maxLength: 300 },
    { name: 'credit', type: 'text', maxLength: 240 },
    { name: 'tags', type: 'text', hasMany: true, maxRows: 12 },
    { name: 'focalX', type: 'number', min: 0, max: 100, defaultValue: 50 },
    { name: 'focalY', type: 'number', min: 0, max: 100, defaultValue: 50 },
    { name: 'currentFileVersion', type: 'relationship', relationTo: 'asset-file-versions', admin: { readOnly: true, hidden: true } },
    { name: 'currentFile', type: 'json', admin: { readOnly: true, hidden: true } },
    { name: 'deletedAt', type: 'date', admin: { readOnly: true }, access: { create: () => false, update: () => false } },
    { name: 'deleteAfter', type: 'date', admin: { readOnly: true }, access: { create: () => false, update: () => false } },
  ],
}

export const AssetFileVersions: CollectionConfig = {
  slug: 'asset-file-versions',
  admin: { hidden: true, useAsTitle: 'filename' },
  access: { create: () => false, read: staff(editorialRoles), update: () => false, delete: () => false },
  upload: {
    staticDir: (() => { ensureMediaStorageDirectory(); return mediaStorageDirectory() })(),
    mimeTypes: ['image/avif', 'image/jpeg', 'image/png', 'image/webp'], pasteURL: false,
    imageSizes: Object.entries(MEDIA_VARIANTS).map(([name, size]) => ({ name, width: size.width, height: size.height, fit: 'inside' as const, withoutEnlargement: true, formatOptions: { format: size.format } })),
  },
  hooks: {
    beforeValidate: [async ({ data, req }) => { if (req.file) await validateRasterUpload(req.file); return data }],
    beforeOperation: [async ({ args, operation, req }) => {
      if (operation === 'create' && !req.context.mediaReplacementVersion) throw new Error('Asset file versions are created through the media replacement service.')
      if (operation === 'update' || (operation === 'delete' && req.context.retentionMediaGC !== true)) throw new Error('Asset file versions are immutable.')
      return args
    }],
  },
  fields: [
    { name: 'parentAsset', type: 'relationship', relationTo: 'assets', required: true, index: true },
    { name: 'digest', type: 'text', required: true, index: true },
    { name: 'versionKey', type: 'text', required: true, unique: true },
    { name: 'idempotencyKey', type: 'text', required: true, unique: true },
    { name: 'originalFilename', type: 'text', required: true, maxLength: 240, admin: { readOnly: true } },
  ],
}

export const Redirects: CollectionConfig = {
  slug: 'redirects', admin: { useAsTitle: 'from', group: 'Content' }, access: editorialAccess,
  hooks: {
    beforeChange: [async ({ data, originalDoc, operation, req }) => {
      const redirect = normalizedRedirect({ from: data.from ?? originalDoc?.from, to: data.to ?? originalDoc?.to })
      const existing = await req.payload.find({ collection: 'redirects', limit: 0, pagination: false, depth: 0, overrideAccess: true, req })
      validateRedirectSet([
        ...existing.docs.filter((item) => item.id !== originalDoc?.id).map((item) => ({ from: String(item.from), to: String(item.to), status: 301 })),
        redirect,
      ])
      contractError(RedirectSchema.safeParse(redirect), req, 'redirects')
      const actor = req.user as { id?: unknown; name?: unknown; email?: unknown } | null
      const actorLabel = typeof actor?.name === 'string' && actor.name.trim()
        ? actor.name.trim().slice(0, 160)
        : typeof actor?.email === 'string' && actor.email.trim() ? actor.email.trim().slice(0, 160) : null
      const imported = req.context.reviewedSnapshotImport === true
      const createdBy = operation === 'update' ? originalDoc?.createdBy ?? null : imported || typeof actor?.id !== 'string' ? null : actor.id
      const createdByLabel = operation === 'update' ? originalDoc?.createdByLabel ?? null : imported ? null : actorLabel
      return { ...originalDoc, ...data, ...redirect, status: 301, createdBy, createdByLabel }
    }],
    afterChange: [async ({ doc, previousDoc, operation, req }) => {
      await captureChange({ collection: 'redirects', doc: doc as Record<string, unknown>, previousDoc: previousDoc as Record<string, unknown> | undefined, operation, req })
      return doc
    }],
  },
  fields: [
    { name: 'from', type: 'text', required: true, unique: true },
    { name: 'to', type: 'text', required: true },
    { name: 'status', type: 'number', defaultValue: 301, admin: { readOnly: true } },
    { name: 'createdBy', type: 'relationship', relationTo: 'users', admin: { readOnly: true } },
    { name: 'createdByLabel', type: 'text', maxLength: 160, admin: { readOnly: true } },
    { name: 'hitCount', type: 'number', defaultValue: 0, min: 0, admin: { readOnly: true, description: 'Updated by the edge log ingestion adapter.' } },
    { name: 'lastHitAt', type: 'date', admin: { readOnly: true } },
  ],
}

export const Inquiries: CollectionConfig = {
  slug: 'inquiries',
  admin: { useAsTitle: 'email', group: 'Private', defaultColumns: ['email', 'topic', 'stage', 'urgent', 'assignee', 'nextAction', 'updatedAt'] },
  // Public submissions enter only through the server-owned intake route. This
  // keeps the form entirely outside editorial and ordinary Payload REST create.
  access: { create: () => false, read: staff(['owner', 'sales']), update: staff(['owner', 'sales']), delete: freshStaff(['owner']) },
  hooks: { beforeChange: [async ({ data, originalDoc, operation, req }) => {
    if (operation !== 'update') return data
    if (originalDoc.spam && req.context.leadSpamLifecycle !== true) throw new Error('Restore spam before editing lead details.')
    if (['spam', 'spamMarkedAt', 'spamPreviousStage'].some((field) => data[field] !== undefined && data[field] !== originalDoc[field]) && req.context.leadSpamLifecycle !== true) throw new Error('Spam classification uses the audited lead lifecycle.')
    for (const field of ['email', 'name', 'telephone', 'company', 'message', 'topic', 'sourcePage', 'consentedAt', 'consentBasis', 'idempotencyKey', 'urgent']) {
      if (data[field] !== undefined && data[field] !== originalDoc[field]) throw new Error('Original inquiry and consent evidence cannot be changed.')
    }
    if (req.context.leadSpamLifecycle !== true && data.stage !== undefined && (!leadStages.includes(data.stage) || !canTransitionLead((originalDoc.stage ?? 'new') as LeadStage, data.stage))) throw new Error('That lead-stage transition is not allowed.')
    for (const field of ['notes', 'nextAction']) if (data[field] !== undefined && data[field] !== null && (typeof data[field] !== 'string' || data[field].length > 5_000)) throw new Error(`Invalid ${field}.`)
    if (data.assignee !== undefined && data.assignee !== originalDoc.assignee) data.assignee = await validateLeadAssignee(req.payload, data.assignee)
    return data
  }], beforeDelete: [async ({ id, req }) => {
    if (req.context.leadSpamDeleteLifecycle !== true && req.context.retentionPurge !== true) throw new Error('Lead deletion uses an audited deletion lifecycle.')
    // A deleted lead must not retain queued copies of its personal data or
    // leave required outbox relationships pointing at a removed record.
    await purgePrivateCorrespondence(req, 'lead', String(id))
    await req.payload.delete({ collection: 'notification-outbox', where: { inquiry: { equals: id } }, overrideAccess: true, req })
  }] },
  fields: [
    { name: 'email', type: 'email', required: true },
    { name: 'name', type: 'text' },
    { name: 'telephone', type: 'text' },
    { name: 'company', type: 'text' },
    { name: 'message', type: 'textarea', required: true },
    { name: 'topic', type: 'select', required: true, options: [...inquiryTopics] },
    { name: 'sourcePage', type: 'text', required: true },
    { name: 'consentedAt', type: 'date', required: true, admin: { readOnly: true } },
    { name: 'consentBasis', type: 'select', required: true, options: ['visitor-confirmed', 'staff-recorded', 'unknown'], admin: { readOnly: true } },
    { name: 'idempotencyKey', type: 'text', required: true, unique: true, admin: { readOnly: true } },
    { name: 'stage', type: 'select', defaultValue: 'new', required: true, options: ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'] },
    { name: 'spam', type: 'checkbox', defaultValue: false, admin: { readOnly: true } },
    { name: 'spamMarkedAt', type: 'date', admin: { readOnly: true } },
    { name: 'spamPreviousStage', type: 'select', options: ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'], admin: { readOnly: true } },
    { name: 'urgent', type: 'checkbox', defaultValue: false, admin: { readOnly: true } },
    { name: 'notes', type: 'textarea' },
    { name: 'assignee', type: 'relationship', relationTo: 'users' },
    { name: 'nextAction', type: 'textarea' },
  ],
}

/** Durable intent only: notification providers are deliberately not invoked here. */
export const NotificationOutbox: CollectionConfig = {
  slug: 'notification-outbox', admin: { hidden: true },
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  hooks: { beforeDelete: [async ({ id, req }) => {
    const receipts = await req.payload.find({ collection: 'notification-deliveries', where: { outbox: { equals: id } }, pagination: false, limit: 0, depth: 0, overrideAccess: true, req })
    const now = Date.now()
    // Once a provider attempt is in progress, deleting the parent must wait for
    // its bounded lease to settle. This prevents a retention purge from making
    // an already-claimed event appear deleted while a worker can still send it.
    if (receipts.docs.some((receipt) => receipt.state === 'processing' && new Date(String(receipt.leaseExpiresAt ?? 0)).getTime() > now)) throw new Error('Notification delivery is actively sending.')
    for (const receipt of receipts.docs) await req.payload.delete({ collection: 'notification-deliveries', id: receipt.id, overrideAccess: true, req })
  }] },
  fields: [
    { name: 'inquiry', type: 'relationship', relationTo: 'inquiries' },
    { name: 'kind', type: 'select', required: true, options: ['new-lead', 'active-incident-lead', 'new-job-application', 'change-set-submitted', 'follow-ups-due', 'publish-or-integration-failed'] },
    { name: 'idempotencyKey', type: 'text', required: true, unique: true },
    { name: 'state', type: 'select', required: true, defaultValue: 'queued', options: ['queued', 'delivered', 'failed'] },
    { name: 'payload', type: 'json', required: true },
    { name: 'recipientRules', type: 'json', required: true },
    { name: 'recipients', type: 'json', required: true },
    { name: 'channels', type: 'json', required: true },
    { name: 'sourceType', type: 'text' },
    { name: 'sourceID', type: 'text' },
    { name: 'availableAt', type: 'date', required: true },
  ],
}

/** Per-recipient delivery receipts keep a provider result separate from durable intent. */
export const NotificationDeliveries: CollectionConfig = {
  slug: 'notification-deliveries', admin: { hidden: true },
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  fields: [
    { name: 'outbox', type: 'relationship', relationTo: 'notification-outbox', required: true },
    { name: 'idempotencyKey', type: 'text', required: true, unique: true },
    { name: 'recipient', type: 'json', required: true },
    { name: 'state', type: 'select', required: true, defaultValue: 'queued', options: ['queued', 'processing', 'delivered', 'retryable', 'failed', 'unknown', 'unsupported'] },
    { name: 'attempts', type: 'number', required: true, defaultValue: 0, min: 0 },
    { name: 'nextAttemptAt', type: 'date', required: true },
    { name: 'leaseToken', type: 'text' }, { name: 'leaseExpiresAt', type: 'date' },
    { name: 'providerMessageID', type: 'text' }, { name: 'failureCode', type: 'text' }, { name: 'completedAt', type: 'date' },
  ],
}

/** Private operator settings. These collections never participate in editorial capture or publishing. */
export const NotificationPreferences: CollectionConfig = {
  slug: 'notification-preferences', admin: { hidden: true },
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  fields: [
    { name: 'key', type: 'text', required: true, unique: true },
    { name: 'events', type: 'json', required: true },
    { name: 'updatedBy', type: 'relationship', relationTo: 'users', required: true },
  ],
}

export const UrgentContacts: CollectionConfig = {
  slug: 'urgent-contacts', admin: { hidden: true },
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  fields: [
    { name: 'name', type: 'text', required: true, maxLength: 120 },
    { name: 'email', type: 'email', required: true },
    { name: 'mobile', type: 'text', maxLength: 32 },
    { name: 'enabled', type: 'checkbox', required: true, defaultValue: true },
  ],
}

/** Reply envelopes are written only by the authenticated workflow. */
const readMailDrafts: NonNullable<NonNullable<CollectionConfig['access']>['read']> = ({ req }): AccessResult => {
  if (hasRole(req.user ?? undefined, ['owner'])) return true
  const sales = hasRole(req.user ?? undefined, ['sales']); const hiring = hasRole(req.user ?? undefined, ['hiring'])
  if (sales && hiring) return true
  if (sales) return { lead: { exists: true } }
  if (hiring) return { application: { exists: true } }
  return false
}
export const MailThreads: CollectionConfig = {
  slug: 'mail-threads', admin: { hidden: true, group: 'Private' }, access: { create: () => false, read: ({ req }) => hasRole(req.user as never, ['owner']) ? true : hasRole(req.user as never, ['sales']) ? ({ lead: { exists: true } } as never) : hasRole(req.user as never, ['hiring']) ? ({ application: { exists: true } } as never) : false, update: () => false, delete: () => false },
  fields: [
    { name: 'lead', type: 'relationship', relationTo: 'inquiries' }, { name: 'application', type: 'relationship', relationTo: 'applications' },
    { name: 'mailbox', type: 'relationship', relationTo: 'mailbox-configurations', required: true }, { name: 'provider', type: 'select', required: true, options: ['smtp', 'microsoft', 'google'] },
    { name: 'providerConversationID', type: 'text', required: true, maxLength: 500 },
  ],
  hooks: { beforeChange: [({ data, originalDoc }) => { const lead = relationId(data.lead) ?? relationId(originalDoc?.lead); const application = relationId(data.application) ?? relationId(originalDoc?.application); if (Boolean(lead) === Boolean(application)) throw new Error('A mail thread must belong to one lead or application.'); return data }] },
}

export const MailThreadMessages: CollectionConfig = {
  slug: 'mail-thread-messages', admin: { hidden: true, group: 'Private' }, access: { create: () => false, read: ({ req }) => hasRole(req.user as never, ['owner']) ? true : hasRole(req.user as never, ['sales']) ? ({ lead: { exists: true } } as never) : hasRole(req.user as never, ['hiring']) ? ({ application: { exists: true } } as never) : false, update: () => false, delete: () => false },
  fields: [
    { name: 'thread', type: 'relationship', relationTo: 'mail-threads', required: true }, { name: 'mailbox', type: 'relationship', relationTo: 'mailbox-configurations', required: true },
    { name: 'lead', type: 'relationship', relationTo: 'inquiries' }, { name: 'application', type: 'relationship', relationTo: 'applications' },
    { name: 'providerMessageID', type: 'text', required: true, maxLength: 500 }, { name: 'direction', type: 'select', required: true, options: ['inbound', 'outbound'] },
    { name: 'sender', type: 'text', required: true, maxLength: 320 }, { name: 'recipient', type: 'text', required: true, maxLength: 320 }, { name: 'subject', type: 'text', required: true, maxLength: 500 },
    { name: 'body', type: 'textarea', required: true, maxLength: 20_000 }, { name: 'receivedAt', type: 'date', required: true }, { name: 'attachmentMetadata', type: 'json', defaultValue: [] },
  ],
}

export const MailDrafts: CollectionConfig = {
  slug: 'mail-drafts', admin: { hidden: true, useAsTitle: 'subject', group: 'Private' },
  access: { create: () => false, read: readMailDrafts, update: () => false, delete: () => false },
  fields: [
    { name: 'lead', type: 'relationship', relationTo: 'inquiries' },
    { name: 'application', type: 'relationship', relationTo: 'applications' },
    { name: 'threadID', type: 'text', required: true }, { name: 'recipient', type: 'email', required: true }, { name: 'sender', type: 'email', required: true },
    { name: 'subject', type: 'text', required: true }, { name: 'body', type: 'textarea', required: true }, { name: 'attachmentHashes', type: 'json', defaultValue: [] },
    { name: 'revision', type: 'number', required: true, defaultValue: 1, min: 1 }, { name: 'state', type: 'select', required: true, defaultValue: 'prepared', options: ['prepared', 'authorized', 'revoked', 'expired', 'consumed', 'sent', 'failed', 'delivery-unknown'] },
  ],
  hooks: {
    beforeChange: [async ({ data, originalDoc, operation, req }) => {
      const requestedLead = relationId(data.lead) ?? (operation === 'update' ? relationId(originalDoc?.lead) : undefined)
      const application = relationId(data.application) ?? (operation === 'update' ? relationId(originalDoc?.application) : undefined)
      if (Boolean(requestedLead) === Boolean(application)) throw new Error('A mail draft must belong to one lead or application.')
      if (requestedLead && req.context.leadSpamLifecycle !== true) await assertLeadAcceptsOutbound(req.payload, requestedLead, req)
      if (operation !== 'update' || !originalDoc) return data
      const fields = ['recipient', 'sender', 'subject', 'body', 'attachmentHashes', 'lead', 'application', 'threadID']
      // Payload update input is a patch. An omitted draft-bound field must not
      // be treated as an edit when the authorization service only changes state.
      return fields.some((field) => data[field] !== undefined && JSON.stringify(data[field]) !== JSON.stringify(originalDoc[field])) ? { ...data, revision: Number(originalDoc.revision) + 1, state: 'prepared' } : data
    }],
    afterChange: [async ({ doc, previousDoc, operation, req }) => {
      if (operation !== 'update' || doc.revision === previousDoc?.revision) return
      const grants = await req.payload.find({ collection: 'mail-authorizations', where: { draft: { equals: doc.id } }, depth: 0, overrideAccess: true, req })
      await Promise.all(grants.docs.filter((grant) => !grant.consumedAt && !grant.revokedAt).map((grant) => req.payload.update({ collection: 'mail-authorizations', id: grant.id, data: { revokedAt: new Date().toISOString() }, overrideAccess: true, req })))
    }],
  },
}

/** One immutable, short-lived human authorization per exact draft revision. */
export const MailAuthorizations: CollectionConfig = {
  slug: 'mail-authorizations', admin: { hidden: true }, access: { create: () => false, read: staff(['owner']), update: () => false, delete: () => false },
  fields: [
    { name: 'draft', type: 'relationship', relationTo: 'mail-drafts', required: true }, { name: 'digest', type: 'text', required: true },
    { name: 'draftRevision', type: 'number', required: true }, { name: 'authorizedBy', type: 'relationship', relationTo: 'users', required: true },
    { name: 'expiresAt', type: 'date', required: true }, { name: 'revokedAt', type: 'date' }, { name: 'consumedAt', type: 'date' },
  ],
}

export const Applications: CollectionConfig = {
  slug: 'applications', admin: { useAsTitle: 'email', group: 'Private' }, access: { create: () => false, read: staff(['owner', 'hiring']), update: staff(['owner', 'hiring']), delete: staff(['owner']) },
  hooks: {
    beforeDelete: [async ({ req, id }) => { if (req.context.retentionPurge !== true) throw new Error('Applications are permanently deleted through the audited retention lifecycle.'); await purgePrivateCorrespondence(req, 'application', String(id)) }],
    beforeChange: [({ data, originalDoc, operation }) => operation === 'update' && originalDoc ? preserveApplicationIntake(data, originalDoc) : data],
    afterChange: [async ({ doc, operation, req }) => {
      if (operation === 'create') await enqueueNotification(req.payload, req, { kind: 'new-job-application', idempotencyKey: `new-job-application:${doc.idempotencyKey}`, sourceType: 'application', sourceID: doc.id, payload: { application: doc.id, job: doc.jobId } })
      return doc
    }],
  },
  fields: [{ name: 'name', type: 'text', required: true }, { name: 'email', type: 'email', required: true }, { name: 'telephone', type: 'text', maxLength: 48 }, { name: 'linkedIn', type: 'text', maxLength: 500 }, { name: 'coverLetter', type: 'textarea', required: true }, { name: 'consent', type: 'checkbox', required: true }, { name: 'jobId', type: 'text', required: true }, { name: 'resumeKey', type: 'text', required: true }, { name: 'idempotencyKey', type: 'text', required: true, unique: true, admin: { hidden: true } }, { name: 'status', type: 'select', defaultValue: 'new', options: ['new', 'reviewing', 'interview', 'offer', 'hired', 'declined', 'closed'] }],
}

/** Owner-controlled policy. The defaults are encoded in code so a missing row is safe. */
export const RetentionSettings: CollectionConfig = {
  slug: 'retention-settings', admin: { useAsTitle: 'key', group: 'Administration', hidden: true },
  access: { create: () => false, read: staff(['owner']), update: () => false, delete: () => false },
  fields: [
    { name: 'key', type: 'text', required: true, unique: true, defaultValue: 'default', admin: { readOnly: true } },
    { name: 'spamDays', type: 'number', required: true, defaultValue: 30, min: 1, max: 365 },
    { name: 'mediaBinDays', type: 'number', required: true, defaultValue: 30, min: 1, max: 365 },
  ],
}

/** Deliberately minimal replay ledger for restored backups; never store personal content or object keys here. */
export const DeletionTombstones: CollectionConfig = {
  slug: 'deletion-tombstones', admin: { hidden: true }, access: { create: () => false, read: staff(['owner']), update: () => false, delete: () => false },
  fields: [{ name: 'resourceType', type: 'select', required: true, options: ['application', 'inquiry', 'media'] }, { name: 'resourceID', type: 'text', required: true }, { name: 'deletedAt', type: 'date', required: true }],
}

/** Operator-visible retry state. The resume key is cleared as soon as storage deletion succeeds. */
export const RetentionPurgeJobs: CollectionConfig = {
  slug: 'retention-purge-jobs', admin: { useAsTitle: 'resourceID', group: 'Administration' }, access: { create: () => false, read: staff(['owner']), update: () => false, delete: () => false },
  fields: [
    { name: 'resourceType', type: 'select', required: true, options: ['spam-inquiry', 'application', 'media'] }, { name: 'resourceID', type: 'text', required: true },
    { name: 'state', type: 'select', required: true, options: ['queued', 'failed', 'completed'], defaultValue: 'queued' }, { name: 'attempts', type: 'number', required: true, defaultValue: 0, min: 0 },
    { name: 'lastError', type: 'text' }, { name: 'resumeKey', type: 'text', access: { read: () => false }, admin: { hidden: true } }, { name: 'completedAt', type: 'date' },
  ],
}

export const ChangeSets: CollectionConfig = {
  slug: 'change-sets', admin: { useAsTitle: 'name', group: 'Editorial' },
  access: { create: () => false, read: staff(editorialRoles), update: () => false, delete: () => false },
  hooks: {
    beforeChange: [async ({ data, originalDoc, req }) => {
      if (!req.context.editorialInternal) throw new ValidationError({ collection: 'change-sets', errors: [{ path: 'state', message: 'Change sets are changed through the editorial workflow.' }], req })
      contractError(ChangeSetSchema.safeParse({ id: data.id ?? originalDoc?.id ?? randomUUID(), name: data.name ?? originalDoc?.name, state: data.state ?? originalDoc?.state ?? 'open', revision: data.revision ?? originalDoc?.revision ?? 0 }), req, 'change-sets')
      const creationRequestKey = originalDoc?.creationRequestKey ?? data.creationRequestKey
      const creationRequestHash = originalDoc?.creationRequestHash ?? data.creationRequestHash
      if (Boolean(creationRequestKey) !== Boolean(creationRequestHash)) throw new ValidationError({ collection: 'change-sets', errors: [{ path: 'creationRequestKey', message: 'Page creation receipts require both the request key and request hash.' }], req })
      return { ...originalDoc, ...data, id: data.id ?? originalDoc?.id ?? randomUUID(), creationRequestKey, creationRequestHash }
    }],
  },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'actor', type: 'relationship', relationTo: 'users', admin: { readOnly: true } },
    { name: 'state', type: 'select', defaultValue: 'open', options: ['open', 'submitted', 'changes-requested', 'approved', 'rejected', 'published', 'discarded', 'stale'], admin: { readOnly: true } },
    { name: 'revision', type: 'number', defaultValue: 0, min: 0, admin: { readOnly: true } },
    { name: 'changes', type: 'json', defaultValue: [], admin: { readOnly: true, description: 'Field-level before and after images captured from draft saves.' } },
    { name: 'quality', type: 'json', admin: { readOnly: true } },
    { name: 'preview', type: 'json', admin: { readOnly: true } },
    { name: 'reviewComments', type: 'json', defaultValue: [], admin: { readOnly: true } },
    { name: 'submittedAt', type: 'date', admin: { readOnly: true } },
    { name: 'reviewedAt', type: 'date', admin: { readOnly: true } },
    { name: 'staleAt', type: 'date', admin: { readOnly: true } },
    { name: 'creationRequestKey', type: 'text', unique: true, admin: { hidden: true, readOnly: true } },
    { name: 'creationRequestHash', type: 'text', admin: { hidden: true, readOnly: true } },
    { name: 'summary', type: 'textarea' },
  ],
}

/** Immutable release inputs. A worker never receives draft collections directly. */
export const PublishSnapshots: CollectionConfig = {
  slug: 'publish-snapshots', admin: { useAsTitle: 'contentHash', group: 'Editorial' },
  access: { create: () => false, read: staff(editorialRoles), update: () => false, delete: () => false },
  fields: [
    // Content identity is deliberately not a version identity: two approved
    // revisions may render the same manifest and must remain independently
    // auditable/releasable.
    { name: 'contentHash', type: 'text', required: true },
    { name: 'changeSet', type: 'relationship', relationTo: 'change-sets', required: true, admin: { readOnly: true } },
    { name: 'reviewRevision', type: 'number', required: true, admin: { readOnly: true } },
    { name: 'changeHash', type: 'text', required: true, admin: { readOnly: true } },
    { name: 'manifest', type: 'json', required: true, admin: { readOnly: true } },
    { name: 'themeVersion', type: 'text', required: true, admin: { readOnly: true } },
    { name: 'engineVersion', type: 'text', required: true, admin: { readOnly: true } },
    { name: 'contractVersion', type: 'text', required: true, admin: { readOnly: true } },
    { name: 'approvedBy', type: 'relationship', relationTo: 'users', required: true, admin: { readOnly: true } },
    { name: 'baselineSnapshot', type: 'relationship', relationTo: 'publish-snapshots', admin: { readOnly: true } },
    { name: 'baselineSequence', type: 'number', required: true, defaultValue: 0, min: 0, admin: { readOnly: true } },
  ],
}

/** Durable work descriptor. Network delivery is deliberately outside its transaction. */
export const PublishOutbox: CollectionConfig = {
  slug: 'publish-outbox', admin: { useAsTitle: 'idempotencyKey', group: 'Editorial' },
  access: { create: () => false, read: staff(['owner', 'approver']), update: () => false, delete: () => false },
  fields: [
    { name: 'idempotencyKey', type: 'text', required: true, unique: true, admin: { readOnly: true } },
    { name: 'sequence', type: 'number', required: true, unique: true, min: 1, admin: { readOnly: true } },
    { name: 'snapshot', type: 'relationship', relationTo: 'publish-snapshots', required: true, admin: { readOnly: true } },
    { name: 'changeSet', type: 'relationship', relationTo: 'change-sets', required: true, admin: { readOnly: true } },
    { name: 'reviewRevision', type: 'number', required: true, admin: { readOnly: true } },
    { name: 'changeHash', type: 'text', required: true, admin: { readOnly: true } },
    { name: 'includedChangeKeys', type: 'json', required: true, admin: { readOnly: true } },
    { name: 'status', type: 'select', required: true, defaultValue: 'pending', options: ['pending', 'processing', 'failed', 'completed'], admin: { readOnly: true } },
    { name: 'attempts', type: 'number', required: true, defaultValue: 0, min: 0, admin: { readOnly: true } },
    { name: 'nextAttemptAt', type: 'date', admin: { readOnly: true } },
    { name: 'claimedAt', type: 'date', admin: { readOnly: true } },
    { name: 'leaseToken', type: 'text', admin: { readOnly: true } },
    { name: 'leaseExpiresAt', type: 'date', admin: { readOnly: true } },
    { name: 'completedAt', type: 'date', admin: { readOnly: true } },
    { name: 'completionEvidence', type: 'json', admin: { readOnly: true } },
    { name: 'errorCode', type: 'text', admin: { readOnly: true } },
    { name: 'correlationID', type: 'text', required: true, admin: { readOnly: true } },
    { name: 'lastError', type: 'textarea', admin: { readOnly: true } },
  ],
}

export const ScheduledPublications: CollectionConfig = {
  slug: 'scheduled-publications', admin: { useAsTitle: 'scheduledFor', group: 'Editorial' },
  access: { create: () => false, read: staff(['owner', 'approver']), update: () => false, delete: () => false },
  fields: [
    { name: 'idempotencyKey', type: 'text', required: true, unique: true, admin: { readOnly: true } },
    { name: 'snapshot', type: 'relationship', relationTo: 'publish-snapshots', required: true, unique: true, admin: { readOnly: true } },
    { name: 'changeSet', type: 'relationship', relationTo: 'change-sets', required: true, admin: { readOnly: true } },
    { name: 'scheduledFor', type: 'date', required: true, admin: { readOnly: true } },
    { name: 'state', type: 'select', required: true, defaultValue: 'scheduled', options: ['scheduled', 'cancelled', 'stale', 'enqueued'], admin: { readOnly: true } },
    { name: 'outbox', type: 'relationship', relationTo: 'publish-outbox', unique: true, admin: { readOnly: true } },
    { name: 'enqueuedAt', type: 'date', admin: { readOnly: true } },
    { name: 'dispatchReason', type: 'text', admin: { readOnly: true } },
    { name: 'proof', type: 'json', required: true, admin: { readOnly: true } },
  ],
}

/** Immutable, private renderer input. The worker never reads draft collections. */
export const PreviewRenderJobs: CollectionConfig = {
  slug: 'preview-render-jobs', admin: { useAsTitle: 'id', group: 'Editorial' },
  access: { create: () => false, read: staff(['owner', 'approver']), update: () => false, delete: () => false },
  fields: [
    { name: 'changeSet', type: 'relationship', relationTo: 'change-sets', required: true, admin: { readOnly: true } },
    { name: 'reviewRevision', type: 'number', required: true, admin: { readOnly: true } },
    { name: 'changeHash', type: 'text', required: true, admin: { readOnly: true } },
    { name: 'includedChangeKeys', type: 'json', required: true, admin: { readOnly: true } },
    { name: 'baselineSnapshot', type: 'relationship', relationTo: 'publish-snapshots', admin: { readOnly: true } },
    { name: 'baselineSequence', type: 'number', required: true, defaultValue: 0, min: 0, admin: { readOnly: true } },
    { name: 'liveSnapshot', type: 'relationship', relationTo: 'publish-snapshots', admin: { readOnly: true } },
    { name: 'liveSequence', type: 'number', required: true, defaultValue: 0, min: 0, admin: { readOnly: true } },
    { name: 'liveManifest', type: 'json', required: true, admin: { readOnly: true } },
    { name: 'proposedManifest', type: 'json', required: true, admin: { readOnly: true } },
    { name: 'liveManifestHash', type: 'text', required: true, admin: { readOnly: true } },
    { name: 'proposedManifestHash', type: 'text', required: true, admin: { readOnly: true } },
    { name: 'versionPins', type: 'json', required: true, admin: { readOnly: true } },
    { name: 'status', type: 'select', required: true, defaultValue: 'pending', options: ['pending', 'processing', 'failed', 'completed'], admin: { readOnly: true } },
    { name: 'attempts', type: 'number', required: true, defaultValue: 0, min: 0, admin: { readOnly: true } },
    { name: 'nextAttemptAt', type: 'date', admin: { readOnly: true } },
    { name: 'leaseToken', type: 'text', admin: { readOnly: true } },
    { name: 'leaseExpiresAt', type: 'date', admin: { readOnly: true } },
    { name: 'completedAt', type: 'date', admin: { readOnly: true } },
    { name: 'artifactDigest', type: 'text', admin: { readOnly: true } },
    { name: 'errorCode', type: 'text', admin: { readOnly: true } },
  ],
}

/** The authoritative pointer to content verified as public. Snapshots stay immutable. */
export const PublishedReleases: CollectionConfig = {
  slug: 'published-releases', admin: { useAsTitle: 'snapshot', group: 'Editorial' },
  access: { create: () => false, read: staff(editorialRoles), update: () => false, delete: () => false },
  fields: [
    { name: 'outbox', type: 'relationship', relationTo: 'publish-outbox', required: true, unique: true, admin: { readOnly: true } },
    { name: 'sequence', type: 'number', required: true, unique: true, min: 1, admin: { readOnly: true } },
    { name: 'snapshot', type: 'relationship', relationTo: 'publish-snapshots', required: true, admin: { readOnly: true } },
    { name: 'activatedAt', type: 'date', required: true, admin: { readOnly: true } },
    { name: 'healthEvidence', type: 'json', required: true, admin: { readOnly: true } },
    { name: 'artifact', type: 'json', required: true, admin: { readOnly: true } },
  ],
}

export const ThemeSettings: CollectionConfig = {
  slug: 'theme-settings', admin: { useAsTitle: 'key', group: 'Editorial' },
  access: { create: staff(['owner']), read: staff(editorialRoles), update: staff(['owner']), delete: () => false },
  hooks: {
    beforeChange: [async ({ data, originalDoc, operation, req }) => {
      if (operation === 'update' && originalDoc && data.key !== undefined && data.key !== originalDoc.key) throw new Error('Theme settings key is immutable.')
      const selection = data.selection ?? originalDoc?.selection
      contractError(ThemeSelectionSchema.safeParse(selection), req, 'theme-settings')
      verifyInstalledThemeSelection(selection, await loadThemeRegistry())
      return { ...originalDoc, ...data, key: originalDoc?.key ?? 'active' }
    }],
    afterChange: [async ({ doc, previousDoc, operation, req }) => { await captureChange({ collection: 'theme-settings', doc: doc as Record<string, unknown>, previousDoc: previousDoc as Record<string, unknown> | undefined, operation, req }); return doc }],
  },
  fields: [{ name: 'key', type: 'text', required: true, unique: true, defaultValue: 'active' }, { name: 'selection', type: 'json', required: true }, { name: 'settings', type: 'json', defaultValue: {} }],
}

/** Credential envelopes are private operational state, never editorial content. */
export const IntegrationConfigurations: CollectionConfig = {
  slug: 'integration-configurations', admin: { hidden: true },
  // Credentials and their operational metadata move only through the audited
  // integration route. Payload's generic REST and Admin CRUD must not bypass it.
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  fields: [
    { name: 'provider', type: 'select', required: true, unique: true, options: ['openai', 'anthropic', 'google-gemini', 'openrouter'] },
    { name: 'model', type: 'text', required: true, maxLength: 160 },
    { name: 'fallbackProvider', type: 'select', options: ['openai', 'anthropic', 'google-gemini', 'openrouter'] },
    { name: 'monthlyCapMicroUsd', type: 'number', min: 0, max: Number.MAX_SAFE_INTEGER },
    { name: 'monthlyUsageMicroUsd', type: 'number', min: 0, defaultValue: 0, admin: { readOnly: true } },
    { name: 'usageMonth', type: 'text', maxLength: 7, admin: { readOnly: true } },
    // Rates are manually reviewed and pinned to this configured provider/model.
    // A job fails closed when this evidence is absent; it never fetches live prices.
    { name: 'inputMicroUsdPerMillionTokens', type: 'number', min: 0, max: Number.MAX_SAFE_INTEGER },
    { name: 'outputMicroUsdPerMillionTokens', type: 'number', min: 0, max: Number.MAX_SAFE_INTEGER },
    { name: 'pricingSource', type: 'text', maxLength: 500 },
    { name: 'pricingAsOf', type: 'date' },
    { name: 'encryptedCredential', type: 'text', access: { read: () => false, create: () => false, update: () => false }, admin: { hidden: true } },
    { name: 'credentialFingerprint', type: 'text', admin: { readOnly: true } },
    { name: 'health', type: 'select', required: true, defaultValue: 'unknown', options: ['unknown', 'connected', 'unavailable', 'rejected', 'revoked'], admin: { readOnly: true } },
    { name: 'testedAt', type: 'date', admin: { readOnly: true } },
  ],
}

/** Immutable, private per-request provider cost reservations. */
export const ProviderUsageReservations: CollectionConfig = {
  slug: "provider-usage-reservations",
  admin: { hidden: true },
  access: {
    create: () => false,
    read: () => false,
    update: () => false,
    delete: () => false,
  },
  hooks: {
    beforeChange: [
      ({ data, originalDoc, operation, req }) => {
        if (!req.context.providerUsageLifecycle)
          throw new ValidationError({
            collection: "provider-usage-reservations",
            errors: [
              {
                path: "",
                message: "Provider usage reservations are managed internally.",
              },
            ],
            req,
          });
        if (operation === "update" && originalDoc)
          return {
            ...data,
            configuration: originalDoc.configuration,
            executionKey: originalDoc.executionKey,
            usageMonth: originalDoc.usageMonth,
            reservedMicroUsd: originalDoc.reservedMicroUsd,
            configModel: originalDoc.configModel,
            credentialFingerprint: originalDoc.credentialFingerprint,
            inputMicroUsdPerMillionTokens:
              originalDoc.inputMicroUsdPerMillionTokens,
            outputMicroUsdPerMillionTokens:
              originalDoc.outputMicroUsdPerMillionTokens,
            pricingSource: originalDoc.pricingSource,
            pricingAsOf: originalDoc.pricingAsOf,
            requestInputTokens: originalDoc.requestInputTokens,
            maxOutputTokens: originalDoc.maxOutputTokens,
          };
        return data;
      },
    ],
  },
  fields: [
    {
      name: "configuration",
      type: "relationship",
      relationTo: "integration-configurations",
      required: true,
      admin: { readOnly: true },
    },
    {
      name: "executionKey",
      type: "text",
      required: true,
      unique: true,
      maxLength: 36,
      admin: { readOnly: true },
    },
    {
      name: "usageMonth",
      type: "text",
      required: true,
      maxLength: 7,
      admin: { readOnly: true },
    },
    {
      name: "reservedMicroUsd",
      type: "number",
      required: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      admin: { readOnly: true },
    },
    {
      name: "settledMicroUsd",
      type: "number",
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      admin: { readOnly: true },
    },
    {
      name: "state",
      type: "select",
      required: true,
      options: ["reserved", "settled", "released"],
      admin: { readOnly: true },
    },
    {
      name: "configModel",
      type: "text",
      required: true,
      maxLength: 160,
      admin: { readOnly: true },
    },
    { name: "credentialFingerprint", type: "text", admin: { readOnly: true } },
    {
      name: "inputMicroUsdPerMillionTokens",
      type: "number",
      required: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      admin: { readOnly: true },
    },
    {
      name: "outputMicroUsdPerMillionTokens",
      type: "number",
      required: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      admin: { readOnly: true },
    },
    {
      name: "pricingSource",
      type: "text",
      required: true,
      maxLength: 500,
      admin: { readOnly: true },
    },
    {
      name: "pricingAsOf",
      type: "date",
      required: true,
      admin: { readOnly: true },
    },
    {
      name: "requestInputTokens",
      type: "number",
      required: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      admin: { readOnly: true },
    },
    {
      name: "maxOutputTokens",
      type: "number",
      required: true,
      min: 1,
      max: 8192,
      admin: { readOnly: true },
    },
  ],
};

/** Owner-proposed site identity and default metadata. The frozen snapshot keeps
 * sections and operator contract version outside this editable singleton. */
export const SiteSettings: CollectionConfig = {
  slug: 'site-settings', admin: { useAsTitle: 'key', group: 'Editorial' },
  access: { create: staff(['owner']), read: staff(editorialRoles), update: staff(['owner']), delete: () => false },
  hooks: {
    beforeChange: [async ({ data, originalDoc, operation, req }) => {
      if (operation === 'update' && originalDoc && data.key !== undefined && data.key !== originalDoc.key) throw new Error('Site settings key is immutable.')
      // Payload supplies persisted nullable values on an update. Treat only a
      // non-null value as an attempted operator-only edit.
      if ((data.contractVersion !== undefined && data.contractVersion !== null) || data.sections !== undefined || data.theme !== undefined || data.themeSettings !== undefined) throw new Error('Contract, sections, and theme settings are not editable through site settings.')
      const editable = { ...originalDoc, ...data }
      for (const key of ['id', 'key', 'createdAt', 'updatedAt', '_status', 'contractVersion']) delete editable[key]
      const address = editable.address as Record<string, unknown> | undefined
      const clearAddress = Boolean(data.address && typeof data.address === 'object' && ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode'].every(field => !(data.address as Record<string, unknown>)[field]))
      if (address && ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode'].every(field => !address[field])) delete editable.address
      const incident = editable.incident as Record<string, unknown> | undefined
      const clearIncident = Boolean(data.incident && typeof data.incident === 'object' && !(data.incident as Record<string, unknown>).label && !(data.incident as Record<string, unknown>).guidance)
      if (incident && !incident.label && !incident.guidance) delete editable.incident
      const clearLogos = Boolean(data.logos && typeof data.logos === 'object' && Object.values(data.logos as Record<string, unknown>).every(value => !value))
      if (clearLogos) delete editable.logos
      const parsed = SiteSettingsDraftSchema.safeParse(editable)
      contractError(parsed, req, 'site-settings')
      if (parsed.success) {
        for (const id of [parsed.data.logo, ...Object.values(parsed.data.logos ?? {})]) {
          if (typeof id !== 'string') continue
          const asset = await req.payload.findByID({ collection: 'assets', id, depth: 0, overrideAccess: true, req })
          if (asset.deletedAt) throw new Error('Restore an asset from the media bin before using it in site settings.')
        }
      }
      if (parsed.success && parsed.data.navigation) {
        const references = [...parsed.data.navigation.header, ...parsed.data.navigation.footer.columns.flatMap(column => 'links' in column ? column.links : []), ...(parsed.data.navigation.footer.bottomLinks ?? [])]
        for (const reference of references) {
          if (reference.kind === 'unavailable') continue
          try { await req.payload.findByID({ collection: reference.kind === 'page' ? 'pages' : 'sections', id: reference.id, depth: 0, overrideAccess: true, req }) }
          catch { throw new Error(`Site navigation references an unavailable ${reference.kind}.`) }
        }
        for (const column of parsed.data.navigation.footer.columns) {
          if (column.kind !== 'section-pillars') continue
          try { await req.payload.findByID({ collection: 'sections', id: column.sectionId, depth: 0, overrideAccess: true, req }) }
          catch { throw new Error('Generated site navigation references an unavailable section.') }
        }
      }
      return {
        ...parsed.data,
        ...(clearAddress ? { address: { streetAddress: null, addressLocality: null, addressRegion: null, postalCode: null, addressCountry: null } } : {}),
        ...(clearIncident ? { incident: { label: null, guidance: null } } : {}),
        ...(clearLogos ? { logos: { primaryLight: null, primaryDark: null, fullLockupLight: null, fullLockupDark: null, symbolLight: null, symbolDark: null } } : {}),
        key: originalDoc?.key ?? 'active',
      }
    }],
    afterChange: [async ({ doc, previousDoc, operation, req }) => { await captureChange({ collection: 'site-settings', doc: doc as Record<string, unknown>, previousDoc: previousDoc as Record<string, unknown> | undefined, operation, req }); return doc }],
  },
  fields: [
    { name: 'key', type: 'text', required: true, unique: true, defaultValue: 'active', admin: { readOnly: true } },
    { name: 'siteName', type: 'text', required: true, maxLength: 100, admin: { description: 'Public site name.' } },
    { name: 'legalName', type: 'text', maxLength: 160 },
    { name: 'homepageId', type: 'relationship', relationTo: 'pages', admin: { description: 'Published landing page to use as the homepage.' } },
    { name: 'defaultLocale', type: 'select', required: true, options: ['en', 'en-CA'] },
    { name: 'organizationType', type: 'select', options: ['organization', 'professional-service'] },
    { name: 'logo', type: 'relationship', relationTo: 'assets' },
    { name: 'logos', type: 'group', fields: [
      { name: 'primaryLight', type: 'relationship', relationTo: 'assets' }, { name: 'primaryDark', type: 'relationship', relationTo: 'assets' },
      { name: 'fullLockupLight', type: 'relationship', relationTo: 'assets' }, { name: 'fullLockupDark', type: 'relationship', relationTo: 'assets' },
      { name: 'symbolLight', type: 'relationship', relationTo: 'assets' }, { name: 'symbolDark', type: 'relationship', relationTo: 'assets' },
    ] },
    { name: 'contactEmail', type: 'email' }, { name: 'contactPhone', type: 'text', maxLength: 40 }, { name: 'seoDescription', type: 'text', maxLength: 160 },
    { name: 'address', type: 'group', fields: [
      { name: 'streetAddress', type: 'text', maxLength: 240 }, { name: 'addressLocality', type: 'text', maxLength: 100 },
      { name: 'addressRegion', type: 'text', maxLength: 100 }, { name: 'postalCode', type: 'text', maxLength: 24 },
      { name: 'addressCountry', type: 'text', maxLength: 2, defaultValue: 'CA' },
    ] },
    { name: 'linkedIn', type: 'text', maxLength: 300 },
    { name: 'incident', type: 'group', fields: [{ name: 'label', type: 'text', maxLength: 80 }, { name: 'guidance', type: 'textarea', maxLength: 1000 }] },
    { name: 'navigation', type: 'json', admin: { description: 'Validated ordered header and footer references.' } },
    { name: 'searchEnabled', type: 'checkbox', defaultValue: false, admin: { description: 'Expose the static public search page and include it in the primary navigation after this change is reviewed and published.' } },
    { name: 'crawlerPolicy', type: 'json', admin: { description: 'Reviewed robots.txt requests. These preferences do not enforce access.' } },
    { name: 'contractVersion', type: 'text', admin: { readOnly: true, hidden: true } },
  ],
}

/** Owner-reviewed private style settings. They join a change set and become
 * effective only in its frozen reviewed snapshot. */
export const StyleGuides: CollectionConfig = {
  slug: 'style-guides', admin: { useAsTitle: 'key', group: 'Editorial' },
  access: { create: staff(['owner']), read: staff(editorialRoles), update: staff(['owner']), delete: () => false },
  hooks: {
    beforeChange: [async ({ data, originalDoc, operation, req }) => {
      if (operation === 'update' && originalDoc && data.key !== undefined && data.key !== originalDoc.key) throw new Error('Style guide key is immutable.')
      const editable = { ...originalDoc, ...data }
      for (const key of ['id', 'key', 'createdAt', 'updatedAt', '_status']) delete editable[key]
      contractError(StyleGuideSchema.safeParse(editable), req, 'style-guides')
      return { ...originalDoc, ...data, key: originalDoc?.key ?? 'active' }
    }],
    afterChange: [async ({ doc, previousDoc, operation, req }) => { await captureChange({ collection: 'style-guides', doc: doc as Record<string, unknown>, previousDoc: previousDoc as Record<string, unknown> | undefined, operation, req }); return doc }],
  },
  fields: [
    { name: 'key', type: 'text', required: true, unique: true, defaultValue: 'active', admin: { readOnly: true } },
    { name: 'bannedPhrases', type: 'json', defaultValue: [] }, { name: 'preferredTerms', type: 'json', defaultValue: [] },
    { name: 'canadianSpelling', type: 'select', required: true, defaultValue: 'off', options: ['off', 'warn'] },
    { name: 'maximumSentenceWords', type: 'number', required: true, defaultValue: 30, min: 5, max: 100 },
    { name: 'minimumReadingEase', type: 'number', required: true, defaultValue: 30, min: 0, max: 121 },
  ],
}

/** Private durable AI execution intent. It is only reachable through the Owner route and worker lifecycle. */
export const ConfiguredAIJobs: CollectionConfig = {
  slug: 'configured-ai-jobs', admin: { hidden: true },
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  hooks: { beforeChange: [({ data, originalDoc, operation }) => {
    if (operation === 'update' && originalDoc) {
      for (const field of ['actor', 'idempotencyKey', 'requestDigest', 'input', 'provider', 'fallbackProvider', 'maxOutputTokens', 'configurationSnapshot']) data[field] = originalDoc[field]
    }
    return data
  }] },
  fields: [
    { name: 'actor', type: 'relationship', relationTo: 'users', required: true, admin: { readOnly: true } },
    { name: 'idempotencyKey', type: 'text', required: true, unique: true, maxLength: 128, admin: { readOnly: true } },
    { name: 'requestDigest', type: 'text', required: true, maxLength: 64, admin: { readOnly: true } },
    { name: 'input', type: 'textarea', required: true, maxLength: 100000, access: { read: () => false }, admin: { hidden: true } },
    { name: 'provider', type: 'select', required: true, options: ['openai', 'anthropic', 'google-gemini', 'openrouter'], admin: { readOnly: true } },
    { name: 'fallbackProvider', type: 'select', options: ['openai', 'anthropic', 'google-gemini', 'openrouter'], admin: { readOnly: true } },
    { name: 'maxOutputTokens', type: 'number', required: true, min: 1, max: 8192, admin: { readOnly: true } },
    { name: 'configurationSnapshot', type: 'json', required: true, admin: { readOnly: true } },
    { name: 'state', type: 'select', required: true, options: ['queued', 'running', 'completed', 'manual-review', 'failed'], defaultValue: 'queued', admin: { readOnly: true } },
    { name: 'leaseToken', type: 'text', admin: { hidden: true } }, { name: 'leaseExpiresAt', type: 'date', admin: { readOnly: true } },
    { name: 'dispatchStartedAt', type: 'date', admin: { readOnly: true } }, { name: 'result', type: 'textarea', access: { read: () => false }, admin: { hidden: true } },
    { name: 'resultDigest', type: 'text', maxLength: 64, admin: { readOnly: true } }, { name: 'costStatus', type: 'select', options: ['actual', 'reserved'], admin: { readOnly: true } },
    { name: 'usedProvider', type: 'select', options: ['openai', 'anthropic', 'google-gemini', 'openrouter'], admin: { readOnly: true } }, { name: 'fallbackUsed', type: 'checkbox', defaultValue: false, admin: { readOnly: true } },
    { name: 'failureCode', type: 'text', maxLength: 64, admin: { readOnly: true } },
  ],
}
