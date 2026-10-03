import { getPayload } from 'payload'
import config from '../../../payload.config'
import { freshStaff, hasRole } from '../../../src/access'
import { credentialFingerprint, encryptCredential, integrationProviders, publicIntegration, testConnection, type IntegrationProvider } from '../../../src/integrations'
import { serverSessionStrategy } from '../../../src/identity'

export const dynamic = 'force-dynamic'
const sameOrigin = (request: Request) => {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}
const isProvider = (value: unknown): value is IntegrationProvider => typeof value === 'string' && integrationProviders.includes(value as IntegrationProvider)
const failure = () => Response.json({ error: 'Integration request could not be completed.' }, { status: 400 })

async function owner(request: Request) {
  const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  return { payload, user: auth.user as { id?: string; roles?: string[] } | null }
}

export async function GET(request: Request) {
  const { payload, user } = await owner(request)
  if (!hasRole(user as never, ['owner'])) return Response.json({ error: 'Owner access required.' }, { status: 403 })
  const records = await payload.find({ collection: 'integration-configurations', sort: 'provider', limit: 20, depth: 0, overrideAccess: true })
  return Response.json({ integrations: records.docs.map((doc) => publicIntegration(doc as unknown as Record<string, unknown>)) }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  try {
    const { payload, user } = await owner(request)
    if (!user || !(await freshStaff(['owner'])({ req: { payload, user, headers: request.headers } as never }))) return Response.json({ error: 'Fresh Owner authentication is required.' }, { status: 403 })
    const body = await request.json() as Record<string, unknown>
    if (!isProvider(body.provider)) return failure()
    const existing = await payload.find({ collection: 'integration-configurations', where: { provider: { equals: body.provider } }, limit: 1, depth: 0, overrideAccess: true })
    const record = existing.docs[0] as unknown as Record<string, unknown> | undefined
    if (body.action === 'revoke') {
      if (!record) return failure()
      await payload.update({ collection: 'integration-configurations', id: String(record.id), data: { encryptedCredential: null, credentialFingerprint: null, health: 'revoked', testedAt: new Date().toISOString() }, overrideAccess: true })
      await payload.create({ collection: 'audit-events', data: { event: 'integration.credential_revoked', actor: user.id, detail: { provider: body.provider } }, overrideAccess: true })
      return Response.json({ integration: publicIntegration({ ...record, encryptedCredential: null, credentialFingerprint: null, health: 'revoked' }) })
    }
    if (body.action !== 'configure' || typeof body.credential !== 'string' || typeof body.model !== 'string' || body.model.length > 160 || (body.fallbackProvider !== null && body.fallbackProvider !== undefined && !isProvider(body.fallbackProvider)) || (body.monthlyCap !== null && body.monthlyCap !== undefined && (!Number.isInteger(body.monthlyCap) || Number(body.monthlyCap) < 0 || Number(body.monthlyCap) > 1_000_000))) return failure()
    const encryptedCredential = encryptCredential(body.credential)
    const monthlyCap = typeof body.monthlyCap === 'number' ? body.monthlyCap : null
    const data = { provider: body.provider, model: body.model, fallbackProvider: body.fallbackProvider ?? null, monthlyCap, encryptedCredential, credentialFingerprint: credentialFingerprint(body.credential), health: 'unknown' as const, testedAt: null }
    const saved = record ? await payload.update({ collection: 'integration-configurations', id: String(record.id), data, overrideAccess: true }) : await payload.create({ collection: 'integration-configurations', data, overrideAccess: true })
    await payload.create({ collection: 'audit-events', data: { event: 'integration.credential_rotated', actor: user.id, detail: { provider: body.provider } }, overrideAccess: true })
    return Response.json({ integration: publicIntegration(saved as unknown as Record<string, unknown>) }, { status: record ? 200 : 201, headers: { 'Cache-Control': 'no-store' } })
  } catch { return failure() }
}
