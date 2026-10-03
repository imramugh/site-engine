import { getPayload } from 'payload'
import config from '../payload.config'

const payload = await getPayload({ config })
const email = `migration-${Date.now()}@example.test`
const created = await payload.create({ collection: 'users', data: { email, name: 'Migration verifier', roles: ['owner'] }, overrideAccess: true })
const read = await payload.findByID({ collection: 'users', id: created.id, overrideAccess: true })
if (read.email !== email) throw new Error('Migrated Payload read/write verification failed.')
console.info('Migrated Payload read/write verification passed.')

await payload.destroy()
