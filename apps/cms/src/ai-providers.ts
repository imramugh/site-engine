import { randomUUID } from 'node:crypto'
import type { Payload, PayloadRequest } from 'payload'
import { decryptCredential, type IntegrationProvider } from './integrations'
import { withPayloadTransaction } from './auth-transaction'

/** Money is always an integer count of one-millionths of a US dollar. */
export type MicroUsd = number
export type AIJob = { provider: IntegrationProvider; fallbackProvider?: IntegrationProvider | null; input: string; requiresImage?: boolean; imageDataUrl?: string; maxOutputTokens: number }
export type AIConfigurationSnapshot = { id: string; provider: IntegrationProvider; model: string; credentialFingerprint: string; monthlyCapMicroUsd: number | null; inputMicroUsdPerMillionTokens: MicroUsd; outputMicroUsdPerMillionTokens: MicroUsd; pricingSource: string; pricingAsOf: string }
export type ProviderCapability = { imageInput: boolean; endpoint: string; auth: 'bearer' | 'x-api-key' }
export const providerCapabilities: Record<IntegrationProvider, ProviderCapability> = {
  // Image request serialization has not been implemented in this adapter yet.
  openai: { imageInput: true, endpoint: 'https://api.openai.com/v1/responses', auth: 'bearer' },
  anthropic: { imageInput: false, endpoint: 'https://api.anthropic.com/v1/messages', auth: 'x-api-key' },
  'google-gemini': { imageInput: false, endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'x-api-key' },
  openrouter: { imageInput: false, endpoint: 'https://openrouter.ai/api/v1/chat/completions', auth: 'bearer' },
}
export type ProviderFetch = (request: Request) => Promise<Response>
export type AIJobResult = { provider: IntegrationProvider; fallbackUsed: boolean; output: string; usageCostMicroUsd: MicroUsd | null; reservedMicroUsd: MicroUsd; usageCostStatus: 'actual' | 'reserved' }
type TokenUsage = { inputTokens: number; outputTokens: number }
type Attempt = { outcome: 'success'; output: string; usage?: TokenUsage } | { outcome: 'unavailable' | 'rejected' | 'snapshot-stale' }
type StoredConfiguration = Record<string, unknown> & { id: string; provider: IntegrationProvider; model: string; encryptedCredential?: string | null; credentialFingerprint?: string | null; monthlyCapMicroUsd?: number | null; monthlyUsageMicroUsd?: number | null; usageMonth?: string | null; health?: string | null; inputMicroUsdPerMillionTokens?: number | null; outputMicroUsdPerMillionTokens?: number | null; pricingSource?: string | null; pricingAsOf?: string | null }
type Pricing = { inputMicroUsdPerMillionTokens: MicroUsd; outputMicroUsdPerMillionTokens: MicroUsd; source: string; asOf: string }
type UsageReservation = Record<string, unknown> & { id: string; configuration: string | { id: string }; executionKey: string; usageMonth: string; reservedMicroUsd: number; settledMicroUsd?: number | null; state: 'reserved' | 'settled' | 'released' }
type Reservation = { id: string; config: StoredConfiguration; pricing: Pricing; reservedMicroUsd: MicroUsd; usageMonth: string }
const SNAPSHOT_STALE = 'AI_JOB_SNAPSHOT_STALE'
const TOKENS_PER_MILLION = 1_000_000n
const MAX_OUTPUT_TOKENS = 8_192
const monthAt = (date: Date) => date.toISOString().slice(0, 7)
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const text = (value: unknown) => typeof value === 'string' ? value : undefined
const sumSafe = (values: unknown[]): number | undefined => { let total = 0; for (const value of values) { const amount = integer(value); if (amount === undefined || !Number.isSafeInteger(total + amount)) return undefined; total += amount } return total }

