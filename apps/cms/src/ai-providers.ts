import type { Payload } from 'payload'
import { decryptCredential, type IntegrationProvider } from './integrations'
import { withPayloadTransaction } from './auth-transaction'

export type AIJob = { provider: IntegrationProvider; fallbackProvider?: IntegrationProvider | null; input: string; requiresImage?: boolean; estimatedCost: number }
export type ProviderCapability = { imageInput: boolean; endpoint: string; auth: 'bearer' | 'x-api-key' }
export const providerCapabilities: Record<IntegrationProvider, ProviderCapability> = {
  openai: { imageInput: true, endpoint: 'https://api.openai.com/v1/responses', auth: 'bearer' },
  anthropic: { imageInput: true, endpoint: 'https://api.anthropic.com/v1/messages', auth: 'x-api-key' },
  'google-gemini': { imageInput: true, endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'x-api-key' },
  openrouter: { imageInput: true, endpoint: 'https://openrouter.ai/api/v1/chat/completions', auth: 'bearer' },
}
export type ProviderFetch = (request: Request) => Promise<Response>
export type AIJobResult = { provider: IntegrationProvider; fallbackUsed: boolean; output: string; usageCost: number }
type Attempt = { outcome: 'success'; output: string; usageCost: number } | { outcome: 'unavailable' | 'rejected' }
type StoredConfiguration = Record<string, unknown> & { id: string; provider: IntegrationProvider; model: string; encryptedCredential?: string | null; monthlyCap?: number | null; monthlyUsage?: number | null; usageMonth?: string | null; health?: string | null }
const monthAt = (date: Date) => date.toISOString().slice(0, 7)
const finiteNonNegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const text = (value: unknown) => typeof value === 'string' ? value : undefined
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

function requestFor(provider: IntegrationProvider, credential: string, model: string, input: string, signal?: AbortSignal): Request {
  if (provider === 'openai') return new Request(providerCapabilities.openai.endpoint, { method: 'POST', signal, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: input }] }] }) })
  if (provider === 'anthropic') return new Request(providerCapabilities.anthropic.endpoint, { method: 'POST', signal, headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: input }] }) })
  if (provider === 'google-gemini') return new Request(`${providerCapabilities['google-gemini'].endpoint}/${encodeURIComponent(model)}:generateContent`, { method: 'POST', signal, headers: { 'x-goog-api-key': credential, 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: input }] }] }) })
  return new Request(providerCapabilities.openrouter.endpoint, { method: 'POST', signal, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: input }] }) })
}

function parsed(provider: IntegrationProvider, body: Record<string, unknown>, fallbackCost: number): { output: string; usageCost: number } | undefined {
  if (provider === 'openai') { const output = Array.isArray(body.output) ? body.output.flatMap((item) => Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content : []).map((part) => text((part as Record<string, unknown>).text)).find(Boolean) : undefined; const usage = body.usage as Record<string, unknown> | undefined; return output ? { output, usageCost: number(usage?.total_tokens) ?? fallbackCost } : undefined }
  if (provider === 'anthropic') { const output = Array.isArray(body.content) ? body.content.map((part) => text((part as Record<string, unknown>).text)).find(Boolean) : undefined; const usage = body.usage as Record<string, unknown> | undefined; const input = number(usage?.input_tokens); const outputTokens = number(usage?.output_tokens); return output ? { output, usageCost: input !== undefined && outputTokens !== undefined ? input + outputTokens : fallbackCost } : undefined }
  if (provider === 'google-gemini') { const candidate = Array.isArray(body.candidates) ? body.candidates[0] as Record<string, unknown> | undefined : undefined; const content = candidate?.content as Record<string, unknown> | undefined; const output = Array.isArray(content?.parts) ? content.parts.map((part) => text((part as Record<string, unknown>).text)).find(Boolean) : undefined; const usage = body.usageMetadata as Record<string, unknown> | undefined; return output ? { output, usageCost: number(usage?.totalTokenCount) ?? fallbackCost } : undefined }
  const choice = Array.isArray(body.choices) ? body.choices[0] as Record<string, unknown> | undefined : undefined; const message = choice?.message as Record<string, unknown> | undefined; const output = text(message?.content); const usage = body.usage as Record<string, unknown> | undefined; return output ? { output, usageCost: number(usage?.cost) ?? number(usage?.total_tokens) ?? fallbackCost } : undefined
}

