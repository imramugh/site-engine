'use client'

import { useCallback, useEffect, useState } from 'react'

type Change = { collection: string; id: string; before: unknown; after: unknown }
type Set = { id: string; name: string; state: string; revision: number; actor?: string; changes?: Change[]; quality?: { checks?: { name: string; status: string; errors?: { message: string }[] }[]; warnings?: string[] }; staleAt?: string }
type Data = { sets: Set[]; actor: { id: string; roles: string[] } }
function fields(change: Change): [string, unknown, unknown][] {
  const before = change.before && typeof change.before === 'object' ? change.before as Record<string, unknown> : {}
  const after = change.after && typeof change.after === 'object' ? change.after as Record<string, unknown> : {}
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map((key) => [key, before[key], after[key]])
}

export function EditorialWorkflow() {
  const [data, setData] = useState<Data | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/editorial/list', { cache: 'no-store' })
      if (!response.ok) { setMessage('Sign in to view editorial change sets.'); return }
      const next = await response.json() as Data
      setData(next); setSelected((current) => current ?? next.sets[0]?.id ?? null)
    } catch {
      setMessage('Unable to load editorial change sets. Try again.')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  const set = data?.sets.find((item) => item.id === selected)
  const reviewer = Boolean(data?.actor.roles.some((role) => role === 'owner' || role === 'approver'))
  const owns = Boolean(set && data?.actor.id === set.actor)
  async function action(action: string) {
    if (!set || acting) return
    setActing(true)
    setMessage('')
    try {
      const response = await fetch(`/api/editorial/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: set.id }) })
      const body = await response.json() as { error?: string }
      if (!response.ok) { setMessage(body.error ?? 'The workflow action was not accepted.'); return }
      setMessage(action === 'submit' ? 'Submitted. Preview generation is pending.' : 'Change set updated.')
      await load()
    } catch {
      setMessage('Unable to update the change set. Try again.')
    } finally {
      setActing(false)
    }
  }
  return <main style={{ maxWidth: 1100, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }} aria-busy={loading || acting}>
    <h1>Pending changes</h1>
    <p>Draft edits remain private. Approval and publication are unavailable in this phase.</p>
    <p role="status" aria-live="polite">{message || (loading ? 'Loading change sets…' : '')}</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))', gap: '2rem' }}>
      <nav aria-label="Change sets"><h2>Change sets</h2>{data?.sets.map((item) => <button key={item.id} onClick={() => setSelected(item.id)} aria-pressed={selected === item.id} style={{ display: 'block', width: '100%', textAlign: 'left', margin: '0.5rem 0', overflowWrap: 'anywhere' }}>{item.name} — {item.state}</button>)}{!loading && data?.sets.length === 0 && <p>No pending change sets.</p>}</nav>
      {set && <section aria-label="Change set detail"><h2>{set.name}</h2><p>State: <strong>{set.state}</strong></p>
        {set.state === 'stale' && <p role="alert">This change set is stale. Refresh it before review.</p>}
        <div aria-label="Workflow actions">
          {owns && (set.state === 'open' || set.state === 'changes-requested') && <button disabled={acting} onClick={() => action('submit')}>Submit for review</button>}
          {reviewer && set.state === 'submitted' && <><button disabled={acting} onClick={() => action('request-changes')}>Request changes</button><button disabled={acting} onClick={() => action('reject')}>Reject</button></>}
          {owns && (set.state === 'open' || set.state === 'changes-requested' || set.state === 'stale') && <button disabled={acting} onClick={() => action('refresh')}>Refresh</button>}
          {owns && (set.state === 'open' || set.state === 'changes-requested' || set.state === 'rejected') && <button disabled={acting} onClick={() => action('discard')}>Discard</button>}
        </div>
        <h3>Field diffs</h3>
        {set.changes?.map((change) => <article key={`${change.collection}-${change.id}`}><h4>{change.collection} {change.id}</h4><table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>{fields(change).map(([field, before, after]) => <tr key={field}><th scope="row">{field}</th><td><pre>{JSON.stringify(before, null, 2)}</pre></td><td><pre>{JSON.stringify(after, null, 2)}</pre></td></tr>)}</tbody></table></article>)}
        {set.quality?.checks?.map((check) => <section key={check.name}><h3>{check.name}: {check.status}</h3>{check.errors?.map((error, index) => <p key={index} role="alert">{error.message}</p>)}</section>)}
        {set.quality?.warnings?.map((warning) => <p key={warning}>{warning}</p>)}
      </section>}
    </div>
  </main>
}
