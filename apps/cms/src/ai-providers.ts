import type { Payload } from 'payload'
import { decryptCredential, type IntegrationProvider } from './integrations'
import { withPayloadTransaction } from './auth-transaction'

/** Money is always an integer count of one-millionths of a US dollar. */
export type MicroUsd = number
export type AIJob = { provider: IntegrationProvider; fallbackProvider?: IntegrationProvider | null; input: string; requiresImage?: boolean; maxOutputTokens: number }
export type ProviderCapability = { imageInput: boolean; endpoint: string; auth: 'bearer' | 'x-api-key' }
export const providerCapabilities: Record<IntegrationProvider, ProviderCapability> = {
  openai: { imageInput: true, endpoint: 'https://api.openai.com/v1/responses', auth: 'bearer' },
  anthropic: { imageInput: true, endpoint: 'https://api.anthropic.com/v1/messages', auth: 'x-api-key' },
  'google-gemini': { imageInput: true, endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'x-api-key' },
  openrouter: { imageInput: true, endpoint: 'https://openrouter.ai/api/v1/chat/completions', auth: 'bearer' },
}
export type ProviderFetch = (request: Request) => Promise<Response>
export type AIJobResult = { provider: IntegrationProvider; fallbackUsed: boolean; output: string; usageCostMicroUsd: MicroUsd }
type TokenUsage = { inputTokens: number; outputTokens: number }
type Attempt = { outcome: 'success'; output: string; usage?: TokenUsage } | { outcome: 'unavailable' | 'rejected' }
type StoredConfiguration = Record<string, unknown> & { id: string; provider: IntegrationProvider; model: string; encryptedCredential?: string | null; credentialFingerprint?: string | null; monthlyCapMicroUsd?: number | null; monthlyUsageMicroUsd?: number | null; usageMonth?: string | null; health?: string | null; inputMicroUsdPerMillionTokens?: number | null; outputMicroUsdPerMillionTokens?: number | null; pricingSource?: string | null; pricingAsOf?: string | null }
type Pricing = { inputMicroUsdPerMillionTokens: MicroUsd; outputMicroUsdPerMillionTokens: MicroUsd; source: string; asOf: string }
const monthAt = (date: Date) => date.toISOString().slice(0, 7)
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const text = (value: unknown) => typeof value === 'string' ? value : undefined
const MAX_OUTPUT_TOKENS = 8_192

function pricingFor(config: StoredConfiguration): Pricing | undefined {
  const input = integer(config.inputMicroUsdPerMillionTokens); const output = integer(config.outputMicroUsdPerMillionTokens); const source = text(config.pricingSource); const asOf = text(config.pricingAsOf)
  return input !== undefined && output !== undefined && source && asOf ? { inputMicroUsdPerMillionTokens: input, outputMicroUsdPerMillionTokens: output, source, asOf } : undefined
}
function costMicroUsd(inputTokens: number, outputTokens: number, pricing: Pricing): MicroUsd | undefined {
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || inputTokens < 0 || outputTokens < 0) return undefined
  const input = Math.ceil((inputTokens * pricing.inputMicroUsdPerMillionTokens) / 1_000_000); const output = Math.ceil((outputTokens * pricing.outputMicroUsdPerMillionTokens) / 1_000_000)
  return Number.isSafeInteger(input) && Number.isSafeInteger(output) && Number.isSafeInteger(input + output) ? input + output : undefined
}
// A byte is a conservative token upper bound for the text-only requests built below.
const conservativeInputTokens = (input: string) => Buffer.byteLength(input, 'utf8')

