import * as oidc from 'openid-client'
import type { IdentityProvider } from './identity'

type ProviderSettings = { issuer: string; clientID: string; clientSecret: string; redirectURI: string }

const envPrefix: Record<IdentityProvider, string> = { google: 'OIDC_GOOGLE', microsoft: 'OIDC_MICROSOFT' }

export function configuredProvider(provider: IdentityProvider): ProviderSettings | undefined {
  const prefix = envPrefix[provider]
  const issuer = process.env[`${prefix}_ISSUER_URL`]
  const clientID = process.env[`${prefix}_CLIENT_ID`]
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]
  const baseURL = process.env.PAYLOAD_PUBLIC_SERVER_URL
  if (!issuer || !clientID || !clientSecret || !baseURL) return undefined
  return { issuer, clientID, clientSecret, redirectURI: `${baseURL}/api/auth/callback/${provider}` }
}

export async function oidcConfiguration(settings: ProviderSettings) {
  return oidc.discovery(new URL(settings.issuer), settings.clientID, settings.clientSecret, undefined,
    process.env.NODE_ENV === 'test' ? { execute: [oidc.allowInsecureRequests] } : undefined)
}

export async function authorizationURL(settings: ProviderSettings, state: string, nonce: string, verifier: string) {
  const config = await oidcConfiguration(settings)
  const challenge = await oidc.calculatePKCECodeChallenge(verifier)
  return oidc.buildAuthorizationUrl(config, {
    redirect_uri: settings.redirectURI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
}

export async function validateCallback(provider: IdentityProvider, settings: ProviderSettings, request: Request, state: string, nonce: string, verifier: string) {
  const config = await oidcConfiguration(settings)
  const tokens = await oidc.authorizationCodeGrant(config, new URL(request.url), {
    pkceCodeVerifier: verifier,
    expectedState: state,
    expectedNonce: nonce,
    idTokenExpected: true,
  })
  const claims = tokens.claims()
  if (!claims) throw new Error('Provider did not return identity claims.')
  const email = typeof claims.email === 'string' ? claims.email : undefined
  // Google supplies email_verified. Microsoft tenant ownership is verified by the
  // configured issuer and subject; its UPN/email claim is never an account linker.
  if (!claims.sub || !email || (provider === 'google' && claims.email_verified !== true)) throw new Error('Provider did not return a verified email identity.')
  return { subject: claims.sub, email, name: typeof claims.name === 'string' ? claims.name : email }
}
