'use client'

import { useCallback, useEffect, useState } from 'react'
import styles from './workflow.module.css'
import { PreviewFrame } from './preview-frame'
import { fieldDiffs } from '../../../src/field-diffs'

type Change = { collection: string; id: string; before: unknown; after: unknown }
type ReadinessProof = { revision: number; changeHash: string; contentHash: string; includedChangeKeys: string[]; baselineSnapshotID?: string; baselineSequence: number; previewJobID: string; versionPins: { themeVersion: string; engineVersion: string; contractVersion: string; liveThemeVersion?: string; liveContractVersion?: string }; report?: { publishable?: boolean; blockers?: { code: string; path: string; message: string }[]; warnings?: { code: string; path: string; message: string }[] } }
type ChangeSet = { id: string; name: string; state: string; revision: number; actor?: string; changes?: Change[]; quality?: { checks?: { name: string; status: string; errors?: { message: string }[] }[]; warnings?: string[]; proof?: ReadinessProof }; preview?: { status?: string; jobID?: string }; reviewComments?: { id: string; author: string; body: string; createdAt: string }[] }
type ScheduledPublication = { id: string; scheduledFor: string; state: string; dispatchReason?: string; snapshot?: { contentHash?: string } }
type Data = { sets: ChangeSet[]; actor: { id: string; roles: string[] }; schedules?: ScheduledPublication[]; totalDocs?: number; schedulePage?: number; scheduleTotalPages?: number }

