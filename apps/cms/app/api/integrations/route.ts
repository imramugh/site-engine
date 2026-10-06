import { sqliteAuthenticationBoundary } from '../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../payload.config'
import { freshStaff, hasRole } from '../../../src/access'
import { integrationProviders, publicIntegration, type IntegrationProvider } from '../../../src/integrations'
import { serverSessionStrategy, SENSITIVE_REAUTH_SECONDS } from '../../../src/identity'
import { configureIntegration, revokeIntegration, testIntegrationConnection } from '../../../src/integration-configuration'
import { configuredProvider } from '../../../src/oidc'
import { sqliteBackpressureMessage, sqliteBackpressureResponse } from '../../../src/sqlite'

export const dynamic = 'force-dynamic'
const sameOrigin = (request: Request) => {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}
const isProvider = (value: unknown): value is IntegrationProvider => typeof value === 'string' && integrationProviders.includes(value as IntegrationProvider)
const privateJSON = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const failure = () => privateJSON({ error: 'Integration request could not be completed.' }, 400)
const MAX_REQUEST_BYTES = 24 * 1024
const publicIssuer = (issuer: string) => {
  try {
    const value = new URL(issuer)
    if (!['https:', 'http:'].includes(value.protocol)) return null
    value.username = ''; value.password = ''; value.search = ''; value.hash = ''
    return value.href
  } catch { return null }
}
const microsoftTenant = (issuer: string) => {
  try {
    const segments = new URL(issuer).pathname.split('/').filter(Boolean)
    return segments[0] ? decodeURIComponent(segments[0]) : null
  } catch { return null }
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new Error('missing_body')
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_REQUEST_BYTES) throw new Error('body_too_large')
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  const value: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body')
  return value as Record<string, unknown>
}

async function owner(request: Request) {
  const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  return { payload, user: auth.user as { id?: string; roles?: string[] } | null }
}

async function GETHandler(request: Request) {
  const { payload, user } = await owner(request)
  if (!hasRole(user as never, ['owner'])) return privateJSON({ error: 'Owner access required.' }, 403)
  const google = configuredProvider('google')
  const microsoft = configuredProvider('microsoft')
  const microsoftPublicIssuer = microsoft ? publicIssuer(microsoft.issuer) : null
  const [records, aiJobDefaults, googleUsers, microsoftUsers, emergencyOwners, emergencyUses, queued, delivered, failed] = await Promise.all([
    payload.find({ collection: 'integration-configurations', sort: 'provider', limit: 20, depth: 0, overrideAccess: true }),
    payload.find({ collection: 'ai-job-defaults', sort: 'jobType', limit: 20, depth: 0, overrideAccess: true }),
    payload.count({ collection: 'users', where: { provider: { equals: 'google' } }, overrideAccess: true }),
    payload.count({ collection: 'users', where: { provider: { equals: 'microsoft' } }, overrideAccess: true }),
    payload.count({ collection: 'users', where: { emergencyTotpSecret: { exists: true } }, overrideAccess: true }),
    payload.find({ collection: 'audit-events', where: { event: { equals: 'identity.emergency_signed_in' } }, sort: '-createdAt', limit: 1, depth: 0, overrideAccess: true }),
    payload.count({ collection: 'notification-outbox', where: { state: { equals: 'queued' } }, overrideAccess: true }),
    payload.count({ collection: 'notification-outbox', where: { state: { equals: 'delivered' } }, overrideAccess: true }),
    payload.count({ collection: 'notification-outbox', where: { state: { equals: 'failed' } }, overrideAccess: true }),
  ])
  const publicOrigin = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const oauthConfigured = Boolean(process.env.OAUTH_INTERNAL_ORIGIN && process.env.OAUTH_INTROSPECTION_SECRET && publicOrigin)
  return privateJSON({
    integrations: records.docs.map((doc) => publicIntegration(doc as unknown as Record<string, unknown>)),
    aiJobDefaults: aiJobDefaults.docs.map((doc) => ({ jobType: doc.jobType, provider: doc.provider, model: doc.model, fallbackProvider: doc.fallbackProvider ?? null })),
    capabilities: {
      identity: {
        google: { configured: Boolean(google), users: googleUsers.totalDocs, enrollment: 'invited-only', roleAssignment: 'manual' },
        microsoft: { configured: Boolean(microsoft), users: microsoftUsers.totalDocs, enrollment: 'invited-only', roleAssignment: 'manual', issuer: microsoftPublicIssuer, allowedTenant: microsoftPublicIssuer ? microsoftTenant(microsoftPublicIssuer) : null },
        emergencyOwner: { configured: emergencyOwners.totalDocs > 0, users: emergencyOwners.totalDocs, lastUsedAt: emergencyUses.docs[0]?.createdAt ?? null, sensitiveReauthMinutes: SENSITIVE_REAUTH_SECONDS / 60 },
      },
      assistants: { oauthConfigured, endpoint: oauthConfigured ? new URL('/mcp', publicOrigin).href : null },
      // A durable outbox exists, but provider delivery is intentionally a later
      // adapter. Never imply that locally prepared mail can leave the CMS.
      email: { workerConfigured: false },
      notifications: { queued: queued.totalDocs, delivered: delivered.totalDocs, failed: failed.totalDocs },
    },
  })
}