function requestFor(provider: IntegrationProvider, credential: string, model: string, input: string, maxOutputTokens: number, signal?: AbortSignal): Request {
  if (provider === 'openai') return new Request(providerCapabilities.openai.endpoint, { method: 'POST', signal, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, max_output_tokens: maxOutputTokens, input: [{ role: 'user', content: [{ type: 'input_text', text: input }] }] }) })
  if (provider === 'anthropic') return new Request(providerCapabilities.anthropic.endpoint, { method: 'POST', signal, headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: input }] }) })
  if (provider === 'google-gemini') return new Request(`${providerCapabilities['google-gemini'].endpoint}/${encodeURIComponent(model)}:generateContent`, { method: 'POST', signal, headers: { 'x-goog-api-key': credential, 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: input }] }], generationConfig: { maxOutputTokens } }) })
  return new Request(providerCapabilities.openrouter.endpoint, { method: 'POST', signal, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: input }] }) })
}
function usage(input: unknown, output: unknown): TokenUsage | undefined { const inputTokens = integer(input); const outputTokens = integer(output); return inputTokens !== undefined && outputTokens !== undefined ? { inputTokens, outputTokens } : undefined }
function parsed(provider: IntegrationProvider, body: Record<string, unknown>): { output: string; usage?: TokenUsage } | undefined {
  if (provider === 'openai') { const output = Array.isArray(body.output) ? body.output.flatMap((item) => Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content : []).map((part) => text((part as Record<string, unknown>).text)).find(Boolean) : undefined; const details = body.usage as Record<string, unknown> | undefined; return output ? { output, usage: usage(details?.input_tokens, details?.output_tokens) } : undefined }
  if (provider === 'anthropic') { const output = Array.isArray(body.content) ? body.content.map((part) => text((part as Record<string, unknown>).text)).find(Boolean) : undefined; const details = body.usage as Record<string, unknown> | undefined; return output ? { output, usage: usage(details?.input_tokens, details?.output_tokens) } : undefined }
  if (provider === 'google-gemini') { const candidate = Array.isArray(body.candidates) ? body.candidates[0] as Record<string, unknown> | undefined : undefined; const content = candidate?.content as Record<string, unknown> | undefined; const output = Array.isArray(content?.parts) ? content.parts.map((part) => text((part as Record<string, unknown>).text)).find(Boolean) : undefined; const details = body.usageMetadata as Record<string, unknown> | undefined; return output ? { output, usage: usage(details?.promptTokenCount, details?.candidatesTokenCount) } : undefined }
  const choice = Array.isArray(body.choices) ? body.choices[0] as Record<string, unknown> | undefined : undefined; const message = choice?.message as Record<string, unknown> | undefined; const output = text(message?.content); const details = body.usage as Record<string, unknown> | undefined
  return output ? { output, usage: usage(details?.prompt_tokens, details?.completion_tokens) } : undefined
}

/** Builds bounded provider requests and normalizes provider token counts; provider-reported money is deliberately ignored. */
export async function invokeProvider(provider: IntegrationProvider, credential: string, model: string, input: string, maxOutputTokens: number, transport: ProviderFetch = fetch, timeoutMs = 15_000): Promise<Attempt> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs)
  try { const response = await Promise.race([transport(requestFor(provider, credential, model, input, maxOutputTokens, controller.signal)), new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))]); if (!response.ok) return { outcome: response.status === 401 || response.status === 403 ? 'rejected' : 'unavailable' }; const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined; const result = body && parsed(provider, body); return result ? { outcome: 'success', ...result } : { outcome: 'unavailable' } } catch { return { outcome: 'unavailable' } } finally { clearTimeout(timer) }
}
async function configuration(payload: Payload, provider: IntegrationProvider): Promise<StoredConfiguration | undefined> { const result = await payload.find({ collection: 'integration-configurations', where: { provider: { equals: provider } }, limit: 1, depth: 0, overrideAccess: true }); return result.docs[0] as unknown as StoredConfiguration | undefined }
async function reserve(payload: Payload, config: StoredConfiguration, reservedMicroUsd: MicroUsd, now: Date): Promise<StoredConfiguration | undefined> { const month = monthAt(now); try { return await withPayloadTransaction(payload, async (req) => { const current = await payload.findByID({ collection: 'integration-configurations', id: config.id, depth: 0, overrideAccess: true, req }) as unknown as StoredConfiguration; if (!current.encryptedCredential || current.health === 'revoked') return undefined; const used = current.usageMonth === month ? integer(current.monthlyUsageMicroUsd) ?? 0 : 0; const cap = current.monthlyCapMicroUsd === null || current.monthlyCapMicroUsd === undefined ? undefined : integer(current.monthlyCapMicroUsd); if (cap === undefined && current.monthlyCapMicroUsd !== null && current.monthlyCapMicroUsd !== undefined) return undefined; if (!Number.isSafeInteger(used + reservedMicroUsd) || (cap !== undefined && used + reservedMicroUsd > cap)) return undefined; await payload.update({ collection: 'integration-configurations', id: current.id, data: { monthlyUsageMicroUsd: used + reservedMicroUsd, usageMonth: month } as never, overrideAccess: true, req }); return current }) } catch { return undefined } }
async function settle(payload: Payload, config: StoredConfiguration, reservedMicroUsd: MicroUsd, actualMicroUsd: MicroUsd | undefined, health: 'connected' | 'unavailable' | 'rejected', now: Date): Promise<void> { const month = monthAt(now); await withPayloadTransaction(payload, async (req) => { const current = await payload.findByID({ collection: 'integration-configurations', id: config.id, depth: 0, overrideAccess: true, req }) as unknown as StoredConfiguration; if (!current.encryptedCredential || current.health === 'revoked' || current.encryptedCredential !== config.encryptedCredential || current.credentialFingerprint !== config.credentialFingerprint) return; const used = current.usageMonth === month ? integer(current.monthlyUsageMicroUsd) ?? 0 : 0; const charge = health === 'connected' ? actualMicroUsd ?? reservedMicroUsd : 0; const next = Math.max(0, used - reservedMicroUsd + charge); await payload.update({ collection: 'integration-configurations', id: current.id, data: { monthlyUsageMicroUsd: next, usageMonth: month, health, testedAt: now.toISOString() } as never, overrideAccess: true, req }) }) }

