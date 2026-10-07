'use client'

import { useCallback, useEffect, useState } from 'react'
import styles from './workflow.module.css'
import { PreviewFrame } from './preview-frame'
import { belongsToReviewView, changeKind, changeTitle, readableValue, relevantDiffs, words } from '../../../src/review-presentation'

type Change = { collection: string; id: string; before: unknown; after: unknown }
type Conflict = { collection: string; id: string; before: Record<string, unknown> | null; proposed: Record<string, unknown> | null; current: Record<string, unknown> | null; currentHash: string | null; canReapply: boolean }
type ReadinessProof = { revision: number; changeHash: string; contentHash: string; includedChangeKeys: string[]; baselineSnapshotID?: string; baselineSequence: number; previewJobID: string; versionPins: { themeVersion: string; engineVersion: string; contractVersion: string; liveThemeVersion?: string; liveContractVersion?: string }; report?: { publishable?: boolean; blockers?: { code: string; path: string; message: string }[]; warnings?: { code: string; path: string; message: string }[] } }
type ChangeSet = { id: string; name: string; state: string; revision: number; actor?: string; changes?: Change[]; quality?: { checks?: { name: string; status: string; errors?: { message: string }[] }[]; warnings?: string[]; proof?: ReadinessProof }; preview?: { status?: string; jobID?: string }; reviewComments?: { id: string; author: string; body: string; createdAt: string }[]; presentation: { actorLabel: string; sourceLabel: string; occurredAt: string | null; affectedPageCount: number; checkSummary: string; warningCount: number } }
type ScheduledPublication = { id: string; scheduledFor: string; state: string; dispatchReason?: string; snapshot?: { contentHash?: string } }
type Data = { sets: ChangeSet[]; actor: { id: string; roles: string[] }; schedules?: ScheduledPublication[]; totalDocs?: number; schedulePage?: number; scheduleTotalPages?: number }