async function POSTHandler(request: Request) {
  if (!sameOrigin(request)) return privateJSON({ error: 'CSRF origin check failed.' }, 403)
  try {
    const { payload, user } = await owner(request)
    if (!user || !(await freshStaff(['owner'])({ req: { payload, user, headers: request.headers } as never }))) return privateJSON({ error: 'Fresh Owner authentication is required.' }, 403)
    const body = await readBody(request)
    if (body.action === 'configure-ai-default') {
      const types = ['summary', 'meta', 'faq', 'alt', 'lead-reply']
      if (typeof body.jobType !== 'string' || !types.includes(body.jobType) || !isProvider(body.provider) || typeof body.model !== 'string' || !body.model.trim() || body.model.length > 160 || (body.fallbackProvider !== null && body.fallbackProvider !== undefined && !isProvider(body.fallbackProvider))) return failure()
      const existing = await payload.find({ collection: 'ai-job-defaults', where: { jobType: { equals: body.jobType } }, limit: 1, depth: 0, overrideAccess: true })
      const data = { jobType: body.jobType, provider: body.provider, model: body.model.trim(), fallbackProvider: body.fallbackProvider ?? null }
      const saved = existing.docs[0] ? await payload.update({ collection: 'ai-job-defaults', id: existing.docs[0].id, data: data as never, overrideAccess: true }) : await payload.create({ collection: 'ai-job-defaults', data: data as never, overrideAccess: true })
      await payload.create({ collection: 'audit-events', data: { event: 'ai.job_default_configured', actor: user.id, detail: data }, overrideAccess: true })
      return privateJSON({ aiJobDefault: { jobType: saved.jobType, provider: saved.provider, model: saved.model, fallbackProvider: saved.fallbackProvider ?? null } })
    }
    if (!isProvider(body.provider)) return failure()
    if (body.action === 'test') {
      const tested = await testIntegrationConnection(payload, { provider: body.provider, actor: user.id })
      return privateJSON({ integration: publicIntegration(tested as unknown as Record<string, unknown>) })
    }
    if (body.action === 'revoke') {
      const revoked = await revokeIntegration(payload, { provider: body.provider, actor: user.id })
      return revoked ? privateJSON({ integration: publicIntegration(revoked as unknown as Record<string, unknown>) }) : failure()
    }
    const money = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    if (body.action !== 'configure' || typeof body.credential !== 'string' || typeof body.model !== 'string' || body.model.length > 160 || (body.fallbackProvider !== null && body.fallbackProvider !== undefined && !isProvider(body.fallbackProvider)) || (body.monthlyCapMicroUsd !== null && body.monthlyCapMicroUsd !== undefined && !money(body.monthlyCapMicroUsd)) || !money(body.inputMicroUsdPerMillionTokens) || !money(body.outputMicroUsdPerMillionTokens) || typeof body.pricingSource !== 'string' || !body.pricingSource.trim() || body.pricingSource.length > 500 || typeof body.pricingAsOf !== 'string' || Number.isNaN(Date.parse(body.pricingAsOf))) return failure()
    const monthlyCapMicroUsd = typeof body.monthlyCapMicroUsd === 'number' ? body.monthlyCapMicroUsd : null
    const result = await configureIntegration(payload, { provider: body.provider, model: body.model, credential: body.credential, fallbackProvider: body.fallbackProvider ?? null, pricing: { monthlyCapMicroUsd, inputMicroUsdPerMillionTokens: body.inputMicroUsdPerMillionTokens, outputMicroUsdPerMillionTokens: body.outputMicroUsdPerMillionTokens, pricingSource: body.pricingSource.trim(), pricingAsOf: new Date(body.pricingAsOf).toISOString() }, actor: user.id })
    return privateJSON({ integration: publicIntegration(result.saved as unknown as Record<string, unknown>) }, result.created ? 201 : 200)
  } catch (error) { return sqliteBackpressureResponse(error, { error: sqliteBackpressureMessage }, { 'Cache-Control': 'no-store' }) ?? failure() }
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
export const POST = sqliteAuthenticationBoundary(POSTHandler)
