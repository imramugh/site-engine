'use client'

import { useEffect, useState } from 'react'

type Provider = 'openai' | 'anthropic' | 'google-gemini' | 'openrouter'
type Integration = { id: string; provider: Provider; model: string | null; fallbackProvider: Provider | null; monthlyCapMicroUsd: number | null; monthlyUsageMicroUsd: number; usageMonth: string | null; health: string; testedAt: string | null; credentialConfigured: boolean; credentialHint: string | null }
const providers: Provider[] = ['openai', 'anthropic', 'google-gemini', 'openrouter']
const formatTestedAt = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return value ? 'recorded time unavailable' : ''
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto', timeZoneName: 'short' }).format(new Date(value))
}

export function IntegrationConfiguration() {
  const [items, setItems] = useState<Integration[]>([]); const [provider, setProvider] = useState<Provider>('openai'); const [model, setModel] = useState(''); const [credential, setCredential] = useState(''); const [monthlyCapMicroUsd, setMonthlyCapMicroUsd] = useState(''); const [inputRate, setInputRate] = useState(''); const [outputRate, setOutputRate] = useState(''); const [pricingSource, setPricingSource] = useState(''); const [pricingAsOf, setPricingAsOf] = useState(''); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [testing, setTesting] = useState<Provider | null>(null)
  const load = async (preserveMessage = false) => {
    setLoading(true)
    try { const response = await fetch('/api/integrations', { cache: 'no-store' }); if (!response.ok) { setMessage(response.status === 403 ? 'Owner access is required to manage integrations.' : 'Unable to load integration configuration.'); return }; setItems((await response.json() as { integrations: Integration[] }).integrations); if (!preserveMessage) setMessage('') }
    catch { setMessage('Unable to load integration configuration.') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (saving) return; setSaving(true)
    try { const response = await fetch('/api/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'configure', provider, model, credential, fallbackProvider: null, monthlyCapMicroUsd: monthlyCapMicroUsd === '' ? null : Number(monthlyCapMicroUsd), inputMicroUsdPerMillionTokens: Number(inputRate), outputMicroUsdPerMillionTokens: Number(outputRate), pricingSource, pricingAsOf }) }); const body = await response.json() as { error?: string }; if (!response.ok) setMessage(body.error ?? 'Configuration could not be saved.'); else { setCredential(''); setMessage('Credential rotation and reviewed pricing saved. The credential is not shown after saving.'); await load(true) } }
    catch { setMessage('Configuration could not be saved.') } finally { setSaving(false) }
  }
  const revoke = async (selected: Provider) => {
    if (saving) return; setSaving(true)
    try { const response = await fetch('/api/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'revoke', provider: selected }) }); if (!response.ok) setMessage('Credential revocation could not be completed.'); else { setMessage('Credential revoked.'); await load(true) } }
    catch { setMessage('Credential revocation could not be completed.') } finally { setSaving(false) }
  }
  const test = async (selected: Provider) => {
    if (saving || testing) return; setTesting(selected); setMessage('')
    try {
      const response = await fetch('/api/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test', provider: selected }) })
      const body = await response.json() as { integration?: Integration; error?: string }
      if (!response.ok || !body.integration) { setMessage(response.status === 403 ? 'A fresh Owner sign-in is required before testing a connection.' : 'Connection test could not be completed. Provider details are not displayed.') }
      else {
        const testedAt = formatTestedAt(body.integration.testedAt) || 'recorded time unavailable'
        setMessage(body.integration.health === 'connected' ? `Connection confirmed at ${testedAt}.` : `Connection could not be confirmed at ${testedAt}. Provider details are not displayed.`)
        await load(true)
      }
    }
    catch { setMessage('Connection test could not be completed. Provider details are not displayed.') } finally { setTesting(null) }
  }
  return <main><h1>Integrations</h1><p>Manage provider metadata and rotate credentials. Provider jobs use encrypted credentials only at execution time; saving never contacts an external provider.</p><p>Testing a connection is an explicit Owner action. It requires a fresh sign-in and uses a bounded, non-billable metadata request; credentials and provider response details are never shown here.</p><p><a href="/ai-jobs">Queue and inspect AI generation jobs</a></p><p role="status" aria-live="polite">{loading ? 'Loading integration configuration…' : message}</p>
    <section aria-label="Configured integrations"><h2>Configured integrations</h2>{items.length === 0 ? <p>No provider credentials are configured.</p> : <ul>{items.map((item) => { const testedAt = formatTestedAt(item.testedAt); return <li key={item.id}><strong>{item.provider}</strong> — {item.credentialHint ?? 'No credential'}; health: {item.health}{testedAt ? `; last tested: ${testedAt}` : ''}; usage: {item.monthlyUsageMicroUsd} micro-USD{item.monthlyCapMicroUsd === null ? '' : ` of ${item.monthlyCapMicroUsd} micro-USD`}{item.usageMonth ? ` (${item.usageMonth})` : ''}. <button type="button" disabled={saving || Boolean(testing) || !item.credentialConfigured} onClick={() => void test(item.provider)}>{testing === item.provider ? 'Testing connection…' : 'Test connection'}</button> <button type="button" disabled={saving || Boolean(testing) || !item.credentialConfigured} onClick={() => void revoke(item.provider)}>Revoke credential</button></li> })}</ul>}</section>
    <form onSubmit={(event) => void save(event)}><fieldset disabled={saving}><legend>Configure provider and rotate credential</legend><label htmlFor="integration-provider">Provider</label><select id="integration-provider" value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>{providers.map((item) => <option key={item} value={item}>{item}</option>)}</select><label htmlFor="integration-model">Model</label><input id="integration-model" value={model} onChange={(event) => setModel(event.target.value)} required maxLength={160} /><label htmlFor="integration-credential">Credential</label><input id="integration-credential" type="password" value={credential} onChange={(event) => setCredential(event.target.value)} required autoComplete="new-password" /><label htmlFor="integration-input-rate">Input micro-USD per million tokens</label><input id="integration-input-rate" type="number" min="0" step="1" value={inputRate} onChange={(event) => setInputRate(event.target.value)} required /><label htmlFor="integration-output-rate">Output micro-USD per million tokens</label><input id="integration-output-rate" type="number" min="0" step="1" value={outputRate} onChange={(event) => setOutputRate(event.target.value)} required /><label htmlFor="integration-pricing-source">Reviewed pricing source</label><input id="integration-pricing-source" value={pricingSource} onChange={(event) => setPricingSource(event.target.value)} required maxLength={500} /><label htmlFor="integration-pricing-as-of">Pricing as of</label><input id="integration-pricing-as-of" type="date" value={pricingAsOf} onChange={(event) => setPricingAsOf(event.target.value)} required /><label htmlFor="integration-cap">Monthly cap in micro-USD</label><input id="integration-cap" type="number" min="0" step="1" value={monthlyCapMicroUsd} onChange={(event) => setMonthlyCapMicroUsd(event.target.value)} /><p>Rates and caps are whole micro-USD values. Review and enter the configured model’s input and output price; jobs fail closed when pricing is unavailable. The credential is write-only and is never displayed, exported, or included in audit history.</p><button type="submit">Save provider configuration</button></fieldset></form>
  </main>
}
