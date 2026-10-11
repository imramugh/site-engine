'use client'

import { useEffect, useRef, useState } from 'react'

type Provider = 'openai' | 'anthropic' | 'google-gemini' | 'openrouter' | 'azure-openai' | 'amazon-bedrock' | 'mistral' | 'openai-compatible'
type Result = { output: string; reservedMicroUsd: number; usageCostMicroUsd: number | null; costStatus: 'actual' | 'reserved'; usedProvider: Provider; fallbackUsed: boolean }
type Job = { id: string; provider: Provider; fallbackProvider: Provider | null; maxOutputTokens: number; state: string; costStatus: 'actual' | 'reserved' | null; usedProvider: Provider | null; fallbackUsed: boolean; failureCode: string | null; result: Result | null; createdAt: string }
type RequestIntent = { provider: Provider; fallbackProvider: string; prompt: string; maxOutputTokens: number; key: string }
const providers: Provider[] = ['openai', 'anthropic', 'google-gemini', 'openrouter', 'azure-openai', 'amazon-bedrock', 'mistral', 'openai-compatible']

const newKey = () => globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${Date.now()}${Math.random().toString(36).slice(2)}`
const money = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(6)}`
const sameIntent = (left: RequestIntent, right: Omit<RequestIntent, 'key'>) => left.provider === right.provider && left.fallbackProvider === right.fallbackProvider && left.prompt === right.prompt && left.maxOutputTokens === right.maxOutputTokens

export function AIJobConsole() {
  const [jobs, setJobs] = useState<Job[]>([]); const [provider, setProvider] = useState<Provider>('openai'); const [fallbackProvider, setFallbackProvider] = useState(''); const [prompt, setPrompt] = useState(''); const [maxOutputTokens, setMaxOutputTokens] = useState('512'); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(true); const [submitting, setSubmitting] = useState(false); const pending = useRef<RequestIntent | null>(null)
  const load = async (preserveMessage = false) => { setLoading(true); try { const response = await fetch('/api/ai-jobs', { cache: 'no-store' }); if (!response.ok) { setMessage(response.status === 403 ? 'Owner access is required to view AI jobs.' : 'Unable to load AI jobs.'); return }; setJobs((await response.json() as { jobs: Job[] }).jobs); if (!preserveMessage) setMessage('') } catch { setMessage('Unable to load AI jobs.') } finally { setLoading(false) } }
  useEffect(() => { void load() }, [])
  const startNew = () => { pending.current = null; setMessage('Ready to queue a new request. A prior request may still be queued.') }
  const changeProvider = (next: Provider) => { setProvider(next); if (fallbackProvider === next) setFallbackProvider('') }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (submitting) return
    const tokens = Number(maxOutputTokens); const intent = { provider, fallbackProvider, prompt, maxOutputTokens: tokens }
    if (!prompt.trim() || prompt.length > 100_000 || new TextEncoder().encode(prompt).byteLength > 100_000 || !Number.isSafeInteger(tokens) || tokens < 1 || tokens > 8192) { setMessage('Enter a prompt up to 100,000 bytes and 1–8,192 output tokens.'); return }
    if (pending.current && !sameIntent(pending.current, intent)) { setMessage('This form changed after a request attempt. Choose Start a new request before queuing these changes.'); return }
    const request = pending.current ?? { ...intent, key: newKey() }; pending.current = request; setSubmitting(true)
    try {
      const response = await fetch('/api/ai-jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: request.provider, fallbackProvider: request.fallbackProvider || null, input: request.prompt, maxOutputTokens: request.maxOutputTokens, idempotencyKey: request.key }) })
      const body = await response.json() as { error?: string; job?: { created?: boolean } }
      if (!response.ok) { setMessage(body.error ?? 'The job could not be queued. Retry preserves this request.'); return }
      setMessage(body.job?.created ? 'Generation queued.' : 'This request was already queued.'); pending.current = null; setPrompt(''); await load(true)
    } catch { setMessage('The job could not be queued. Retry preserves this request.') } finally { setSubmitting(false) }
  }
  return <main><h1>AI generation</h1><p>Queue a bounded text-generation test.</p><p role="status" aria-live="polite">{loading ? 'Loading AI jobs…' : message}</p>
    <form onSubmit={event => void submit(event)}><fieldset disabled={submitting}><legend>Queue generation</legend><label htmlFor="ai-provider">Provider</label><select id="ai-provider" value={provider} onChange={event => changeProvider(event.target.value as Provider)}>{providers.map(item => <option key={item} value={item}>{item}</option>)}</select><label htmlFor="ai-fallback">Fallback provider</label><select id="ai-fallback" value={fallbackProvider} onChange={event => setFallbackProvider(event.target.value)}><option value="">No fallback</option>{providers.filter(item => item !== provider).map(item => <option key={item} value={item}>{item}</option>)}</select><label htmlFor="ai-prompt">Prompt</label><textarea id="ai-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={100000} required /><label htmlFor="ai-max-output">Maximum output tokens</label><input id="ai-max-output" type="number" min="1" max="8192" step="1" value={maxOutputTokens} onChange={event => setMaxOutputTokens(event.target.value)} required /><button type="submit">Queue generation</button><button type="button" disabled={submitting} onClick={startNew}>Start a new request</button><button type="button" disabled={submitting} onClick={() => void load(true)}>Refresh jobs</button></fieldset></form>
    <section aria-label="AI jobs"><h2>My AI jobs</h2>{!loading && jobs.length === 0 ? <p>No generation jobs have been queued.</p> : <ul>{jobs.map(job => <li key={job.id}><strong>{job.state}</strong> · requested {job.provider}{job.fallbackProvider ? ` with ${job.fallbackProvider} fallback` : ''} · maximum {job.maxOutputTokens} tokens · <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>{job.failureCode && <p>Stopped safely: {job.failureCode}</p>}{job.state === 'manual-review' && <p>Cost awaiting reconciliation.</p>}{job.result && <><p>Completed by {job.result.usedProvider}{job.result.fallbackUsed ? ' using fallback' : ''}. {job.result.usageCostMicroUsd === null ? `Held reservation: ${money(job.result.reservedMicroUsd)}.` : `Actual cost: ${money(job.result.usageCostMicroUsd)}; reserved: ${money(job.result.reservedMicroUsd)}.`}</p><output aria-label={`Result ${job.id}`}>{job.result.output}</output></>}</li>)}</ul>}</section>
  </main>
}
