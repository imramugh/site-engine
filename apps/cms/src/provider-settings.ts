import type { IntegrationProvider } from './integrations'

/** Safe to share with the admin client; secrets are never part of these settings. */
export type ProviderSettings = { endpoint?: string; region?: string; imageInput?: boolean; imageInputTokenLimit?: number }
export const MAX_REVIEWED_IMAGE_INPUT_TOKEN_LIMIT = 1_000_000
const keys = new Set(['endpoint', 'region', 'imageInput', 'imageInputTokenLimit'])
const regionPattern = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/
function invalid(): never { throw new Error('PROVIDER_SETTINGS_INVALID') }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown> }
function endpoint(value: unknown): string { if (typeof value !== 'string' || value.length > 2_048) invalid(); let url: URL; try { url = new URL(value) } catch { invalid() }; if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' && url.pathname !== '/openai/v1' || url.hostname.endsWith('.local') || url.hostname === 'localhost') invalid(); return url.origin }
function image(settings: Record<string, unknown>, required: boolean): Pick<ProviderSettings, 'imageInput' | 'imageInputTokenLimit'> { const enabled = settings.imageInput; if (enabled === undefined && !required) return {}; if (typeof enabled !== 'boolean') invalid(); if (!enabled) { if (settings.imageInputTokenLimit !== undefined) invalid(); return { imageInput: false } }; if (typeof settings.imageInputTokenLimit !== 'number' || !Number.isSafeInteger(settings.imageInputTokenLimit) || settings.imageInputTokenLimit < 1 || settings.imageInputTokenLimit > MAX_REVIEWED_IMAGE_INPUT_TOKEN_LIMIT) invalid(); return { imageInput: true, imageInputTokenLimit: settings.imageInputTokenLimit } }

/** Validates the serializable configuration shape. Server code additionally authorizes compatible origins. */
export function normalizeProviderSettings(provider: IntegrationProvider, value: unknown): ProviderSettings {
  const settings = value === undefined || value === null ? {} : object(value)
  if (!Object.keys(settings).every(key => keys.has(key))) invalid()
  if (provider === 'azure-openai') { const origin = endpoint(settings.endpoint); const url = new URL(origin); if (!/^[a-z0-9-]+\.openai\.azure\.com$/i.test(url.hostname)) invalid(); return { endpoint: `${origin}/openai/v1`, ...image(settings, true) } }
  if (provider === 'amazon-bedrock') { if (typeof settings.region !== 'string' || !regionPattern.test(settings.region)) invalid(); return { region: settings.region, ...image(settings, true) } }
  if (provider === 'openai-compatible') return { endpoint: endpoint(settings.endpoint), ...image(settings, true) }
  if (settings.endpoint !== undefined || settings.region !== undefined) invalid()
  return image(settings, provider === 'mistral')
}
