import type { Payload } from 'payload'
import { providerConnectionTransport, type ConnectionTransport, type IntegrationProvider } from './integrations'
import { testIntegrationConnection } from './integration-configuration'

const normalInterval = 5 * 60_000
const failedInterval = 15 * 60_000
const providers = new Set<IntegrationProvider>(['openai', 'anthropic', 'google-gemini', 'openrouter'])
/** Bounded worker-only monitor. It never probes absent or explicitly revoked credentials. */
export async function monitorIntegrationHealth(payload: Payload, now = new Date(), transport: ConnectionTransport = providerConnectionTransport, limit = 5): Promise<number> {
  const configs = await payload.find({ collection: 'integration-configurations', where: { and: [{ encryptedCredential: { exists: true } }, { health: { not_equals: 'revoked' } }] }, sort: 'testedAt', limit, pagination: false, depth: 0, overrideAccess: true })
  let checked = 0
  for (const config of configs.docs as Array<{ provider?: string; health?: string; testedAt?: string | null }>) {
    if (!config.provider || !providers.has(config.provider as IntegrationProvider)) continue
    const previous = config.testedAt ? Date.parse(config.testedAt) : 0
    const interval = ['unavailable', 'rejected'].includes(String(config.health)) ? failedInterval : normalInterval
    if (previous && now.getTime() - previous < interval) continue
    await testIntegrationConnection(payload as never, { provider: config.provider as IntegrationProvider, now }, transport)
    checked += 1
  }
  return checked
}
