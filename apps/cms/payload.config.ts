import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig } from 'payload'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { AssetFileVersions, Assets, Applications, AuditEvents, AuthSessions, AuthTransactions, ChangeSets, ConfiguredAIJobs, Inquiries, IntegrationConfigurations, ProviderUsageReservations, MailAuthorizations, MailDrafts, NotificationOutbox, NotificationPreferences, UrgentContacts, Invitations, Pages, PreviewRenderJobs, PublishedReleases, PublishOutbox, PublishSnapshots, Redirects, ScheduledPublications, Sections, SiteSettings, StyleGuides, ThemeSettings, Users } from './src/collections'
import { databaseURI } from './src/sqlite'
import { MailboxAreaMappings, MailboxConfigurations, MailboxTestSends } from './src/mailbox-collections'

const secret = process.env.PAYLOAD_SECRET
const migrationDir = resolve(dirname(fileURLToPath(import.meta.url)), 'src/migrations')
const isProductionBuild = process.env.NEXT_PHASE === 'phase-production-build'
if (process.env.NODE_ENV === 'production' && !isProductionBuild && !secret) {
  throw new Error('PAYLOAD_SECRET is required in production')
}

export default buildConfig({
  admin: {
    avatar: 'default',
    user: Users.slug,
    components: {
      Nav: './app/components/admin-navigation#AdminNavigation',
      graphics: { Icon: './app/components/admin-topbar#AdminBrandLogo', Logo: './app/components/admin-topbar#AdminBrandLogo' },
      views: { dashboard: { Component: './app/components/admin-dashboard#AdminDashboard' } },
    },
    importMap: { baseDir: dirname(fileURLToPath(import.meta.url)), importMapFile: new URL('./app/(payload)/admin/importMap.js', import.meta.url).pathname },
  },
  collections: [Users, Invitations, AuthSessions, AuthTransactions, AuditEvents, Pages, Sections, Assets, AssetFileVersions, Redirects, ThemeSettings, SiteSettings, StyleGuides, IntegrationConfigurations, ProviderUsageReservations, MailboxConfigurations, MailboxAreaMappings, MailboxTestSends, Inquiries, NotificationOutbox, NotificationPreferences, UrgentContacts, MailDrafts, MailAuthorizations, Applications, ChangeSets, ConfiguredAIJobs, PublishSnapshots, PublishOutbox, ScheduledPublications, PreviewRenderJobs, PublishedReleases],
  db: sqliteAdapter({
    client: { url: databaseURI() },
    // The Payload CLI otherwise resolves migrations from the caller's cwd. Keep
    // this absolute so `pnpm migrate` and the standalone deployment agree.
    migrationDir,
    idType: 'uuid',
    allowIDOnCreate: true,
    wal: true,
    busyTimeout: 5000,
    transactionOptions: { behavior: 'immediate' },
    push: process.env.NODE_ENV !== 'production',
  }),
  editor: undefined,
  graphQL: { disable: false },
  sharp,
  onInit: async (payload) => {
    // foreign_keys is connection-local. This is Payload's own adapter client.
    await (payload.db as unknown as { client: { execute: (sql: string) => Promise<unknown> } }).client.execute('PRAGMA foreign_keys = ON')
  },
  secret: secret || (isProductionBuild ? 'build-time-placeholder-not-for-runtime' : 'development-only-secret-change-before-deployment'),
  typescript: { outputFile: new URL('./payload-types.ts', import.meta.url).pathname },
})