function fields(change: Change) { return fieldDiffs(change.before, change.after) }
function fieldLabel(value: string) { return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/^./, (letter) => letter.toUpperCase()) }
function readable(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'Not set'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.length === 0 ? 'None' : value.every((item) => ['string', 'number', 'boolean'].includes(typeof item)) ? value.join(', ') : `${value.length} item${value.length === 1 ? '' : 's'}`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['title', 'heading', 'name', 'label', 'text', 'body', 'summary', 'slug']) if (typeof record[key] === 'string' && record[key]) return String(record[key])
    return `${Object.keys(record).length} structured field${Object.keys(record).length === 1 ? '' : 's'}`
  }
  return String(value)
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
      setData(next)
      setSelected((current) => { const requested = new URLSearchParams(window.location.search).get('changeSet'); return current ?? next.sets.find((item) => item.id === requested)?.id ?? next.sets[0]?.id ?? null })
    } catch { setMessage('Unable to load editorial change sets. Try again.') } finally { if (!background) setLoading(false) }
  }, [schedulePage])
  useEffect(() => { void load() }, [load])
  const set = data?.sets.find((item) => item.id === selected)
  useEffect(() => { setIncludedChangeKeys(new Set(set?.changes?.map((change) => `${change.collection}:${change.id}`) ?? [])) }, [set?.id, set?.revision])
  useEffect(() => { if (set?.preview?.status === 'ready' && message.startsWith('Private comparison queued')) setMessage('Private comparison is ready for review.') }, [set?.preview?.status, message])
  useEffect(() => { if (!set?.preview?.jobID || set.preview.status === 'ready') return; const timer = window.setInterval(() => void load(true), 4_000); return () => window.clearInterval(timer) }, [set?.id, set?.preview?.jobID, set?.preview?.status, load])
  useEffect(() => {
    if (set?.preview?.status !== 'ready' || !set.preview.jobID) { setPreviewPath('/'); return }
    let active = true
    void fetch(`/api/editorial/preview-route?jobID=${encodeURIComponent(set.preview.jobID)}`, { cache: 'no-store' }).then(async (response) => response.ok ? response.json() as Promise<{ path?: string }> : { path: '/' }).then((body) => { if (active && typeof body.path === 'string' && /^\/(?:[a-z0-9-]+\/)*[a-z0-9-]*$/.test(body.path)) setPreviewPath(body.path || '/') }).catch(() => { if (active) setPreviewPath('/') })
    return () => { active = false }
  }, [set?.preview?.jobID, set?.preview?.status])
  const reviewer = Boolean(data?.actor.roles.some((role) => role === 'owner' || role === 'approver'))
  const owns = Boolean(set && data?.actor.id === set.actor)
  const hasActions = Boolean(set && ((owns && ['open', 'changes-requested', 'stale', 'rejected'].includes(set.state)) || (reviewer && set.state === 'submitted')))
  async function action(actionName: string) {
    if (!set || acting) return
    setActing(true); setMessage('')
    try {
      const preview = actionName === 'prepare-preview'
      if (preview && !includedChangeKeys.size) { setMessage('Select at least one captured change for the comparison.'); return }
      const approval = actionName === 'approve'
      if (approval && !set.quality?.proof) { setMessage('The displayed readiness proof is missing. Reload the comparison and run readiness checks again.'); return }
      const scheduledDate = scheduledFor ? new Date(scheduledFor) : undefined
      if (scheduledDate && !Number.isFinite(scheduledDate.getTime())) { setMessage('Enter a valid local date and time for the scheduled publication.'); return }
      const scheduleISO = scheduledDate?.toISOString()
      const response = await fetch(preview ? '/api/editorial/prepare-preview' : `/api/editorial/${actionName}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preview ? { id: set.id, includedChangeKeys: [...includedChangeKeys] } : approval ? { id: set.id, proof: set.quality?.proof, ...(scheduleISO ? { scheduledFor: scheduleISO } : {}) } : { id: set.id }) })
      const body = await response.json() as { error?: string }
      if (!response.ok) { setMessage(body.error ?? 'The workflow action was not accepted.'); return }
      setMessage(preview ? 'Private comparison queued. It will remain unavailable until the renderer completes.' : actionName === 'run-quality' ? 'Deterministic readiness checks completed.' : actionName === 'approve' ? scheduleISO ? 'Approved immutable snapshot scheduled for UTC dispatch.' : 'Approved snapshot queued for the publish worker.' : actionName === 'submit' ? 'Submitted. Preview generation is pending.' : 'Change set updated.')
      await load()
    } catch { setMessage('Unable to update the change set. Try again.') } finally { setActing(false) }
  }
  async function scheduleAction(actionName: 'cancel' | 'reschedule', schedule: ScheduledPublication) {
    if (acting) return
    setActing(true); setMessage('')
    try {
      const next = actionName === 'reschedule' ? window.prompt('New local date and time (for example 2030-01-02T03:04):', schedule.scheduledFor.slice(0, 16)) : undefined
      if (actionName === 'reschedule' && !next) return
      const scheduledDate = next ? new Date(next) : undefined
      if (scheduledDate && !Number.isFinite(scheduledDate.getTime())) { setMessage('Enter a valid local date and time for the scheduled publication.'); return }
      const response = await fetch(`/api/editorial/schedules/${actionName}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: schedule.id, ...(scheduledDate ? { scheduledFor: scheduledDate.toISOString() } : {}) }) })
      const body = await response.json() as { error?: string }
      if (!response.ok) { setMessage(body.error ?? 'Schedule update was not accepted.'); return }
      setMessage(actionName === 'cancel' ? 'Scheduled publication cancelled.' : 'Scheduled publication rescheduled.'); await load()
    } catch { setMessage('Unable to update the scheduled publication.') } finally { setActing(false) }
  }
  async function addComment() {
    if (!set || !comment.trim()) return
    setActing(true); setMessage('')
    try { const response = await fetch('/api/editorial/comment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: set.id, comment }) }); if (!response.ok) throw new Error(); setComment(''); await load() }
    catch { setMessage('Unable to add this comment. Your text is still available to retry.') } finally { setActing(false) }
  }

  return <main className={styles.workspace} data-editorial-workspace aria-busy={loading || acting}>
    <h1 className={styles.visuallyHidden}>Reviews</h1>
    {(message || loading) && <p className={styles.status} role="status" aria-live="polite">{message || 'Loading change sets…'}</p>}
    <nav className={styles.queue} data-editorial-queue aria-label="Change sets">
      <div className={styles.visuallyHidden}><h2>Review queue</h2>{data && <span>{data.sets.length} change sets</span>}</div>
      <div className={styles.queueRows}>{data?.sets.map((item) => <button className={styles.queueItem} data-editorial-queue-item data-change-set-id={item.id} key={item.id} onClick={() => { setSelected(item.id); setMessage('') }} aria-pressed={selected === item.id}><span className={styles.queueName}>{item.name}</span><small>{item.changes?.length ?? 0} change{item.changes?.length === 1 ? '' : 's'} · revision {item.revision}</small><strong data-editorial-state={item.state}>{item.state}</strong></button>)}{!loading && data?.sets.length === 0 && <p>No pending change sets.</p>}</div>
    </nav>
    {set && <section className={styles.review} data-editorial-detail aria-label="Change set detail">
      <header className={styles.reviewHeader}>
        <div><span className={styles.reviewKicker}>Review</span><h2>{set.name}</h2><p>{set.changes?.length ?? 0} captured change{set.changes?.length === 1 ? '' : 's'} · revision {set.revision}</p></div>
        <strong data-editorial-state={set.state}>{set.state}</strong>
        {set.preview?.status === 'ready' && <div className={styles.controls} data-editorial-view-controls role="group" aria-label="Comparison view"><button onClick={() => setMode('side-by-side')} aria-pressed={mode === 'side-by-side'}>Side by side</button><button onClick={() => setMode('live')} aria-pressed={mode === 'live'}>Live</button><button onClick={() => setMode('proposed')} aria-pressed={mode === 'proposed'}>Proposed</button><span className={styles.deviceControls} data-editorial-device-controls><button onClick={() => setDevice('desktop')} aria-pressed={device === 'desktop'}>Desktop</button><button onClick={() => setDevice('mobile')} aria-pressed={device === 'mobile'}>Mobile</button></span></div>}
      </header>
      {set.state === 'stale' && <p className={styles.reviewAlert} role="alert">This change set is stale. Refresh it before review.</p>}
      <div className={styles.reviewBody}>
        <section className={styles.canvas} data-editorial-comparison aria-label="Private comparison">
          {!set.preview?.jobID && <div className={styles.emptyCanvas}><h3>Comparison not prepared</h3><p>Select the captured changes, then prepare a protected renderer comparison.</p></div>}
          {set.preview?.jobID && set.preview.status !== 'ready' && <div className={styles.emptyCanvas}><h3>Preparing comparison</h3><p>The protected renderer is queued. Frames appear only after it finishes.</p></div>}
          {set.preview?.jobID && set.preview.status === 'ready' && <div className={styles.frames} data-editorial-frames data-device={device}>{mode !== 'proposed' && <div className={styles.frame} data-editorial-frame="live"><span>Live</span><PreviewFrame title="Live comparison" src={`/preview/changes/${set.preview.jobID}/live${previewPath}`} width={device === 'mobile' ? 390 : 760} /></div>}{mode !== 'live' && <div className={styles.frame} data-editorial-frame="proposed"><span>Proposed</span><PreviewFrame title="Proposed comparison" src={`/preview/changes/${set.preview.jobID}/proposed${previewPath}`} width={device === 'mobile' ? 390 : 760} /></div>}</div>}
        </section>
        <aside className={styles.rail} aria-label="Review details">
          {set.preview?.status === 'ready' && set.preview.jobID && <div className={styles.previewLink}><a href={`/review/${set.id}`}>Review on page ↗</a><small>Open the protected rendered page with block navigation and review actions.</small></div>}
          {reviewer && set.state === 'submitted' && Boolean(set.changes?.length) && <fieldset className={styles.selection} data-editorial-selection><legend>Included changes</legend>{set.changes?.map((change) => { const key = `${change.collection}:${change.id}`; const count = fields(change).length; return <label key={key}><input aria-label={`Include ${change.collection} ${change.id}`} type="checkbox" checked={includedChangeKeys.has(key)} onChange={() => setIncludedChangeKeys((current) => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next })} /><span>{fieldLabel(change.collection)} <small>{count} field{count === 1 ? '' : 's'}</small></span></label> })}</fieldset>}
          {Boolean(set.changes?.length) && <section className={styles.changes} data-editorial-change-rail tabIndex={0} aria-label="Captured changes"><h3 data-editorial-diffs>Changes</h3>{set.changes?.map((change) => <article key={`${change.collection}-${change.id}`}><h4>{fieldLabel(change.collection)}</h4><p className={styles.changeId}>{change.id}</p>{fields(change).map(([field, before, after]) => <div className={styles.fieldChange} key={field}><strong>{fieldLabel(field)}</strong><div><span>From</span><p>{readable(before)}</p></div><div><span>To</span><p>{readable(after)}</p></div><details><summary>Technical details</summary><pre tabIndex={0}>{JSON.stringify({ before, after }, null, 2)}</pre></details></div>)}</article>)}</section>}
          {(set.quality?.checks?.length || set.quality?.proof?.report?.blockers?.length || set.quality?.proof?.report?.warnings?.length || set.quality?.warnings?.length) ? <section className={styles.checks}><h3>Checks</h3>{set.quality?.checks?.map((check) => <div className={styles.check} key={check.name}><strong data-check-status={check.status}>{check.status === 'passed' ? '✓' : '!'}</strong><span>{check.name}</span>{check.errors?.map((error, index) => <p key={index} role="alert">{error.message}</p>)}</div>)}{!set.quality?.proof?.report?.warnings?.length && set.quality?.warnings?.map((warning) => <p key={warning}>{warning}</p>)}{set.quality?.proof?.report?.blockers?.map((blocker) => <p key={`${blocker.code}-${blocker.path}`} role="alert">{blocker.message} <small>{blocker.code} · {blocker.path}</small></p>)}{set.quality?.proof?.report?.warnings?.map((warning) => <p key={`${warning.code}-${warning.path}`}>{warning.message} <small>{warning.code} · {warning.path}</small></p>)}</section> : null}
          {hasActions && <section className={styles.actions} data-editorial-actions aria-label="Workflow actions"><h3>Actions</h3>{owns && (set.state === 'open' || set.state === 'changes-requested') && <button data-editorial-primary className={styles.primary} disabled={acting} onClick={() => action('submit')}>Submit for review</button>}{reviewer && set.state === 'submitted' && <><button disabled={acting} onClick={() => action('prepare-preview')}>Prepare comparison</button>{set.preview?.status === 'ready' && <button disabled={acting} onClick={() => action('run-quality')}>Run readiness checks</button>}{set.quality?.proof?.report?.publishable === true && <><label className={styles.scheduleLabel}>Schedule for local time (optional)<input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} /></label><small>Leave blank to queue immediately. Scheduled times convert to UTC.</small><button data-editorial-primary className={styles.primary} disabled={acting} onClick={() => action('approve')}>{scheduledFor ? 'Approve and schedule publish' : 'Approve and queue publish'}</button></>}{set.preview?.status === 'ready' && set.quality?.proof?.report?.publishable !== true && <p role="status">Approval requires a passing readiness proof for this exact comparison.</p>}<button disabled={acting} onClick={() => action('request-changes')}>Request changes</button><button className={styles.quiet} disabled={acting} onClick={() => action('reject')}>Reject</button></>}{owns && (set.state === 'open' || set.state === 'changes-requested' || set.state === 'stale') && <button disabled={acting} onClick={() => action('refresh')}>Refresh</button>}{owns && (set.state === 'open' || set.state === 'changes-requested' || set.state === 'rejected') && <button className={styles.quiet} disabled={acting} onClick={() => action('discard')}>Discard</button>}</section>}
          {reviewer && <section className={styles.comments} data-editorial-comments aria-label="Review comments"><h3>Comments</h3>{set.reviewComments?.length ? <div className={styles.commentList}>{set.reviewComments.map((item) => <article key={item.id}><p>{item.body}</p><small>{new Date(item.createdAt).toLocaleString()}</small></article>)}</div> : <p>No review comments.</p>}<label htmlFor="review-comment">Add a comment</label><textarea id="review-comment" aria-label="Add review comment" value={comment} onChange={(event) => setComment(event.target.value)} /><button disabled={acting || !comment.trim()} onClick={() => void addComment()}>Add comment</button></section>}
        </aside>
      </div>
    </section>}
    {reviewer && <section className={styles.schedules} data-editorial-schedules aria-label="Scheduled publications"><h2>Scheduled publications</h2>{data?.schedules?.length ? <><ul>{data.schedules.map((schedule) => <li key={schedule.id}><strong>{schedule.state}</strong> — <time dateTime={schedule.scheduledFor}>{new Date(schedule.scheduledFor).toLocaleString()} (UTC {schedule.scheduledFor})</time>{schedule.snapshot?.contentHash && <p>Frozen snapshot: {schedule.snapshot.contentHash}</p>}{schedule.dispatchReason && <p>Dispatch status: {schedule.dispatchReason}</p>}{data.actor.roles.includes('owner') && schedule.state === 'scheduled' && <p><button disabled={acting} onClick={() => void scheduleAction('reschedule', schedule)}>Reschedule</button><button disabled={acting} onClick={() => void scheduleAction('cancel', schedule)}>Cancel schedule</button></p>}</li>)}</ul>{data.scheduleTotalPages && data.scheduleTotalPages > 1 && <nav aria-label="Scheduled publication pages"><button disabled={acting || schedulePage <= 1} onClick={() => setSchedulePage((page) => page - 1)}>Previous schedules</button><span> Page {data.schedulePage} of {data.scheduleTotalPages} </span><button disabled={acting || schedulePage >= data.scheduleTotalPages} onClick={() => setSchedulePage((page) => page + 1)}>Next schedules</button></nav>}</> : <p>No scheduled publications.</p>}</section>}
  </main>
}