function fields(change: Change) { return relevantDiffs(change) }
const localDate = (value: string | null | undefined) => !value || !Number.isFinite(new Date(value).getTime()) ? 'Time unavailable' : new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto', timeZoneName: 'short' }).format(new Date(value))
const pageCount = (count: number) => `${count} ${count === 1 ? 'page' : 'pages'}`
const scheduleState = (state: string) => ({ scheduled: 'Scheduled', cancelled: 'Cancelled', stale: 'Needs review', enqueued: 'Queued for publishing', failed: 'Publish failed', completed: 'Published' }[state] ?? state)
const scheduleOutcome = (state: string, reason?: string) => {
  if (state === 'completed') return 'This scheduled publication was published successfully.'
  if (state === 'failed') return 'The publish worker could not complete this release. The public site remains unchanged.'
  if (state !== 'stale') return undefined
  return ({
    APPROVAL_AUTHORITY_REVOKED: 'This scheduled publication was not queued because its approving reviewer no longer has authorization. It remains private and needs a new review.',
    APPROVAL_CONTEXT_INVALID: 'This scheduled publication was not queued because its approval context changed. It remains private and needs a new review.',
    BLOCKING_CHECKS_FAILED: 'This scheduled publication was not queued because its readiness checks no longer pass. It remains private and needs a new review.',
    BASELINE_STALE: 'This scheduled publication was not queued because another release changed the publication baseline. It remains private and needs a new review.',
  } as Record<string, string>)[reason ?? ''] ?? 'This scheduled publication did not reach the public site. Review the technical details and create a new approval.'
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
  const [queueView, setQueueView] = useState<'pending' | 'history'>('pending')
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null)
  const [conflictRevision, setConflictRevision] = useState<number | null>(null)
  const [conflictChoices, setConflictChoices] = useState<Record<string, 'retain-current' | 'reapply-proposed'>>({})
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
      setSelected((current) => {
        const requested = new URLSearchParams(window.location.search).get('changeSet')
        // A link to a specific review must keep pointing at that review while
        // loading its conflict comparison changes it to stale.
        if (requested && next.sets.some((item) => item.id === requested)) return requested
        return current && next.sets.some((item) => item.id === current)
          ? current
          : next.sets.find((item) => belongsToReviewView(item.state, 'pending'))?.id ?? null
      })
    } catch { setMessage('Unable to load editorial change sets. Try again.') } finally { if (!background) setLoading(false) }
  }, [schedulePage])
  useEffect(() => { void load() }, [load])
  const visibleSets = data?.sets.filter((item) => belongsToReviewView(item.state, queueView)) ?? []
  const pendingCount = data?.sets.filter((item) => belongsToReviewView(item.state, 'pending')).length ?? 0
  const historyCount = data?.sets.filter((item) => belongsToReviewView(item.state, 'history')).length ?? 0
  const set = visibleSets.find((item) => item.id === selected) ?? visibleSets[0]
  const selectedID = set?.id ?? null
  useEffect(() => { setIncludedChangeKeys(new Set(set?.changes?.map((change) => `${change.collection}:${change.id}`) ?? [])) }, [set?.id, set?.revision])
  useEffect(() => {
    setConflicts(null); setConflictRevision(null); setConflictChoices({})
    if (!set || !['open', 'submitted', 'changes-requested', 'stale'].includes(set.state) || data?.actor.id !== set.actor) return
    let active = true
    void fetch(`/api/editorial/conflicts?id=${encodeURIComponent(set.id)}`, { cache: 'no-store' }).then(async (response) => response.ok ? response.json() as Promise<{ state: string; revision: number; conflicts: Conflict[] }> : null).then((body) => { if (active && body) { setConflicts(body.conflicts); setConflictRevision(body.revision); if (body.state === 'stale') setData((current) => current ? { ...current, sets: current.sets.map((item) => item.id === set.id ? { ...item, state: 'stale', revision: body.revision } : item) } : current) } }).catch(() => { if (active) setMessage('Unable to load the current draft conflict comparison.') })
    return () => { active = false }
  }, [set?.id, set?.state, set?.revision, set?.actor, data?.actor.id])
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
  const primaryChange = set?.changes?.find((change) => change.collection === 'pages') ?? set?.changes?.[0]
  const reviewTitle = primaryChange ? changeTitle(primaryChange) : set?.name
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
  async function resolveConflicts() {
    if (!set || conflicts === null || conflictRevision === null || acting || conflicts.some((conflict) => !conflictChoices[`${conflict.collection}:${conflict.id}`])) return
    setActing(true); setMessage('')
    try {
      const response = await fetch('/api/editorial/resolve-conflicts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: set.id, expectedRevision: conflictRevision, resolutions: conflicts.map((conflict) => ({ collection: conflict.collection, id: conflict.id, currentHash: conflict.currentHash, choice: conflictChoices[`${conflict.collection}:${conflict.id}`] })) }) })
      const body = await response.json() as { error?: string }
      if (!response.ok) { setMessage(body.error ?? 'The conflict resolution was not accepted.'); return }
      setMessage('Conflicts resolved. Refresh to create a current review candidate.')
      await load()
    } catch { setMessage('Unable to resolve the conflicts. Reload the current draft comparison and try again.') } finally { setActing(false) }
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
      <div className={styles.queueHeading}><h2>Review queue</h2><div className={styles.queueTabs} data-editorial-queue-tabs role="group" aria-label="Review queue view"><button aria-pressed={queueView === 'pending'} onClick={() => { setQueueView('pending'); setSelected(null) }}>Pending <span>{pendingCount}</span></button><button aria-pressed={queueView === 'history'} onClick={() => { setQueueView('history'); setSelected(null) }}>History <span>{historyCount}</span></button></div></div>
      <div className={styles.queueRows}>{visibleSets.map((item) => <button className={styles.queueItem} data-editorial-queue-item data-change-set-id={item.id} key={item.id} onClick={() => { setSelected(item.id); setMessage('') }} aria-pressed={selectedID === item.id}><span className={styles.queueName}>{item.name}</span><small data-review-context>{item.presentation.actorLabel} · {item.presentation.sourceLabel} · {pageCount(item.presentation.affectedPageCount)} · {localDate(item.presentation.occurredAt)} · {item.presentation.checkSummary}{item.presentation.warningCount ? ` · ${item.presentation.warningCount} ${item.presentation.warningCount === 1 ? 'warning' : 'warnings'}` : ''}</small><strong data-editorial-state={item.state}>{item.state}</strong></button>)}{!loading && visibleSets.length === 0 && <p>{queueView === 'pending' ? 'No pending reviews.' : 'No review history.'}</p>}</div>
    </nav>
    {set && <section className={styles.review} data-editorial-detail aria-label="Change set detail">
      <header className={styles.reviewHeader}>
        <div><span className={styles.reviewKicker}>Review</span><h2>{reviewTitle}</h2><p>{set.name} · {set.changes?.length ?? 0} captured change{set.changes?.length === 1 ? '' : 's'} · revision {set.revision}</p></div>
        <strong data-editorial-state={set.state}>{set.state}</strong>
        {set.preview?.status === 'ready' && <div className={styles.controls} data-editorial-view-controls role="group" aria-label="Comparison view"><button onClick={() => setMode('side-by-side')} aria-pressed={mode === 'side-by-side'}>Side by side</button><button onClick={() => setMode('live')} aria-pressed={mode === 'live'}>Live</button><button onClick={() => setMode('proposed')} aria-pressed={mode === 'proposed'}>Proposed</button><span className={styles.deviceControls} data-editorial-device-controls><button onClick={() => setDevice('desktop')} aria-pressed={device === 'desktop'}>Desktop</button><button onClick={() => setDevice('mobile')} aria-pressed={device === 'mobile'}>Mobile</button></span></div>}
      </header>
      {set.state === 'stale' && <p className={styles.reviewAlert} role="alert">This change set is stale. Resolve any changed draft, then refresh it before review.</p>}
      <div className={styles.reviewBody}>
        <section className={styles.canvas} data-editorial-comparison aria-label="Private comparison">
          {!set.preview?.jobID && <div className={styles.emptyCanvas}><h3>Comparison not prepared</h3><p>Select the captured changes, then prepare a protected renderer comparison.</p></div>}
          {set.preview?.jobID && set.preview.status !== 'ready' && <div className={styles.emptyCanvas}><h3>Preparing comparison</h3><p>The protected renderer is queued. Frames appear only after it finishes.</p></div>}
          {set.preview?.jobID && set.preview.status === 'ready' && <div className={styles.frames} data-editorial-frames data-device={device}>{mode !== 'proposed' && <div className={styles.frame} data-editorial-frame="live"><span>Live</span><PreviewFrame title="Live comparison" src={`/preview/changes/${set.preview.jobID}/live${previewPath}`} width={device === 'mobile' ? 390 : 760} /></div>}{mode !== 'live' && <div className={styles.frame} data-editorial-frame="proposed"><span>Proposed</span><PreviewFrame title="Proposed comparison" src={`/preview/changes/${set.preview.jobID}/proposed${previewPath}`} width={device === 'mobile' ? 390 : 760} /></div>}</div>}
        </section>
        <aside className={styles.rail} aria-label="Review details">
          {set.preview?.status === 'ready' && set.preview.jobID && <div className={styles.previewLink}><a href={`/review/${set.id}`}>Review on page ↗</a><small>Open the protected rendered page with block navigation and review actions.</small></div>}
          {reviewer && set.state === 'submitted' && Boolean(set.changes?.length) && <fieldset className={styles.selection} data-editorial-selection><legend>Included changes</legend>{set.changes?.map((change) => { const key = `${change.collection}:${change.id}`; const count = fields(change).length; return <label key={key}><input aria-label={`Include ${changeKind(change.collection)} ${changeTitle(change)}`} type="checkbox" checked={includedChangeKeys.has(key)} onChange={() => setIncludedChangeKeys((current) => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next })} /><span>{changeTitle(change)} <small>{count} field{count === 1 ? '' : 's'}</small></span></label> })}</fieldset>}
          {owns && set.state === 'stale' && <section className={styles.changes} data-editorial-conflicts aria-label="Draft conflicts"><h3>Draft conflicts</h3>{conflicts === null ? <p>Loading the original, proposed, and current draft values…</p> : conflicts.length === 0 ? <p>No draft conflict was found. Refresh this aged change set.</p> : <>{conflicts.map((conflict) => { const key = `${conflict.collection}:${conflict.id}`; const fields = [...new Set([...Object.keys(conflict.before ?? {}), ...Object.keys(conflict.proposed ?? {}), ...Object.keys(conflict.current ?? {})])].filter((field) => readableValue(conflict.proposed?.[field]) !== readableValue(conflict.current?.[field]) || readableValue(conflict.before?.[field]) !== readableValue(conflict.proposed?.[field])); return <article key={key}><h4>{changeTitle({ collection: conflict.collection, id: conflict.id, before: conflict.before, after: conflict.proposed })}</h4>{fields.map((field) => <div className={styles.fieldChange} key={field}><strong>{words(field)}</strong><div><span>Original</span><p>{readableValue(conflict.before?.[field])}</p></div><div><span>Proposed</span><p>{readableValue(conflict.proposed?.[field])}</p></div><div><span>Current draft</span><p>{readableValue(conflict.current?.[field])}</p></div></div>)}<fieldset><legend>Resolution</legend><label><input type="radio" name={`resolution-${key}`} checked={conflictChoices[key] === 'retain-current'} onChange={() => setConflictChoices((current) => ({ ...current, [key]: 'retain-current' }))} />Retain current draft</label>{conflict.canReapply && <label><input type="radio" name={`resolution-${key}`} checked={conflictChoices[key] === 'reapply-proposed'} onChange={() => setConflictChoices((current) => ({ ...current, [key]: 'reapply-proposed' }))} />Reapply proposed fields</label>}</fieldset></article> })}<button disabled={acting || conflicts.some((conflict) => !conflictChoices[`${conflict.collection}:${conflict.id}`])} onClick={() => void resolveConflicts()}>Resolve draft conflicts</button></>}</section>}
          {Boolean(set.changes?.length) && <section className={styles.changes} data-editorial-change-rail tabIndex={0} aria-label="Captured changes"><h3 data-editorial-diffs>Changes</h3>{set.changes?.map((change) => <article key={`${change.collection}-${change.id}`}><h4>{changeTitle(change)}</h4><p className={styles.changeKind}>{changeKind(change.collection)}</p>{fields(change).map(([field, before, after]) => <div className={styles.fieldChange} key={field}><strong>{words(field)}</strong><div><span>From</span><p>{readableValue(before)}</p></div><div><span>To</span><p>{readableValue(after)}</p></div></div>)}</article>)}</section>}
          {(set.quality?.checks?.length || set.quality?.proof?.report?.blockers?.length || set.quality?.proof?.report?.warnings?.length || set.quality?.warnings?.length) ? <section className={styles.checks}><h3>Checks</h3>{set.quality?.checks?.map((check) => <div className={styles.check} key={check.name}><strong data-check-status={check.status}>{check.status === 'passed' ? '✓' : '!'}</strong><span>{words(check.name)}</span>{check.errors?.map((error, index) => <p key={index} role="alert">{error.message}</p>)}</div>)}{!set.quality?.proof?.report?.warnings?.length && set.quality?.warnings?.map((warning) => <p key={warning}>{warning}</p>)}{set.quality?.proof?.report?.blockers?.map((blocker) => <p key={`${blocker.code}-${blocker.path}`} role="alert">{blocker.message}</p>)}{set.quality?.proof?.report?.warnings?.map((warning) => <p key={`${warning.code}-${warning.path}`}>{warning.message}</p>)}</section> : null}
          {hasActions && <section className={styles.actions} data-editorial-actions aria-label="Workflow actions"><h3>Actions</h3>{owns && (set.state === 'open' || set.state === 'changes-requested') && <button data-editorial-primary className={styles.primary} disabled={acting} onClick={() => action('submit')}>Submit for review</button>}{reviewer && set.state === 'submitted' && <><button disabled={acting} onClick={() => action('prepare-preview')}>Prepare comparison</button>{set.preview?.status === 'ready' && <button disabled={acting} onClick={() => action('run-quality')}>Run readiness checks</button>}{set.quality?.proof?.report?.publishable === true && <><label className={styles.scheduleLabel}>Schedule for local time (optional)<input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} /></label><small>Leave blank to queue immediately. Scheduled times convert to UTC.</small><button data-editorial-primary className={styles.primary} disabled={acting} onClick={() => action('approve')}>{scheduledFor ? 'Approve and schedule publish' : 'Approve and queue publish'}</button></>}{set.preview?.status === 'ready' && set.quality?.proof?.report?.publishable !== true && <p role="status">Approval requires a passing readiness proof for this exact comparison.</p>}<button disabled={acting} onClick={() => action('request-changes')}>Request changes</button><button className={styles.quiet} disabled={acting} onClick={() => action('reject')}>Reject</button></>}{owns && (set.state === 'open' || set.state === 'changes-requested' || set.state === 'stale') && <button disabled={acting} onClick={() => action('refresh')}>Refresh</button>}{owns && (set.state === 'open' || set.state === 'changes-requested' || set.state === 'rejected') && <button className={styles.quiet} disabled={acting} onClick={() => action('discard')}>Discard</button>}</section>}
          {reviewer && <section className={styles.comments} data-editorial-comments aria-label="Review comments"><h3>Comments</h3>{set.reviewComments?.length ? <div className={styles.commentList}>{set.reviewComments.map((item) => <article key={item.id}><p>{item.body}</p><small>{new Date(item.createdAt).toLocaleString()}</small></article>)}</div> : <p>No review comments.</p>}<label htmlFor="review-comment">Add a comment</label><textarea id="review-comment" aria-label="Add review comment" value={comment} onChange={(event) => setComment(event.target.value)} /><button disabled={acting || !comment.trim()} onClick={() => void addComment()}>Add comment</button></section>}
        </aside>
      </div>
    </section>}
    {reviewer && Boolean(data?.schedules?.length) && <section className={styles.schedules} data-editorial-schedules aria-label="Scheduled publications"><h2>Scheduled publications</h2><ul>{data!.schedules!.map((schedule) => <li key={schedule.id}><div className={styles.scheduleSummary}><strong>{scheduleState(schedule.state)}</strong><time dateTime={schedule.scheduledFor}>{localDate(schedule.scheduledFor)}</time></div>{scheduleOutcome(schedule.state, schedule.dispatchReason) && <p>{scheduleOutcome(schedule.state, schedule.dispatchReason)}</p>}{data!.actor.roles.includes('owner') && schedule.state === 'scheduled' && <p className={styles.scheduleActions}><button disabled={acting} onClick={() => void scheduleAction('reschedule', schedule)}>Reschedule</button><button disabled={acting} onClick={() => void scheduleAction('cancel', schedule)}>Cancel schedule</button></p>}<details className={styles.scheduleDiagnostics}><summary>Technical details</summary><p>UTC: {schedule.scheduledFor}</p>{schedule.snapshot?.contentHash && <p>Frozen snapshot: {schedule.snapshot.contentHash}</p>}{schedule.dispatchReason && <p>Dispatch status: {schedule.dispatchReason}</p>}</details></li>)}</ul>{data!.scheduleTotalPages && data!.scheduleTotalPages > 1 && <nav aria-label="Scheduled publication pages"><button disabled={acting || schedulePage <= 1} onClick={() => setSchedulePage((page) => page - 1)}>Previous schedules</button><span> Page {data!.schedulePage} of {data!.scheduleTotalPages} </span><button disabled={acting || schedulePage >= data!.scheduleTotalPages} onClick={() => setSchedulePage((page) => page + 1)}>Next schedules</button></nav>}</section>}
  </main>
}
