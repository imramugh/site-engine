import type { CollectionConfig } from 'payload'

const internal = ({ req }: { req: { context: Record<string, unknown> } }) => req.context.mailboxInternal === true

export const MailboxConfigurations: CollectionConfig = {
  slug: 'mailbox-configurations', admin: { hidden: true },
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  hooks: { beforeChange: [({ req }) => { if (!internal({ req: req as never })) throw new Error('Mailbox configurations use the audited workspace.'); }] },
  fields: [
    { name: 'name', type: 'text', required: true, maxLength: 120 },
    { name: 'provider', type: 'select', required: true, options: ['smtp'] },
    { name: 'primaryAddress', type: 'email', required: true },
    { name: 'aliases', type: 'json', required: true, defaultValue: [] },
    { name: 'host', type: 'text', required: true, maxLength: 253 },
    { name: 'port', type: 'number', required: true, min: 1, max: 65535 },
    { name: 'security', type: 'select', required: true, options: ['starttls', 'tls'] },
    { name: 'username', type: 'text', required: true, maxLength: 320 },
    { name: 'encryptedCredential', type: 'text', access: { read: () => false, create: () => false, update: () => false }, admin: { hidden: true } },
    { name: 'credentialFingerprint', type: 'text', required: true, admin: { readOnly: true } },
    { name: 'health', type: 'select', required: true, defaultValue: 'unknown', options: ['unknown', 'connected', 'rejected', 'unavailable', 'revoked'] },
    { name: 'testedAt', type: 'date' },
  ],
}

export const MailboxAreaMappings: CollectionConfig = {
  slug: 'mailbox-area-mappings', admin: { hidden: true },
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  hooks: { beforeChange: [({ req }) => { if (!internal({ req: req as never })) throw new Error('Mailbox mappings use the audited workspace.'); }] },
  fields: [
    { name: 'area', type: 'select', required: true, unique: true, options: ['leads', 'careers', 'notifications'] },
    { name: 'mailbox', type: 'relationship', relationTo: 'mailbox-configurations', required: true },
    { name: 'senderAddress', type: 'email', required: true },
  ],
}

export const MailboxTestSends: CollectionConfig = {
  slug: 'mailbox-test-sends', admin: { hidden: true },
  access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  hooks: { beforeChange: [({ req }) => { if (!internal({ req: req as never })) throw new Error('Mailbox test sends use the audited workspace.'); }] },
  fields: [
    { name: 'requestKey', type: 'text', required: true, unique: true },
    { name: 'requestHash', type: 'text', required: true },
    { name: 'mailbox', type: 'relationship', relationTo: 'mailbox-configurations', required: true },
    { name: 'senderAddress', type: 'email', required: true },
    { name: 'recipientAddress', type: 'email', required: true },
    { name: 'authorizedBy', type: 'relationship', relationTo: 'users', required: true },
    { name: 'state', type: 'select', required: true, options: ['sending', 'sent', 'failed'] },
    { name: 'providerMessageID', type: 'text', maxLength: 500 },
    { name: 'failureCode', type: 'text', maxLength: 80 },
  ],
}
