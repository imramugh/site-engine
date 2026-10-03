import type { Payload } from 'payload'
import { withPayloadTransaction } from './auth-transaction'
import { OIDC_STATE_TTL_SECONDS, type IdentityProvider } from './identity'

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export const AUTH_TRANSACTION_MAX_RECORDS = positiveInteger(process.env.AUTH_TRANSACTION_MAX_RECORDS, 1_000)
export const AUTH_TRANSACTION_START_COOLDOWN_SECONDS = positiveInteger(process.env.AUTH_TRANSACTION_START_COOLDOWN_SECONDS, 15)

export class AuthStartThrottledError extends Error {
  constructor(readonly reason: 'capacity' | 'cooldown') {
    super(reason === 'capacity' ? 'Sign-in is temporarily busy. Please try again shortly.' : 'A sign-in request was just started in this browser. Please wait briefly.')
  }
}

type AuthTransactionInput = {
  invitation?: string
  nonce: string
  previousStateHash?: string
  provider: IdentityProvider
  stateHash: string
  verifier: string
}

/**
 * Keep the server-side OIDC state table bounded without trusting client IP
 * headers. The HttpOnly browser state cookie supplies a best-effort cooldown;
 * the transactional global cap protects first-time and cookie-less requests.
 */
export async function createBoundedAuthTransaction(payload: Payload, input: AuthTransactionInput) {
  return withPayloadTransaction(payload, async (req) => {
    const now = new Date()
    await payload.delete({ collection: 'auth-transactions', where: { expiresAt: { less_than: now.toISOString() } }, overrideAccess: true, req })

    if (input.previousStateHash) {
      const previous = await payload.find({ collection: 'auth-transactions', where: { stateHash: { equals: input.previousStateHash } }, limit: 1, overrideAccess: true, req })
      const previousTransaction = previous.docs[0]
      if (previousTransaction && previousTransaction.provider === input.provider && !previousTransaction.consumedAt && Date.parse(previousTransaction.createdAt) > now.getTime() - AUTH_TRANSACTION_START_COOLDOWN_SECONDS * 1_000) {
        throw new AuthStartThrottledError('cooldown')
      }
    }

    const retained = await payload.count({ collection: 'auth-transactions', overrideAccess: true, req })
    if (retained.totalDocs >= AUTH_TRANSACTION_MAX_RECORDS) throw new AuthStartThrottledError('capacity')

    return payload.create({
      collection: 'auth-transactions',
      data: {
        stateHash: input.stateHash,
        nonce: input.nonce,
        verifier: input.verifier,
        provider: input.provider,
        invitation: input.invitation,
        expiresAt: new Date(now.getTime() + OIDC_STATE_TTL_SECONDS * 1_000).toISOString(),
      },
      overrideAccess: true,
      req,
    })
  })
}
