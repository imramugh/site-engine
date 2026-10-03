import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig } from 'payload'
import { Assets, Applications, ChangeSets, Inquiries, Pages, Redirects, Sections, Users } from './src/collections'
import { databaseURI } from './src/sqlite'

const secret = process.env.PAYLOAD_SECRET
const isProductionBuild = process.env.NEXT_PHASE === 'phase-production-build'
if (process.env.NODE_ENV === 'production' && !isProductionBuild && !secret) {
  throw new Error('PAYLOAD_SECRET is required in production')
}

export default buildConfig({
  admin: { user: Users.slug, importMap: { baseDir: process.cwd() } },
  collections: [Users, Pages, Sections, Assets, Redirects, Inquiries, Applications, ChangeSets],
  db: sqliteAdapter({
    client: { url: databaseURI() },
    idType: 'uuid',
    allowIDOnCreate: true,
    wal: true,
    busyTimeout: 5000,
    push: process.env.NODE_ENV !== 'production',
  }),
  editor: undefined,
  graphQL: { disable: false },
  onInit: async (payload) => {
    // foreign_keys is connection-local. This is Payload's own adapter client.
    await (payload.db as unknown as { client: { execute: (sql: string) => Promise<unknown> } }).client.execute('PRAGMA foreign_keys = ON')
  },
  secret: secret || (isProductionBuild ? 'build-time-placeholder-not-for-runtime' : 'development-only-secret-change-before-deployment'),
  typescript: { outputFile: new URL('./payload-types.ts', import.meta.url).pathname },
})
