import type { CollectionConfig } from 'payload'
import { randomUUID } from 'node:crypto'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { ChangeSetSchema, PageSchema, RedirectSchema, SectionSchema } from '@site-engine/contract'
import { bootstrapOnly, freshStaff, ownerOrBootstrap, roles, staff } from './access'
import { serverSessionStrategy } from './identity'

const editorialRoles = ['owner', 'approver', 'editor'] as const

const editorialAccess = {
  create: staff(['owner', 'editor']),
  read: staff(editorialRoles),
  update: staff(['owner', 'editor']),
  delete: staff(['owner']),
}

const title = { name: 'title', type: 'text' as const, required: true, maxLength: 180 }

function contractError(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): void {
  if (!result.success) throw new Error(result.error?.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; '))
}

export const Users: CollectionConfig = {
  slug: 'users',
  auth: { disableLocalStrategy: true, strategies: [serverSessionStrategy] },
  admin: { useAsTitle: 'email', group: 'Administration' },
  access: {
    create: bootstrapOnly,
    read: ownerOrBootstrap,
    update: freshStaff(['owner']),
    delete: freshStaff(['owner']),
  },
  hooks: {
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
  access: { create: freshStaff(['owner']), read: staff(['owner']), update: freshStaff(['owner']), delete: freshStaff(['owner']) },
  fields: [
    { name: 'email', type: 'email', required: true, unique: true },
    { name: 'provider', type: 'select', required: true, options: ['google', 'microsoft'] },
    { name: 'providerIssuer', type: 'text', required: true, admin: { description: 'Trusted configured issuer for this invite.' } },
    { name: 'providerSubject', type: 'text', required: true, admin: { description: 'Verified OIDC subject. Email alone never links an identity.' } },
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
  access: editorialAccess,
  hooks: { beforeChange: [({ data, originalDoc }) => {
    data = { ...originalDoc, ...data }
    if (data._status === 'published' || data.status === 'published') throw new Error('Publishing is unavailable until the review workflow is implemented.')
    contractError(PageSchema.safeParse({
      id: data.id ?? originalDoc?.id ?? randomUUID(),
      sectionId: data.sectionId,
      parentId: data.parentId,
      title: data.title,
      summary: data.summary,
      slug: data.slug,
      template: data.template,
      status: 'draft',
      blocks: data.blocks ?? [],
      seoDescription: data.seoDescription,
    }))
    return { ...data, id: data.id ?? originalDoc?.id ?? randomUUID(), status: 'draft', _status: 'draft' }
  }] },
  fields: [
    title,
    {
      name: 'slug', type: 'text', required: true, unique: true,
      validate: (value: unknown) => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
        ? true : 'Use a lowercase URL segment, such as about-us.',
    },
    { name: 'sectionId', type: 'relationship', relationTo: 'sections', required: true, admin: { description: 'Required content section.' } },
    { name: 'parentId', type: 'relationship', relationTo: 'pages', admin: { description: 'Parent page for tree-oriented navigation.' } },
    { name: 'summary', type: 'textarea', required: true, minLength: 24, maxLength: 300, admin: { description: 'Write one or two sentences for listings and editorial context.' } },
    { name: 'template', type: 'select', required: true, defaultValue: 'standard', options: ['landing', 'standard', 'listing', 'pillar', 'service', 'article', 'job'] },
    { name: 'status', type: 'select', defaultValue: 'draft', options: ['draft', 'published', 'archived'], admin: { readOnly: true } },
    { name: 'blocks', type: 'json', defaultValue: [] },
    { name: 'seoDescription', type: 'text', maxLength: 160 },
  ],
}

export const Sections: CollectionConfig = {
  slug: 'sections', admin: { useAsTitle: 'name' }, versions: { drafts: true }, access: editorialAccess,
  hooks: { beforeChange: [({ data, originalDoc }) => {
    data = { ...originalDoc, ...data }
    contractError(SectionSchema.safeParse({ id: data.id ?? originalDoc?.id ?? randomUUID(), name: data.name, slug: data.slug, allowedTemplates: data.allowedTemplates, pageIds: data.pageIds ?? [] }))
    return { ...data, id: data.id ?? originalDoc?.id ?? randomUUID(), _status: 'draft' }
  }] },
  fields: [{ name: 'name', type: 'text', required: true }, { name: 'summary', type: 'textarea', required: true, minLength: 24, maxLength: 300 }, { name: 'slug', type: 'text', required: true, unique: true }, { name: 'allowedTemplates', type: 'select', hasMany: true, required: true, options: ['landing', 'standard', 'listing', 'pillar', 'service', 'article', 'job'] }, { name: 'pageIds', type: 'relationship', relationTo: 'pages', hasMany: true }],
}

export const Assets: CollectionConfig = {
  slug: 'assets', admin: { useAsTitle: 'alt', group: 'Content' }, access: editorialAccess,
  fields: [{ name: 'alt', type: 'text', required: true }, { name: 'caption', type: 'textarea' }, { name: 'private', type: 'checkbox', defaultValue: true }],
}

export const Redirects: CollectionConfig = {
  slug: 'redirects', admin: { useAsTitle: 'from', group: 'Content' }, access: editorialAccess,
  hooks: { beforeChange: [({ data }) => { contractError(RedirectSchema.safeParse({ from: data.from, to: data.to, status: 301 })); return { ...data, status: 301 } }] },
  fields: [{ name: 'from', type: 'text', required: true, unique: true }, { name: 'to', type: 'text', required: true }, { name: 'status', type: 'number', defaultValue: 301, admin: { readOnly: true } }],
}

export const Inquiries: CollectionConfig = {
  slug: 'inquiries', admin: { useAsTitle: 'email', group: 'Private' }, access: { create: () => false, read: staff(['owner', 'sales']), update: staff(['owner', 'sales']), delete: staff(['owner']) },
  fields: [{ name: 'email', type: 'email', required: true }, { name: 'message', type: 'textarea', required: true }, { name: 'status', type: 'select', defaultValue: 'new', options: ['new', 'contacted', 'closed'] }],
}

export const Applications: CollectionConfig = {
  slug: 'applications', admin: { useAsTitle: 'email', group: 'Private' }, access: { create: () => false, read: staff(['owner', 'hiring']), update: staff(['owner', 'hiring']), delete: staff(['owner']) },
  fields: [{ name: 'email', type: 'email', required: true }, { name: 'coverLetter', type: 'textarea', required: true }, { name: 'status', type: 'select', defaultValue: 'new', options: ['new', 'reviewing', 'closed'] }],
}

export const ChangeSets: CollectionConfig = {
  slug: 'change-sets', admin: { useAsTitle: 'name', group: 'Editorial' }, access: editorialAccess,
  hooks: {
    beforeChange: [({ data, originalDoc }) => {
      if (data.state && data.state !== 'draft') throw new Error('Change-set approval is unavailable until the review workflow is implemented.')
      contractError(ChangeSetSchema.safeParse({ id: data.id ?? originalDoc?.id ?? randomUUID(), name: data.name, state: 'draft', revision: data.revision ?? 0 }))
      return { ...data, id: data.id ?? originalDoc?.id ?? randomUUID(), state: 'draft', revision: data.revision ?? 0 }
    }],
  },
  fields: [{ name: 'name', type: 'text', required: true }, { name: 'state', type: 'select', defaultValue: 'draft', options: ['draft', 'inReview', 'approved', 'published'], admin: { readOnly: true } }, { name: 'revision', type: 'number', defaultValue: 0, min: 0, admin: { readOnly: true } }, { name: 'summary', type: 'textarea' }],
}