/** Executes an in-product job from encrypted persisted configuration without exposing credentials or provider diagnostics. */
export async function executeConfiguredAIJob(payload: Payload, job: AIJob, options: { transport?: ProviderFetch; now?: Date; timeoutMs?: number } = {}): Promise<AIJobResult> {
  if (!job.input || job.input.length > 100_000 || !Number.isSafeInteger(job.maxOutputTokens) || job.maxOutputTokens < 1 || job.maxOutputTokens > MAX_OUTPUT_TOKENS) throw new Error('AI_JOB_UNAVAILABLE')
  const now = options.now ?? new Date()
  const attempt = async (provider: IntegrationProvider): Promise<Attempt & { usageCostMicroUsd?: MicroUsd }> => { const config = await configuration(payload, provider); if (!config || !config.encryptedCredential || config.health === 'revoked' || (job.requiresImage && !providerCapabilities[provider].imageInput)) return { outcome: config?.health === 'revoked' ? 'rejected' : 'unavailable' }; const pricing = pricingFor(config); if (!pricing) return { outcome: 'unavailable' }; const reservedMicroUsd = costMicroUsd(conservativeInputTokens(job.input), job.maxOutputTokens, pricing); if (reservedMicroUsd === undefined) return { outcome: 'unavailable' }; const reserved = await reserve(payload, config, reservedMicroUsd, now); if (!reserved) return { outcome: 'unavailable' }; let credential: string; try { credential = decryptCredential(reserved.encryptedCredential!, provider) } catch { await settle(payload, reserved, reservedMicroUsd, undefined, 'rejected', now); return { outcome: 'rejected' } }; const result = await invokeProvider(provider, credential, reserved.model, job.input, job.maxOutputTokens, options.transport, options.timeoutMs); const calculatedMicroUsd = result.outcome === 'success' && result.usage ? costMicroUsd(result.usage.inputTokens, result.usage.outputTokens, pricing) : undefined; const actualMicroUsd = calculatedMicroUsd === undefined ? undefined : Math.min(calculatedMicroUsd, reservedMicroUsd); await settle(payload, reserved, reservedMicroUsd, actualMicroUsd, result.outcome === 'success' ? 'connected' : result.outcome, now); return result.outcome === 'success' ? { ...result, usageCostMicroUsd: actualMicroUsd ?? reservedMicroUsd } : result }
  const primary = await attempt(job.provider)
  if (primary.outcome === 'success') return { provider: job.provider, fallbackUsed: false, output: primary.output, usageCostMicroUsd: primary.usageCostMicroUsd! }
  if (primary.outcome === 'unavailable' && job.fallbackProvider && job.fallbackProvider !== job.provider) { const fallback = await attempt(job.fallbackProvider); if (fallback.outcome === 'success') return { provider: job.fallbackProvider, fallbackUsed: true, output: fallback.output, usageCostMicroUsd: fallback.usageCostMicroUsd! } }
  throw new Error('AI_JOB_UNAVAILABLE')
}
