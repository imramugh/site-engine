'use client'

import { useEffect, useState } from 'react'

type Provider = 'openai' | 'anthropic' | 'google-gemini' | 'openrouter'
type Integration = { id: string; provider: Provider; model: string | null; fallbackProvider: Provider | null; monthlyCap: number | null; monthlyUsage: number; usageMonth: string | null; health: string; testedAt: string | null; credentialConfigured: boolean; credentialHint: string | null }
const providers: Provider[] = ['openai', 'anthropic', 'google-gemini', 'openrouter']

export function IntegrationConfiguration() {
  const [items, setItems] = useState<Integration[]>([]); const [provider, setProvider] = useState<Provider>('openai'); const [model, setModel] = useState(''); const [credential, setCredential] = useState(''); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false)
  const load = async (preserveMessage = false) => {
    setLoading(true)
    try { const response = await fetch('/api/integrations', { cache: 'no-store' }); if (!response.ok) { setMessage(response.status === 403 ? 'Owner access is required to manage integrations.' : 'Unable to load integration configuration.'); return }; setItems((await response.json() as { integrations: Integration[] }).integrations); if (!preserveMessage) setMessage('') }
    catch { setMessage('Unable to load integration configuration.') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (saving) return; setSaving(true)
    try { const response = await fetch('/api/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'configure', provider, model, credential, fallbackProvider: null, monthlyCap: null }) }); const body = await response.json() as { error?: string }; if (!response.ok) setMessage(body.error ?? 'Configuration could not be saved.'); else { setCredential(''); setMessage('Credential rotation saved. The credential is not shown after saving.'); await load(true) } }
    catch { setMessage('Configuration could not be saved.') } finally { setSaving(false) }
  }
  const revoke = async (selected: Provider) => {
    if (saving) return; setSaving(true)
    try { const response = await fetch('/api/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'revoke', provider: selected }) }); if (!response.ok) setMessage('Credential revocation could not be completed.'); else { setMessage('Credential revoked.'); await load(true) } }
    catch { setMessage('Credential revocation could not be completed.') } finally { setSaving(false) }
  }
  return <main><h1>Integrations</h1><p>Manage provider metadata and rotate credentials. Provider jobs use encrypted credentials only at execution time; saving never contacts an external provider.</p><p role="status" aria-live="polite">{loading ? 'Loading integration configuration…' : message}</p>
    <section aria-label="Configured integrations"><h2>Configured integrations</h2>{items.length === 0 ? <p>No provider credentials are configured.</p> : <ul>{items.map((item) => <li key={item.id}><strong>{item.provider}</strong> — {item.credentialHint ?? 'No credential'}; health: {item.health}; usage: {item.monthlyUsage}{item.monthlyCap === null ? ' units' : ` of ${item.monthlyCap} units`}{item.usageMonth ? ` (${item.usageMonth})` : ''}. <button type="button" disabled={saving || !item.credentialConfigured} onClick={() => void revoke(item.provider)}>Revoke credential</button></li>)}</ul>}</section>
    <form onSubmit={(event) => void save(event)}><fieldset disabled={saving}><legend>Rotate provider credential</legend><label htmlFor="integration-provider">Provider</label><select id="integration-provider" value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>{providers.map((item) => <option key={item} value={item}>{item}</option>)}</select><label htmlFor="integration-model">Model</label><input id="integration-model" value={model} onChange={(event) => setModel(event.target.value)} required maxLength={160} /><label htmlFor="integration-credential">Credential</label><input id="integration-credential" type="password" value={credential} onChange={(event) => setCredential(event.target.value)} required autoComplete="new-password" /><p>The credential is write-only and is never displayed, exported, or included in audit history.</p><button type="submit">Save credential rotation</button></fieldset></form>
  </main>
}
