import type { IntegrationProvider } from './integrations'

/** Browser-safe, serializable provider settings. Credentials are stored separately. */
export type ProviderSettings = {
  endpoint?: string
  region?: string
  imageInput?: boolean
  imageInputTokenLimit?: number
}

export const MAX_REVIEWED_IMAGE_INPUT_TOKEN_LIMIT = 1_000_000
const keys = new Set(['endpoint', 'region', 'imageInput', 'imageInputTokenLimit'])
const regionPattern = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/

function invalid(): never { throw new Error('PROVIDER_SETTINGS_INVALID') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function endpoint(value: unknown, allowBasePath = false): string {
  if (typeof value !== 'string' || value.length > 2_048) invalid()
  let url: URL
  try { url = new URL(value) } catch { invalid() }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.hostname === 'localhost' || url.hostname.endsWith('.local')) invalid()
  if (!allowBasePath && !['/', '/openai/v1', '/openai/v1/'].includes(url.pathname)) invalid()
  return `${url.origin}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`
}
function imageSettings(settings: Record<string, unknown>, required: boolean): Pick<ProviderSettings, 'imageInput' | 'imageInputTokenLimit'> {
  if (settings.imageInput === undefined && !required) return {}
  if (typeof settings.imageInput !== 'boolean') invalid()
  if (!settings.imageInput) {
    if (settings.imageInputTokenLimit !== undefined) invalid()
    return { imageInput: false }
  }
  const limit = settings.imageInputTokenLimit
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REVIEWED_IMAGE_INPUT_TOKEN_LIMIT) invalid()
  return { imageInput: true, imageInputTokenLimit: limit }
}

/** Validates and canonicalizes settings. Compatible endpoint authorization happens server-side. */
export function normalizeProviderSettings(provider: IntegrationProvider, value: unknown): ProviderSettings {
  const settings = value === undefined || value === null ? {} : record(value)
  if (!Object.keys(settings).every(key => keys.has(key))) invalid()
  if (provider === 'azure-openai') {
    const base = endpoint(settings.endpoint)
    const url = new URL(base)
    if (!/^[a-z0-9-]+\.openai\.azure\.com$/i.test(url.hostname)) invalid()
    return { endpoint: base.endsWith('/openai/v1') ? base : `${base}/openai/v1`, ...imageSettings(settings, true) }
  }
  if (provider === 'amazon-bedrock') {
    if (typeof settings.region !== 'string' || !regionPattern.test(settings.region)) invalid()
    return { region: settings.region, ...imageSettings(settings, true) }
  }
  if (provider === 'openai-compatible') return { endpoint: endpoint(settings.endpoint, true), ...imageSettings(settings, true) }
  if (settings.endpoint !== undefined || settings.region !== undefined) invalid()
  return imageSettings(settings, provider === 'mistral')
}
