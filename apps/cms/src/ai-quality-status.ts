import type { QualityReport } from '@site-engine/checks'
import type { Payload, PayloadRequest } from 'payload'

/** Availability is not execution evidence. A deterministic audit must never
 * silently incur provider spend or claim an AI review was performed. */
export async function attachConfiguredAIStatus(payload: Payload, report: QualityReport, req?: PayloadRequest): Promise<QualityReport> {
  let configured
  try { configured = await payload.find({
    collection: 'integration-configurations',
    where: { and: [{ encryptedCredential: { exists: true } }, { health: { equals: 'connected' } }] },
    limit: 20,
    depth: 0,
    overrideAccess: true,
    ...(req ? { req } : {}),
  }) } catch {
    return { ...report, ai: { status: 'not-run', code: 'AI_CHECKS_NOT_RUN', message: 'AI provider availability could not be checked. These are deterministic results; no AI check ran.' } }
  }
  const available = configured.docs.some(doc => typeof doc.encryptedCredential === 'string' && doc.encryptedCredential.length > 0 && typeof doc.model === 'string' && doc.model.trim().length > 0)
  return {
    ...report,
    ai: available
      ? { status: 'not-run', code: 'AI_CHECKS_NOT_RUN', message: 'An AI provider is configured. This audit ran deterministic checks only; request an AI suggestion separately.' }
      : { status: 'unavailable', code: 'AI_PROVIDER_UNAVAILABLE', message: 'No connected AI provider is available. An Owner can configure and test a provider in Integrations.' },
  }
}
