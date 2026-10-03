import type { IntegrationProvider } from './integrations'

export type AIJob = { provider: IntegrationProvider; fallbackProvider?: IntegrationProvider | null; model: string; requiresImage?: boolean; estimatedCost: number }
export type ProviderCapability = { imageInput: boolean; endpoint: string; auth: 'bearer' | 'x-api-key' }
export const providerCapabilities: Record<IntegrationProvider, ProviderCapability> = {
  openai: { imageInput: true, endpoint: 'https://api.openai.com/v1/responses', auth: 'bearer' },
  anthropic: { imageInput: true, endpoint: 'https://api.anthropic.com/v1/messages', auth: 'x-api-key' },
  'google-gemini': { imageInput: true, endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'x-api-key' },
  openrouter: { imageInput: true, endpoint: 'https://openrouter.ai/api/v1/chat/completions', auth: 'bearer' },
}
export type ProviderTransport = (request: { provider: IntegrationProvider; endpoint: string; credential: string; model: string; requiresImage: boolean }) => Promise<{ ok: boolean; usageCost?: number }>
export async function runAIJob(job: AIJob, configurations: Map<IntegrationProvider, { credential: string; monthlyCap: number | null; used: number }>, transport: ProviderTransport) {
  const attempt = async (provider: IntegrationProvider) => {
    const config = configurations.get(provider); const capability = providerCapabilities[provider]
    if (!config || (config.monthlyCap !== null && config.used + job.estimatedCost > config.monthlyCap) || (job.requiresImage && !capability.imageInput)) return false
    const result = await transport({ provider, endpoint: capability.endpoint, credential: config.credential, model: job.model, requiresImage: Boolean(job.requiresImage) })
    if (result.ok) config.used += result.usageCost ?? job.estimatedCost
    return result.ok
  }
  if (await attempt(job.provider)) return { provider: job.provider, fallbackUsed: false }
  if (job.fallbackProvider && await attempt(job.fallbackProvider)) return { provider: job.fallbackProvider, fallbackUsed: true }
  throw new Error('AI_JOB_UNAVAILABLE')
}
