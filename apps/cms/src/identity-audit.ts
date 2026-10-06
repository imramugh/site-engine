import type { Payload, PayloadRequest } from 'payload'

/**
 * Identity audit entries intentionally contain only a stable decision and the
 * configured provider. Never put credentials, authorization responses, claims,
 * or attempted email addresses in this collection.
 */
export const identityAuditReasons = {
  callback: ['transaction_provider_mismatch', 'identity_verification_failed', 'invitation_not_authorized', 'identity_already_bound', 'identity_disabled'] as const,
  emergency: ['account_not_eligible', 'account_disabled', 'invalid_credential'] as const,
} as const

type CallbackReason = (typeof identityAuditReasons.callback)[number]
type EmergencyReason = (typeof identityAuditReasons.emergency)[number]

type AuditInput = {
  payload: Payload
  req?: PayloadRequest
  event: 'identity.sign_in_denied' | 'identity.signed_in' | 'identity.emergency_denied' | 'identity.emergency_signed_in'
  user?: string
  provider?: 'google' | 'microsoft' | 'local'
  reason?: CallbackReason | EmergencyReason
  transactionID?: string
}

export async function auditIdentityDecision({ payload, req, event, user, provider, reason, transactionID }: AuditInput) {
  const detail = {
    ...(provider ? { provider } : {}),
    ...(reason ? { reason } : {}),
    ...(transactionID ? { transactionID: String(transactionID) } : {}),
  }
  await payload.create({ collection: 'audit-events', data: { event, ...(user ? { user } : {}), detail }, overrideAccess: true, ...(req ? { req } : {}) })
}

/** A rejected OIDC transaction may be retried until it expires. Record one decision per transaction. */
export async function auditCallbackDenial(payload: Payload, input: { transactionID?: string; provider: 'google' | 'microsoft'; reason: CallbackReason; user?: string }) {
  if (input.transactionID) {
    const existing = await payload.find({
      collection: 'audit-events',
      where: { and: [{ event: { equals: 'identity.sign_in_denied' } }, { 'detail.transactionID': { equals: String(input.transactionID) } }] },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    if (existing.docs.length) return
  }
  await auditIdentityDecision({ payload, event: 'identity.sign_in_denied', user: input.user, provider: input.provider, reason: input.reason, transactionID: input.transactionID })
}

/** Emergency lockouts already stop credential verification after five failures. For account-state denials, keep one audit event per account and reason in the lockout window. */
export async function auditEmergencyDenial(payload: Payload, input: { req: PayloadRequest; user: string; reason: EmergencyReason; now: number }) {
  const recent = await payload.find({
    collection: 'audit-events',
    where: { and: [
      { event: { equals: 'identity.emergency_denied' } },
      { user: { equals: input.user } },
      { 'detail.reason': { equals: input.reason } },
      { createdAt: { greater_than: new Date(input.now - 15 * 60_000).toISOString() } },
    ] },
    limit: 1, depth: 0, overrideAccess: true, req: input.req,
  })
  if (!recent.docs.length) await auditIdentityDecision({ payload, req: input.req, event: 'identity.emergency_denied', user: input.user, provider: 'local', reason: input.reason })
}
