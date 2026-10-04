import { getPayload } from 'payload'
import config from '../../../payload.config'
import { freshStaff, hasRole } from '../../../src/access'
import { integrationProviders, publicIntegration, type IntegrationProvider } from '../../../src/integrations'
import { serverSessionStrategy } from '../../../src/identity'
import { configureIntegration, revokeIntegration } from '../../../src/integration-configuration'

export const dynamic = 'force-dynamic'
const sameOrigin = (request: Request) => {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}
const isProvider = (value: unknown): value is IntegrationProvider => typeof value === 'string' && integrationProviders.includes(value as IntegrationProvider)
const privateJSON = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const failure = () => privateJSON({ error: 'Integration request could not be completed.' }, 400)

async function owner(request: Request) {
  const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  return { payload, user: auth.user as { id?: string; roles?: string[] } | null }
}

export async function GET(request: Request) {
  const { payload, user } = await owner(request)
  if (!hasRole(user as never, ['owner'])) return privateJSON({ error: 'Owner access required.' }, 403)
  const records = await payload.find({ collection: 'integration-configurations', sort: 'provider', limit: 20, depth: 0, overrideAccess: true })
  return privateJSON({ integrations: records.docs.map((doc) => publicIntegration(doc as unknown as Record<string, unknown>)) })
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return privateJSON({ error: 'CSRF origin check failed.' }, 403)
  try {
    const { payload, user } = await owner(request)
    if (!user || !(await freshStaff(['owner'])({ req: { payload, user, headers: request.headers } as never }))) return privateJSON({ error: 'Fresh Owner authentication is required.' }, 403)
    const body = await request.json() as Record<string, unknown>
    if (!isProvider(body.provider)) return failure()
    if (body.action === 'revoke') {
      const revoked = await revokeIntegration(payload, { provider: body.provider, actor: user.id })
      return revoked ? privateJSON({ integration: publicIntegration(revoked as unknown as Record<string, unknown>) }) : failure()
    }
    const money = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    if (body.action !== 'configure' || typeof body.credential !== 'string' || typeof body.model !== 'string' || body.model.length > 160 || (body.fallbackProvider !== null && body.fallbackProvider !== undefined && !isProvider(body.fallbackProvider)) || (body.monthlyCapMicroUsd !== null && body.monthlyCapMicroUsd !== undefined && !money(body.monthlyCapMicroUsd)) || !money(body.inputMicroUsdPerMillionTokens) || !money(body.outputMicroUsdPerMillionTokens) || typeof body.pricingSource !== 'string' || !body.pricingSource.trim() || body.pricingSource.length > 500 || typeof body.pricingAsOf !== 'string' || Number.isNaN(Date.parse(body.pricingAsOf))) return failure()
    const monthlyCapMicroUsd = typeof body.monthlyCapMicroUsd === 'number' ? body.monthlyCapMicroUsd : null
    const result = await configureIntegration(payload, { provider: body.provider, model: body.model, credential: body.credential, fallbackProvider: body.fallbackProvider ?? null, pricing: { monthlyCapMicroUsd, inputMicroUsdPerMillionTokens: body.inputMicroUsdPerMillionTokens, outputMicroUsdPerMillionTokens: body.outputMicroUsdPerMillionTokens, pricingSource: body.pricingSource.trim(), pricingAsOf: new Date(body.pricingAsOf).toISOString() }, actor: user.id })
    return privateJSON({ integration: publicIntegration(result.saved as unknown as Record<string, unknown>) }, result.created ? 201 : 200)
  } catch { return failure() }
}
