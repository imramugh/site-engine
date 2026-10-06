import { getPayload } from 'payload'
import config from '../payload.config'

const payload = await getPayload({ config })
const user = await payload.create({ collection: 'users', data: { email: `mcp-migration-${Date.now()}@example.test`, name: 'Migration probe', roles: ['owner'] }, overrideAccess: true })
const lead = await payload.create({ collection: 'inquiries', data: { email: `lead-${Date.now()}@example.test`, message: 'Migration probe lead.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: crypto.randomUUID(), stage: 'new' }, overrideAccess: true })
const session = await payload.create({ collection: 'auth-sessions', data: { tokenHash: crypto.randomUUID(), user: user.id, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
const draft = await payload.create({ collection: 'mail-drafts', data: { lead: lead.id, threadID: crypto.randomUUID(), recipient: lead.email, sender: 'site@example.test', subject: 'Migration probe', body: 'Body', attachmentHashes: [], revision: 1, state: 'prepared', assistantClientIDHash: 'a'.repeat(64), assistantActor: user.id, assistantOAuthSessionID: session.id }, overrideAccess: true })
const grant = await payload.create({ collection: 'mail-authorizations', data: { draft: draft.id, digest: 'b'.repeat(64), draftRevision: 1, authorizedBy: user.id, humanConfirmationSessionID: session.id, assistantClientIDHash: 'a'.repeat(64), assistantActor: user.id, assistantOAuthSessionID: session.id, expiresAt: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true })
if (!draft.assistantClientIDHash || !grant.humanConfirmationSessionID || !grant.assistantClientIDHash) throw new Error('MCP mail confirmation columns unavailable')
console.log('MCP mail confirmation production CRUD')
