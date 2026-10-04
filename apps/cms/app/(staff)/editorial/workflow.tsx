'use client'

import { useCallback, useEffect, useState } from 'react'

type Change = { collection: string; id: string; before: unknown; after: unknown }
type ReadinessProof = { revision: number; changeHash: string; contentHash: string; includedChangeKeys: string[]; baselineSnapshotID?: string; baselineSequence: number; previewJobID: string; versionPins: { themeVersion: string; engineVersion: string; contractVersion: string; liveThemeVersion?: string; liveContractVersion?: string }; report?: { publishable?: boolean; blockers?: { code: string; path: string; message: string }[]; warnings?: { code: string; path: string; message: string }[] } }
type ChangeSet = { id: string; name: string; state: string; revision: number; actor?: string; changes?: Change[]; quality?: { checks?: { name: string; status: string; errors?: { message: string }[] }[]; warnings?: string[]; proof?: ReadinessProof }; staleAt?: string; preview?: { status?: string; jobID?: string }; reviewComments?: { id: string; author: string; body: string; createdAt: string }[] }
type ScheduledPublication = { id: string; scheduledFor: string; state: string; dispatchReason?: string; snapshot?: { contentHash?: string }; changeSet?: string | { id: string } }
type Data = { sets: ChangeSet[]; actor: { id: string; roles: string[] }; schedules?: ScheduledPublication[]; totalDocs?: number; schedulePage?: number; scheduleTotalPages?: number }
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
  const [mode, setMode] = useState<'side-by-side' | 'live' | 'proposed'>('side-by-side')
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [comment, setComment] = useState('')
  const [includedChangeKeys, setIncludedChangeKeys] = useState<Set<string>>(new Set())
  const [scheduledFor, setScheduledFor] = useState('')
  const [schedulePage, setSchedulePage] = useState(1)
  const [previewPath, setPreviewPath] = useState('/')
  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true)
    try {
      const response = await fetch('/api/editorial/list', { cache: 'no-store' })
      if (!response.ok) { setMessage('Sign in to view editorial change sets.'); return }
      const next = await response.json() as Data
      if (next.actor.roles.some((role) => role === 'owner' || role === 'approver')) {
        const schedules = await fetch(`/api/editorial/schedules/list?page=${schedulePage}`, { cache: 'no-store' })
        if (schedules.ok) { const body = await schedules.json() as { schedules: ScheduledPublication[]; totalDocs: number; page: number; totalPages: number }; next.schedules = body.schedules; next.totalDocs = body.totalDocs; next.schedulePage = body.page; next.scheduleTotalPages = body.totalPages }
      }
      setData(next); setSelected((current) => current ?? next.sets[0]?.id ?? null)
    } catch {
      setMessage('Unable to load editorial change sets. Try again.')
    } finally { if (!background) setLoading(false) }
  }, [schedulePage])
  useEffect(() => { void load() }, [load])
  const set = data?.sets.find((item) => item.id === selected)
  useEffect(() => { setIncludedChangeKeys(new Set(set?.changes?.map((change) => `${change.collection}:${change.id}`) ?? [])) }, [set?.id, set?.revision])
  useEffect(() => {
    if (!set?.preview?.jobID || set.preview.status === 'ready') return
    const timer = window.setInterval(() => void load(true), 4_000)
    return () => window.clearInterval(timer)
  }, [set?.id, set?.preview?.jobID, set?.preview?.status, load])
  useEffect(() => {
    if (set?.preview?.status !== 'ready' || !set.preview.jobID) { setPreviewPath('/'); return }
    let active = true
    void fetch(`/api/editorial/preview-route?jobID=${encodeURIComponent(set.preview.jobID)}`, { cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() as Promise<{ path?: string }> : { path: '/' })
      .then((body) => { if (active && typeof body.path === 'string' && /^\/(?:[a-z0-9-]+\/)*[a-z0-9-]*$/.test(body.path)) setPreviewPath(body.path || '/') })
      .catch(() => { if (active) setPreviewPath('/') })
    return () => { active = false }
  }, [set?.preview?.jobID, set?.preview?.status])
  const reviewer = Boolean(data?.actor.roles.some((role) => role === 'owner' || role === 'approver'))
  const owns = Boolean(set && data?.actor.id === set.actor)
  async function action(action: string) {
    if (!set || acting) return
    setActing(true)
    setMessage('')
    try {
      const preview = action === 'prepare-preview'
      if (preview && !includedChangeKeys.size) { setMessage('Select at least one captured change for the comparison.'); return }
      const approval = action === 'approve'
      if (approval && !set.quality?.proof) { setMessage('The displayed readiness proof is missing. Reload the comparison and run readiness checks again.'); return }
      const scheduledDate = scheduledFor ? new Date(scheduledFor) : undefined
      if (scheduledDate && !Number.isFinite(scheduledDate.getTime())) { setMessage('Enter a valid local date and time for the scheduled publication.'); return }
      const scheduleISO = scheduledDate?.toISOString()
      const response = await fetch(preview ? '/api/editorial/prepare-preview' : `/api/editorial/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preview ? { id: set.id, includedChangeKeys: [...includedChangeKeys] } : approval ? { id: set.id, proof: set.quality?.proof, ...(scheduleISO ? { scheduledFor: scheduleISO } : {}) } : { id: set.id }) })
      const body = await response.json() as { error?: string }
      if (!response.ok) { setMessage(body.error ?? 'The workflow action was not accepted.'); return }
      setMessage(preview ? 'Private comparison queued. It will remain unavailable until the renderer completes.' : action === 'run-quality' ? 'Deterministic readiness checks completed.' : action === 'approve' ? scheduleISO ? 'Approved immutable snapshot scheduled for UTC dispatch.' : 'Approved snapshot queued for the publish worker.' : action === 'submit' ? 'Submitted. Preview generation is pending.' : 'Change set updated.')
      await load()
    } catch {
      setMessage('Unable to update the change set. Try again.')
    } finally {
      setActing(false)
    }
  }
  async function scheduleAction(action: 'cancel' | 'reschedule', schedule: ScheduledPublication) {
    if (acting) return; setActing(true); setMessage('')
    try {
      const next = action === 'reschedule' ? window.prompt('New local date and time (for example 2030-01-02T03:04):', schedule.scheduledFor.slice(0, 16)) : undefined
      if (action === 'reschedule' && !next) return
      const scheduledDate = next ? new Date(next) : undefined
      if (scheduledDate && !Number.isFinite(scheduledDate.getTime())) { setMessage('Enter a valid local date and time for the scheduled publication.'); return }
      const response = await fetch(`/api/editorial/schedules/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: schedule.id, ...(scheduledDate ? { scheduledFor: scheduledDate.toISOString() } : {}) }) })
      const body = await response.json() as { error?: string }; if (!response.ok) { setMessage(body.error ?? 'Schedule update was not accepted.'); return }
      setMessage(action === 'cancel' ? 'Scheduled publication cancelled.' : 'Scheduled publication rescheduled.'); await load()
    } catch { setMessage('Unable to update the scheduled publication.') } finally { setActing(false) }
  }
  async function addComment() { if (!set || !comment.trim()) return; setActing(true); try { const response = await fetch('/api/editorial/comment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: set.id, comment }) }); if (!response.ok) throw new Error(); setComment(''); await load() } finally { setActing(false) } }
  return <main style={{ maxWidth: 1100, margin: '2rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }} aria-busy={loading || acting}>
    <h1>Pending changes</h1>
    <p>Draft edits remain private. Approval queues an immutable snapshot; only the publish worker can activate a release.</p>
    <p role="status" aria-live="polite">{message || (loading ? 'Loading change sets…' : '')}</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))', gap: '2rem' }}>
      <nav aria-label="Change sets"><h2>Change sets</h2>{data?.sets.map((item) => <button data-change-set-id={item.id} key={item.id} onClick={() => setSelected(item.id)} aria-pressed={selected === item.id} style={{ display: 'block', width: '100%', textAlign: 'left', margin: '0.5rem 0', overflowWrap: 'anywhere' }}>{item.name} — {item.state}</button>)}{!loading && data?.sets.length === 0 && <p>No pending change sets.</p>}</nav>
      {set && <section aria-label="Change set detail"><h2>{set.name}</h2><p>State: <strong>{set.state}</strong></p>
        {set.state === 'stale' && <p role="alert">This change set is stale. Refresh it before review.</p>}
        <div aria-label="Workflow actions">
          {owns && (set.state === 'open' || set.state === 'changes-requested') && <button disabled={acting} onClick={() => action('submit')}>Submit for review</button>}
          {reviewer && set.state === 'submitted' && <><button disabled={acting} onClick={() => action('prepare-preview')}>Prepare comparison</button>{set.preview?.status === 'ready' && <button disabled={acting} onClick={() => action('run-quality')}>Run readiness checks</button>}{set.quality?.proof?.report?.publishable === true && <><label>Schedule for local time (optional)<input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} /></label><p>Leave blank to queue immediately. Scheduled times are converted to UTC and dispatch only after the reviewed baseline remains current.</p><button disabled={acting} onClick={() => action('approve')}>{scheduledFor ? 'Approve and schedule publish' : 'Approve and queue publish'}</button></>}{set.preview?.status === 'ready' && set.quality?.proof?.report?.publishable !== true && <p role="status">Approval is disabled until the exact comparison has a passing readiness proof.</p>}<button disabled={acting} onClick={() => action('request-changes')}>Request changes</button><button disabled={acting} onClick={() => action('reject')}>Reject</button></>}
          {owns && (set.state === 'open' || set.state === 'changes-requested' || set.state === 'stale') && <button disabled={acting} onClick={() => action('refresh')}>Refresh</button>}
          {owns && (set.state === 'open' || set.state === 'changes-requested' || set.state === 'rejected') && <button disabled={acting} onClick={() => action('discard')}>Discard</button>}
        </div>
        {reviewer && set.state === 'submitted' && <fieldset><legend>Changes in comparison</legend>{set.changes?.map((change) => { const key = `${change.collection}:${change.id}`; return <label key={key} style={{ display: 'block' }}><input type="checkbox" checked={includedChangeKeys.has(key)} onChange={() => setIncludedChangeKeys((current) => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next })} /> Include {change.collection} {change.id}</label> })}</fieldset>}
        {set.preview?.jobID && <section aria-label="Private comparison"><h3>Private comparison</h3><p>{set.preview.status === 'ready' ? 'Renderer completed this immutable comparison.' : 'Comparison is queued or rendering. Frames remain unavailable until completion.'}</p>{set.preview.status === 'ready' && <><div><button onClick={() => setMode('side-by-side')} aria-pressed={mode === 'side-by-side'}>Side by side</button><button onClick={() => setMode('live')} aria-pressed={mode === 'live'}>Live</button><button onClick={() => setMode('proposed')} aria-pressed={mode === 'proposed'}>Proposed</button><button onClick={() => setDevice('desktop')} aria-pressed={device === 'desktop'}>Desktop</button><button onClick={() => setDevice('mobile')} aria-pressed={device === 'mobile'}>Mobile</button></div><div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>{mode !== 'proposed' && <iframe title="Live comparison" src={`/preview/changes/${set.preview.jobID}/live${previewPath}`} style={{ width: device === 'mobile' ? 390 : 760, height: 640 }} />}{mode !== 'live' && <iframe title="Proposed comparison" src={`/preview/changes/${set.preview.jobID}/proposed${previewPath}`} style={{ width: device === 'mobile' ? 390 : 760, height: 640 }} />}</div></>}</section>}
        <h3>Field diffs</h3>
        {set.changes?.map((change) => <article key={`${change.collection}-${change.id}`}><h4>{change.collection} {change.id}</h4><table><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>{fields(change).map(([field, before, after]) => <tr key={field}><th scope="row">{field}</th><td><pre>{JSON.stringify(before, null, 2)}</pre></td><td><pre>{JSON.stringify(after, null, 2)}</pre></td></tr>)}</tbody></table></article>)}
        {set.quality?.checks?.map((check) => <section key={check.name}><h3>{check.name}: {check.status}</h3>{check.errors?.map((error, index) => <p key={index} role="alert">{error.message}</p>)}</section>)}
        {set.quality?.warnings?.map((warning) => <p key={warning}>{warning}</p>)}
        {set.quality?.proof?.report?.blockers?.map((blocker) => <p key={`${blocker.code}-${blocker.path}`} role="alert">Blocker {blocker.code} at {blocker.path}: {blocker.message}</p>)}
        {set.quality?.proof?.report?.warnings?.map((warning) => <p key={`${warning.code}-${warning.path}`}>Warning {warning.code} at {warning.path}: {warning.message}</p>)}
        {reviewer && <section aria-label="Review comments"><h3>Review comments</h3>{set.reviewComments?.map((item) => <p key={item.id}>{item.body}</p>)}<textarea value={comment} onChange={(event) => setComment(event.target.value)} aria-label="Add review comment" /><button disabled={acting} onClick={() => void addComment()}>Add comment</button></section>}
      </section>}
    </div>
    {reviewer && <section aria-label="Scheduled publications"><h2>Scheduled publications</h2>{data?.schedules?.length ? <><ul>{data.schedules.map((schedule) => <li key={schedule.id}><strong>{schedule.state}</strong> — <time dateTime={schedule.scheduledFor}>{new Date(schedule.scheduledFor).toLocaleString()} (UTC {schedule.scheduledFor})</time>{schedule.snapshot?.contentHash && <p>Frozen snapshot: {schedule.snapshot.contentHash}</p>}{schedule.dispatchReason && <p>Dispatch status: {schedule.dispatchReason}</p>}{data.actor.roles.includes('owner') && schedule.state === 'scheduled' && <p><button disabled={acting} onClick={() => void scheduleAction('reschedule', schedule)}>Reschedule</button><button disabled={acting} onClick={() => void scheduleAction('cancel', schedule)}>Cancel schedule</button></p>}</li>)}</ul>{data.scheduleTotalPages && data.scheduleTotalPages > 1 && <nav aria-label="Scheduled publication pages"><button disabled={acting || schedulePage <= 1} onClick={() => setSchedulePage((page) => page - 1)}>Previous schedules</button><span> Page {data.schedulePage} of {data.scheduleTotalPages} </span><button disabled={acting || schedulePage >= data.scheduleTotalPages} onClick={() => setSchedulePage((page) => page + 1)}>Next schedules</button></nav>}</> : <p>No scheduled publications.</p>}</section>}
  </main>
}