function pricingFor(config: StoredConfiguration): Pricing | undefined {
  const input = integer(config.inputMicroUsdPerMillionTokens); const output = integer(config.outputMicroUsdPerMillionTokens); const source = text(config.pricingSource); const asOf = text(config.pricingAsOf)
  return input !== undefined && output !== undefined && source && asOf ? { inputMicroUsdPerMillionTokens: input, outputMicroUsdPerMillionTokens: output, source, asOf } : undefined
}
function sameSnapshot(config: StoredConfiguration, snapshot: AIConfigurationSnapshot): boolean {
  const pricing = pricingFor(config)
  return config.id === snapshot.id && config.provider === snapshot.provider && config.model === snapshot.model && config.credentialFingerprint === snapshot.credentialFingerprint && (config.monthlyCapMicroUsd ?? null) === snapshot.monthlyCapMicroUsd && Boolean(config.encryptedCredential) && config.health !== 'revoked' && pricing?.inputMicroUsdPerMillionTokens === snapshot.inputMicroUsdPerMillionTokens && pricing.outputMicroUsdPerMillionTokens === snapshot.outputMicroUsdPerMillionTokens && pricing.source === snapshot.pricingSource && pricing.asOf === snapshot.pricingAsOf
}
function costPartMicroUsd(tokens: number, rate: MicroUsd): MicroUsd | undefined {
  if (!Number.isSafeInteger(tokens) || tokens < 0) return undefined
  const amount = (BigInt(tokens) * BigInt(rate) + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : undefined
}
function costMicroUsd(inputTokens: number, outputTokens: number, pricing: Pricing): MicroUsd | undefined {
  const input = costPartMicroUsd(inputTokens, pricing.inputMicroUsdPerMillionTokens); const output = costPartMicroUsd(outputTokens, pricing.outputMicroUsdPerMillionTokens)
  if (input === undefined || output === undefined) return undefined
  const total = BigInt(input) + BigInt(output)
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : undefined
}
function requestBody(provider: IntegrationProvider, model: string, input: string, maxOutputTokens: number, imageDataUrl?: string): Record<string, unknown> {
  if (provider === 'openai') return { model, max_output_tokens: maxOutputTokens, input: [{ role: 'user', content: [{ type: 'input_text', text: input }, ...(imageDataUrl ? [{ type: 'input_image', image_url: imageDataUrl }] : [])] }] }
  if (provider === 'anthropic') return { model, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: input }] }
  if (provider === 'google-gemini') return { contents: [{ role: 'user', parts: [{ text: input }] }], generationConfig: { maxOutputTokens } }
  return { model, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: input }] }
}
// The reservation includes serialized JSON framing and the requested completion budget.
// Providers can bill internal reasoning beyond visible text; unreported usage retains the full reservation.
function reservedInputTokens(provider: IntegrationProvider, model: string, input: string, maxOutputTokens: number): number { return Buffer.byteLength(JSON.stringify(requestBody(provider, model, input, maxOutputTokens)), 'utf8') }
function requestFor(provider: IntegrationProvider, credential: string, model: string, input: string, maxOutputTokens: number, imageDataUrl?: string, signal?: AbortSignal): Request {
  const body = JSON.stringify(requestBody(provider, model, input, maxOutputTokens, imageDataUrl))
  if (provider === 'openai') return new Request(providerCapabilities.openai.endpoint, { method: 'POST', signal, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body })
  if (provider === 'anthropic') return new Request(providerCapabilities.anthropic.endpoint, { method: 'POST', signal, headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body })
  if (provider === 'google-gemini') return new Request(`${providerCapabilities['google-gemini'].endpoint}/${encodeURIComponent(model)}:generateContent`, { method: 'POST', signal, headers: { 'x-goog-api-key': credential, 'content-type': 'application/json' }, body })
  return new Request(providerCapabilities.openrouter.endpoint, { method: 'POST', signal, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body })
}
function usage(input: unknown, output: unknown): TokenUsage | undefined { const inputTokens = integer(input); const outputTokens = integer(output); return inputTokens !== undefined && outputTokens !== undefined ? { inputTokens, outputTokens } : undefined }
function geminiUsage(details: Record<string, unknown> | undefined): TokenUsage | undefined {
  const inputTokens = integer(details?.promptTokenCount); const candidates = integer(details?.candidatesTokenCount)
  if (inputTokens === undefined || candidates === undefined) return undefined
  if (details?.thoughtsTokenCount === undefined) return { inputTokens, outputTokens: candidates }
  const thoughts = integer(details.thoughtsTokenCount)
  if (thoughts === undefined || !Number.isSafeInteger(candidates + thoughts)) return undefined
  return { inputTokens, outputTokens: candidates + thoughts }
}
function parsed(provider: IntegrationProvider, body: Record<string, unknown>): { output: string; usage?: TokenUsage } | undefined {
  if (provider === 'openai') { const output = Array.isArray(body.output) ? body.output.filter((item) => (item as Record<string, unknown>).type === 'message').flatMap((item) => Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content : []).filter((part) => (part as Record<string, unknown>).type === 'output_text').map((part) => text((part as Record<string, unknown>).text)).filter(Boolean).join('') : ''; const details = body.usage as Record<string, unknown> | undefined; return output ? { output, usage: usage(details?.input_tokens, details?.output_tokens) } : undefined }
  if (provider === 'anthropic') { const output = Array.isArray(body.content) ? body.content.filter((part) => (part as Record<string, unknown>).type === 'text').map((part) => text((part as Record<string, unknown>).text)).filter(Boolean).join('') : ''; const details = body.usage as Record<string, unknown> | undefined; return output ? { output, usage: usage(details?.input_tokens, details?.output_tokens) } : undefined }
  if (provider === 'google-gemini') { const candidate = Array.isArray(body.candidates) ? body.candidates[0] as Record<string, unknown> | undefined : undefined; const content = candidate?.content as Record<string, unknown> | undefined; const output = Array.isArray(content?.parts) ? content.parts.filter((part) => (part as Record<string, unknown>).thought !== true).map((part) => text((part as Record<string, unknown>).text)).filter(Boolean).join('') : ''; const details = body.usageMetadata as Record<string, unknown> | undefined; return output ? { output, usage: geminiUsage(details) } : undefined }
  const choice = Array.isArray(body.choices) ? body.choices[0] as Record<string, unknown> | undefined : undefined; const message = choice?.message as Record<string, unknown> | undefined; const output = text(message?.content); const details = body.usage as Record<string, unknown> | undefined
  return output ? { output, usage: usage(details?.prompt_tokens, details?.completion_tokens) } : undefined
}
/** Builds bounded provider requests and normalizes provider token counts; provider-reported money is deliberately ignored. */
export async function invokeProvider(provider: IntegrationProvider, credential: string, model: string, input: string, maxOutputTokens: number, transport: ProviderFetch = fetch, timeoutMs = 15_000, imageDataUrl?: string): Promise<Attempt> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, timeoutMs) })
  try {
    const response = await Promise.race([transport(requestFor(provider, credential, model, input, maxOutputTokens, imageDataUrl, controller.signal)), deadline])
    if (!response.ok) return { outcome: response.status === 401 || response.status === 403 ? 'rejected' : 'unavailable' }
    const body = await Promise.race([response.json(), deadline]).catch(() => undefined) as Record<string, unknown> | undefined
    const result = body && parsed(provider, body)
    return result ? { outcome: 'success', ...result } : { outcome: 'unavailable' }
  } catch { return { outcome: 'unavailable' } } finally { if (timer) clearTimeout(timer) }
}
async function configuration(
  payload: Payload,
  provider: IntegrationProvider,
): Promise<StoredConfiguration | undefined> {
  const result = await payload.find({
    collection: "integration-configurations",
    where: { provider: { equals: provider } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  });
  return result.docs[0] as unknown as StoredConfiguration | undefined;
}
async function periodReservations(
  payload: Payload,
  req: PayloadRequest,
  configuration: string,
  usageMonth: string,
): Promise<UsageReservation[] | undefined> {
  const rows: UsageReservation[] = [];
  let page = 1;
  while (true) {
    const result = await payload.find({
      collection: "provider-usage-reservations",
      where: {
        and: [
          { configuration: { equals: configuration } },
          { usageMonth: { equals: usageMonth } },
        ],
      },
      depth: 0,
      limit: 100,
      page,
      overrideAccess: true,
      req,
    });
    rows.push(...(result.docs as unknown as UsageReservation[]));
    if (!result.hasNextPage) return rows;
    page += 1;
    if (page > 100_000) return undefined;
  }
}
function periodTotal(rows: UsageReservation[]): MicroUsd | undefined {
  return sumSafe(
    rows.map((row) =>
      row.state === "reserved"
        ? row.reservedMicroUsd
        : row.state === "settled"
          ? row.settledMicroUsd
          : 0,
    ),
  );
}
async function projectPeriod(
  payload: Payload,
  req: PayloadRequest,
  config: StoredConfiguration,
  usageMonth: string,
): Promise<void> {
  if (config.usageMonth !== usageMonth) return;
  const rows = await periodReservations(payload, req, config.id, usageMonth);
  const total = rows && periodTotal(rows);
  if (total === undefined) throw new Error("AI_JOB_ACCOUNTING_UNAVAILABLE");
  await payload.update({
    collection: "integration-configurations",
    id: config.id,
    data: { monthlyUsageMicroUsd: total, usageMonth } as never,
    overrideAccess: true,
    req,
    context: { providerUsageLifecycle: true },
  });
}
async function reserve(
  payload: Payload,
  configID: string,
  provider: IntegrationProvider,
  job: AIJob,
  now: Date,
  snapshot?: AIConfigurationSnapshot,
  executionKey?: string,
): Promise<Reservation | 'snapshot-stale' | undefined> {
  const usageMonth = monthAt(now);
  try {
    return await withPayloadTransaction(payload, async (req) => {
      const current = (await payload.findByID({
        collection: "integration-configurations",
        id: configID,
        depth: 0,
        overrideAccess: true,
        req,
      })) as unknown as StoredConfiguration;
      if (snapshot && !sameSnapshot(current, snapshot)) throw new Error(SNAPSHOT_STALE)
      if (
        current.provider !== provider ||
        !current.encryptedCredential ||
        current.health === "revoked"
      )
        return undefined;
      const pricing = pricingFor(current);
      if (!pricing) return undefined;
      const requestInputTokens = reservedInputTokens(
        provider,
        current.model,
        job.input,
        job.maxOutputTokens,
      );
      const reservedMicroUsd = costMicroUsd(
        requestInputTokens,
        job.maxOutputTokens,
        pricing,
      );
      const cap =
        current.monthlyCapMicroUsd === null ||
        current.monthlyCapMicroUsd === undefined
          ? undefined
          : integer(current.monthlyCapMicroUsd);
      const rows = await periodReservations(
        payload,
        req,
        current.id,
        usageMonth,
      );
      const used = rows && periodTotal(rows);
      if (
        reservedMicroUsd === undefined ||
        used === undefined ||
        (current.monthlyCapMicroUsd !== null &&
          current.monthlyCapMicroUsd !== undefined &&
          cap === undefined) ||
        !Number.isSafeInteger(used + reservedMicroUsd) ||
        (cap !== undefined && used + reservedMicroUsd > cap)
      )
        return undefined;
      const key = executionKey ?? randomUUID();
      const prior = await payload.find({ collection: 'provider-usage-reservations', where: { executionKey: { equals: key } }, limit: 1, depth: 0, overrideAccess: true, req })
      if (prior.docs[0]) {
        const row = prior.docs[0] as unknown as UsageReservation
        if (row.configuration !== current.id || row.state !== 'reserved') return undefined
        return { id: row.id, config: current, pricing, reservedMicroUsd: row.reservedMicroUsd, usageMonth: row.usageMonth }
      }
      const row = (await payload.create({
        collection: "provider-usage-reservations",
        data: {
          configuration: current.id,
          executionKey: key,
          usageMonth,
          reservedMicroUsd,
          state: "reserved",
          configModel: current.model,
          credentialFingerprint: current.credentialFingerprint ?? null,
          inputMicroUsdPerMillionTokens: pricing.inputMicroUsdPerMillionTokens,
          outputMicroUsdPerMillionTokens:
            pricing.outputMicroUsdPerMillionTokens,
          pricingSource: pricing.source,
          pricingAsOf: pricing.asOf,
          requestInputTokens,
          maxOutputTokens: job.maxOutputTokens,
        } as never,
        overrideAccess: true,
        req,
        context: { providerUsageLifecycle: true },
      })) as unknown as UsageReservation;
      await payload.update({
        collection: "integration-configurations",
        id: current.id,
        data: {
          monthlyUsageMicroUsd: used + reservedMicroUsd,
          usageMonth,
        } as never,
        overrideAccess: true,
        req,
        context: { providerUsageLifecycle: true },
      });
      return {
        id: row.id,
        config: current,
        pricing,
        reservedMicroUsd,
        usageMonth,
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === SNAPSHOT_STALE) return 'snapshot-stale'
    return undefined;
  }
}
async function settle(
  payload: Payload,
  reservation: Reservation,
  actualMicroUsd: MicroUsd | undefined,
  health: "connected" | "unavailable" | "rejected",
  now: Date,
): Promise<void> {
  await withPayloadTransaction(payload, async (req) => {
    const row = (await payload.findByID({
      collection: "provider-usage-reservations",
      id: reservation.id,
      depth: 0,
      overrideAccess: true,
      req,
    })) as unknown as UsageReservation;
    if (
      row.state !== "reserved" ||
      row.usageMonth !== reservation.usageMonth ||
      row.executionKey.length < 1
    )
      return;
    // A rejected credential is the only outcome known not to be billable. A
    // timeout, malformed body, or missing usage stays reserved rather than being
    // recorded as an observed charge.
    if (health === "rejected" || actualMicroUsd !== undefined) {
      const charge = health === "rejected" ? 0 : actualMicroUsd;
      if (integer(charge) === undefined)
        throw new Error("AI_JOB_ACCOUNTING_UNAVAILABLE");
      await payload.update({
        collection: "provider-usage-reservations",
        id: row.id,
        data: {
          state: health === "rejected" ? "released" : "settled",
          settledMicroUsd: charge,
        } as never,
        overrideAccess: true,
        req,
        context: { providerUsageLifecycle: true },
      });
    }
    const current = (await payload.findByID({
      collection: "integration-configurations",
      id: reservation.config.id,
      depth: 0,
      overrideAccess: true,
      req,
    })) as unknown as StoredConfiguration;
    await projectPeriod(payload, req, current, reservation.usageMonth);
    if (
      current.encryptedCredential === reservation.config.encryptedCredential &&
      current.credentialFingerprint ===
        reservation.config.credentialFingerprint &&
      current.health !== "revoked"
    )
      await payload.update({
        collection: "integration-configurations",
        id: current.id,
        data: { health, testedAt: now.toISOString() } as never,
        overrideAccess: true,
        req,
        context: { providerUsageLifecycle: true },
      });
  });
}
/** Executes an in-product job from encrypted persisted configuration without exposing credentials or provider diagnostics. */
export async function executeConfiguredAIJob(payload: Payload, job: AIJob, options: { transport?: ProviderFetch; now?: Date; timeoutMs?: number; configurationSnapshot?: AIConfigurationSnapshot[]; executionKey?: (provider: IntegrationProvider) => string } = {}): Promise<AIJobResult> {
  if (!job.input || job.input.length > 100_000 || !Number.isSafeInteger(job.maxOutputTokens) || job.maxOutputTokens < 1 || job.maxOutputTokens > MAX_OUTPUT_TOKENS) throw new Error('AI_JOB_UNAVAILABLE')
  const now = options.now ?? new Date()
  const attempt = async (provider: IntegrationProvider): Promise<Attempt & { usageCostMicroUsd?: MicroUsd | null; reservedMicroUsd?: MicroUsd; usageCostStatus?: 'actual' | 'reserved' }> => {
    // AIJob has no image bytes or media reference. Sending text would silently downgrade an image job.
    if (job.requiresImage && !providerCapabilities[provider].imageInput) return { outcome: 'unavailable' }
    const snapshot = options.configurationSnapshot?.find(candidate => candidate.provider === provider)
    if (options.configurationSnapshot && !snapshot) return { outcome: 'rejected' }
    const config = snapshot ? await payload.findByID({ collection: 'integration-configurations', id: snapshot.id, depth: 0, overrideAccess: true }) as unknown as StoredConfiguration : await configuration(payload, provider)
    if (snapshot && (!config || !sameSnapshot(config, snapshot))) return { outcome: 'snapshot-stale' }
    if (!config || !config.encryptedCredential || config.health === 'revoked') return { outcome: config?.health === 'revoked' ? 'rejected' : 'unavailable' }
    const reservation = await reserve(payload, config.id, provider, job, now, snapshot, options.executionKey?.(provider))
    if (reservation === 'snapshot-stale') return { outcome: 'snapshot-stale' }
    if (!reservation) return { outcome: 'unavailable' }
    let credential: string
    try { credential = decryptCredential(reservation.config.encryptedCredential!, provider) } catch { await settle(payload, reservation, undefined, 'rejected', now); return { outcome: 'rejected' } }
    const result = await invokeProvider(provider, credential, reservation.config.model, job.input, job.maxOutputTokens, options.transport, options.timeoutMs, job.imageDataUrl)
    const actualMicroUsd = result.outcome === 'success' && result.usage ? costMicroUsd(result.usage.inputTokens, result.usage.outputTokens, reservation.pricing) : undefined
    await settle(payload, reservation, actualMicroUsd, result.outcome === 'success' ? 'connected' : result.outcome === 'rejected' ? 'rejected' : 'unavailable', now)
    return result.outcome === 'success' ? { ...result, usageCostMicroUsd: actualMicroUsd ?? null, reservedMicroUsd: reservation.reservedMicroUsd, usageCostStatus: actualMicroUsd === undefined ? 'reserved' : 'actual' } : { ...result, reservedMicroUsd: result.outcome === 'unavailable' ? reservation.reservedMicroUsd : 0, usageCostMicroUsd: null, usageCostStatus: result.outcome === 'unavailable' ? 'reserved' : 'actual' }
  }
  const primary = await attempt(job.provider)
  if (primary.outcome === 'success') return { provider: job.provider, fallbackUsed: false, output: primary.output, usageCostMicroUsd: primary.usageCostMicroUsd!, reservedMicroUsd: primary.reservedMicroUsd!, usageCostStatus: primary.usageCostStatus! }
  if (primary.outcome === 'unavailable' && job.fallbackProvider && job.fallbackProvider !== job.provider) {
    const fallback = await attempt(job.fallbackProvider)
    if (fallback.outcome === 'success') {
      const reservedMicroUsd = sumSafe([primary.reservedMicroUsd ?? 0, fallback.reservedMicroUsd])
      if (reservedMicroUsd === undefined) throw new Error('AI_JOB_UNAVAILABLE')
      // The primary timeout remains billable until reconciled, so the job total
      // is reserved even when the fallback reported exact usage.
      return { provider: job.fallbackProvider, fallbackUsed: true, output: fallback.output, usageCostMicroUsd: primary.reservedMicroUsd ? null : fallback.usageCostMicroUsd!, reservedMicroUsd, usageCostStatus: primary.reservedMicroUsd ? 'reserved' : fallback.usageCostStatus! }
    }
  }
  throw new Error('AI_JOB_UNAVAILABLE')
}
