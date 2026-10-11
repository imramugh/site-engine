import type { CollectionConfig } from 'payload'
const internal = ({ req }: { req: { context: Record<string, unknown> } }) => req.context.mailboxInternal === true
export const MailboxNotifications: CollectionConfig = {
  slug: 'mailbox-notifications', admin: { hidden: true }, access: { create: () => false, read: () => false, update: () => false, delete: () => false },
  hooks: { beforeChange: [({ req }) => { if (!internal({ req: req as never })) throw new Error('Mailbox notifications are internal.') }] },
  fields: [
    { name: 'mailbox', type: 'relationship', relationTo: 'mailbox-configurations', required: true, unique: true }, { name: 'provider', type: 'select', options: ['microsoft', 'google'], required: true },
    { name: 'credentialRevision', type: 'text', required: true, maxLength: 32 }, { name: 'subscriptionID', type: 'text', maxLength: 500 }, { name: 'clientStateHash', type: 'text', maxLength: 64 },
    { name: 'resource', type: 'text', maxLength: 500 }, { name: 'topic', type: 'text', maxLength: 500 }, { name: 'expiresAt', type: 'date' },
    { name: 'status', type: 'select', required: true, options: ['pending', 'active', 'expired', 'revoked', 'failed'] }, { name: 'lastNotificationAt', type: 'date' }, { name: 'lastRenewedAt', type: 'date' }, { name: 'failureCode', type: 'text', maxLength: 80 }, { name: 'replayKey', type: 'text', maxLength: 128 },
  ],
}