/** Builds the documented provider request and normalizes only successful text responses. */
export async function invokeProvider(provider: IntegrationProvider, credential: string, model: string, input: string, estimatedCost: number, transport: ProviderFetch = fetch, timeoutMs = 15_000): Promise<Attempt> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs)
  try { const response = await Promise.race([transport(requestFor(provider, credential, model, input, controller.signal)), new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))]); if (!response.ok) return { outcome: response.status === 401 || response.status === 403 ? 'rejected' : 'unavailable' }; const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined; const result = body && parsed(provider, body, estimatedCost); return result ? { outcome: 'success', ...result } : { outcome: 'unavailable' } } catch { return { outcome: 'unavailable' } } finally { clearTimeout(timer) }
}

async function configuration(payload: Payload, provider: IntegrationProvider): Promise<StoredConfiguration | undefined> { const result = await payload.find({ collection: 'integration-configurations', where: { provider: { equals: provider } }, limit: 1, depth: 0, overrideAccess: true }); return result.docs[0] as unknown as StoredConfiguration | undefined }
async function reserve(payload: Payload, config: StoredConfiguration, estimatedCost: number, now: Date): Promise<StoredConfiguration | undefined> { const month = monthAt(now); try { return await withPayloadTransaction(payload, async (req) => { const current = await payload.findByID({ collection: 'integration-configurations', id: config.id, depth: 0, overrideAccess: true, req }) as unknown as StoredConfiguration; if (!current.encryptedCredential || current.health === 'revoked') return undefined; const used = current.usageMonth === month ? finiteNonNegative(current.monthlyUsage) : 0; const cap = current.monthlyCap === null || current.monthlyCap === undefined ? undefined : finiteNonNegative(current.monthlyCap); if (cap !== undefined && used + estimatedCost > cap) return undefined; await payload.update({ collection: 'integration-configurations', id: current.id, data: { monthlyUsage: used + estimatedCost, usageMonth: month } as never, overrideAccess: true, req }); return current }) } catch { return undefined } }
async function settle(payload: Payload, config: StoredConfiguration, reserved: number, actual: number, health: 'connected' | 'unavailable' | 'rejected', now: Date): Promise<void> { const month = monthAt(now); await withPayloadTransaction(payload, async (req) => { const current = await payload.findByID({ collection: 'integration-configurations', id: config.id, depth: 0, overrideAccess: true, req }) as unknown as StoredConfiguration; if (!current.encryptedCredential || current.health === 'revoked' || current.encryptedCredential !== config.encryptedCredential || current.credentialFingerprint !== config.credentialFingerprint) return; const used = current.usageMonth === month ? finiteNonNegative(current.monthlyUsage) : 0; const next = health === 'connected' ? Math.max(0, used - reserved + actual) : Math.max(0, used - reserved); await payload.update({ collection: 'integration-configurations', id: current.id, data: { monthlyUsage: next, usageMonth: month, health, testedAt: now.toISOString() } as never, overrideAccess: true, req }) }) }

/** Executes an in-product job from encrypted persisted configuration without exposing credentials or provider diagnostics. */
export async function executeConfiguredAIJob(payload: Payload, job: AIJob, options: { transport?: ProviderFetch; now?: Date; timeoutMs?: number } = {}): Promise<AIJobResult> {
  if (!Number.isFinite(job.estimatedCost) || job.estimatedCost < 0 || !job.input || job.input.length > 100_000) throw new Error('AI_JOB_UNAVAILABLE')
  const now = options.now ?? new Date()
  const attempt = async (provider: IntegrationProvider): Promise<Attempt> => { const config = await configuration(payload, provider); if (!config || !config.encryptedCredential || config.health === 'revoked' || (job.requiresImage && !providerCapabilities[provider].imageInput)) return { outcome: config?.health === 'revoked' ? 'rejected' : 'unavailable' }; const reserved = await reserve(payload, config, job.estimatedCost, now); if (!reserved) return { outcome: 'unavailable' }; let credential: string; try { credential = decryptCredential(reserved.encryptedCredential!, provider) } catch { await settle(payload, reserved, job.estimatedCost, 0, 'rejected', now); return { outcome: 'rejected' } }; const result = await invokeProvider(provider, credential, reserved.model, job.input, job.estimatedCost, options.transport, options.timeoutMs); await settle(payload, reserved, job.estimatedCost, result.outcome === 'success' ? result.usageCost : 0, result.outcome === 'success' ? 'connected' : result.outcome, now); return result }
  const primary = await attempt(job.provider)
  if (primary.outcome === 'success') return { provider: job.provider, fallbackUsed: false, output: primary.output, usageCost: primary.usageCost }
  if (primary.outcome === 'unavailable' && job.fallbackProvider && job.fallbackProvider !== job.provider) { const fallback = await attempt(job.fallbackProvider); if (fallback.outcome === 'success') return { provider: job.fallbackProvider, fallbackUsed: true, output: fallback.output, usageCost: fallback.usageCost } }
  throw new Error('AI_JOB_UNAVAILABLE')
}
