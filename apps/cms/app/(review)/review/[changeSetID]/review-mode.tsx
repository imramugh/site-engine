'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewModeData } from '../../../../src/review-mode'
import styles from './review-mode.module.css'
import { useAutomaticReviewPreparation } from '../../../components/review-auto-preparation'

type Mode = 'live' | 'proposed' | 'side'
type Device = 'desktop' | 'mobile'
type PendingReview = { id: string; name: string; state: 'submitted'; revision: number; changeKeys: string[]; preview: { status: string; jobID?: string; includedChangeKeys?: string[] } }
type Publication = { status: 'queued' | 'publishing' | 'published' | 'failed'; errorCode?: string }
type StaleReview = { id: string; name: string; state: 'submitted'; revision: number; includedChangeKeys: string[]; message: string }
type Data = { review?: ReviewModeData; pendingReview?: PendingReview; staleReview?: StaleReview; failedPreview?: { id: string; name: string; state: string; revision: number; includedChangeKeys: string[]; diagnostics: Array<{ code: string; path: string; message: string; pageId?: string; blockId?: string }> }; publication?: Publication; sessionAuthorized: boolean }

function ReviewFrame({ title, src, width, changed, active, variant, onReady }: { title: string; src: string; width: 1440 | 760 | 390; changed: ReviewModeData['changedBlocks']; active?: string; variant: 'live' | 'proposed'; onReady: (available: Set<string>) => void }) {
  const shell = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [availableWidth, setAvailableWidth] = useState<number>(width)
  const [viewportHeight, setViewportHeight] = useState(760)
  useEffect(() => {
    const node = shell.current
    if (!node) return
    const resize = () => {
      setAvailableWidth(node.clientWidth || width)
      setViewportHeight(window.innerWidth <= 700 ? 360 : Math.max(560, window.innerHeight - 82))
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(node)
    return () => observer.disconnect()
  }, [width])
  const decorate = useCallback((scroll = false) => {
    const doc = frame.current?.contentDocument
    // A navigating iframe can expose a Document before its head is parsed.
    // Its load event will retry decoration once the page is available.
    if (!doc?.head || doc.readyState === 'loading') return
    let style = doc.getElementById('site-engine-review-highlights')
    if (!style) {
      style = doc.createElement('style'); style.id = 'site-engine-review-highlights'
      style.textContent = '[data-review-changed="true"]{outline:3px solid #f4ba16!important;outline-offset:-3px;position:relative}[data-review-active="true"]{outline:5px solid #007ea8!important;outline-offset:-5px}'
      doc.head.append(style)
    }
    const found = new Set<string>()
    doc.querySelectorAll<HTMLElement>('[data-review-changed], [data-review-active]').forEach((node) => {
      node.removeAttribute('data-review-active')
      node.removeAttribute('data-review-changed')
    })
    const pageContent = doc.querySelector('main')
    const typed = pageContent ? [...pageContent.querySelectorAll<HTMLElement>('[data-block-type], [data-block]')] : []
    for (const change of changed) {
      let node = pageContent ? [...pageContent.querySelectorAll<HTMLElement>('[data-block-id]')].find((candidate) => candidate.dataset.blockId === change.id) : undefined
      if (!node) {
        const type = variant === 'live' ? change.liveType : change.proposedType
        const occurrence = variant === 'live' ? change.liveOccurrence : change.proposedOccurrence
        const expectedCount = variant === 'live' ? change.liveTypeCount : change.proposedTypeCount
        const candidates = type ? typed.filter((candidate) => (candidate.dataset.blockType ?? candidate.dataset.block) === type) : []
        if (type && occurrence !== undefined && expectedCount !== undefined && candidates.length === expectedCount) node = candidates[occurrence]
      }
      if (!node) continue
      node.dataset.reviewChanged = 'true'; found.add(change.id)
      if (change.id === active) {
        node.dataset.reviewActive = 'true'
        if (scroll) node.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      }
    }
    onReady(found)
  }, [active, changed, onReady, variant])
  useEffect(() => { decorate(Boolean(active)) }, [active, decorate])
  const scale = Math.min(1, availableWidth / width)
  return <div ref={shell} className={styles.frameViewport} style={{ height: viewportHeight }} data-render-width={width} data-render-scale={scale.toFixed(3)}>
    <iframe ref={frame} title={title} src={src} width={width} height={Math.ceil(viewportHeight / scale)} style={{ transform: `scale(${scale})` }} onLoad={() => decorate(false)} />
  </div>
}

export function OnPageReview({ changeSetID, pageID }: { changeSetID: string; pageID?: string }) {
  const [data, setData] = useState<Data | null>(null)
  const [mode, setMode] = useState<Mode>('side')
  const [device, setDevice] = useState<Device>('desktop')
  const [narrow, setNarrow] = useState(false)
  const [panel, setPanel] = useState(true)
  const [active, setActive] = useState<string>()
  const [availableByPane, setAvailableByPane] = useState<{ live: Set<string>; proposed: Set<string> }>({ live: new Set(), proposed: new Set() })
  const [comment, setComment] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const qualityAttempted = useRef(new Set<string>())
  const [qualityError, setQualityError] = useState('')
  const [qualityRetry, setQualityRetry] = useState(0)
  const load = useCallback(async () => {
    try {
      const selection = pageID ? `?pageID=${encodeURIComponent(pageID)}` : ''
      const response = await fetch(`/api/editorial/review/${encodeURIComponent(changeSetID)}${selection}`, { cache: 'no-store' })
      const body = await response.json() as Data & { error?: string }
      if (!response.ok) { setData(null); setMessage(body.error ?? 'This comparison is no longer current. Return to Reviews and prepare a current review.'); return }
      setData(body)
    } catch { setMessage('Unable to load this review. Try again.') } finally { setLoading(false) }
  }, [changeSetID, pageID])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)')
    const update = () => setNarrow(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const review = data?.review
  const pending = data?.pendingReview
  const automatic = useAutomaticReviewPreparation({
    review: pending ? { ...pending, ready: false } : review ? { id: review.id, state: review.state, revision: review.revision, changeKeys: [], preview: { status: 'ready', jobID: review.previewJobID }, ready: true } : undefined,
    selectedKeys: pending?.preview.includedChangeKeys ?? pending?.changeKeys ?? [],
    refresh: load,
  })
  useEffect(() => {
    const qualityKey = review ? `${review.id}:${review.revision}:${review.previewJobID}` : ''
    if (!review || review.state !== 'submitted' || review.approvalProof || qualityAttempted.current.has(qualityKey)) return
    qualityAttempted.current.add(qualityKey); setQualityError('')
    void fetch('/api/editorial/run-quality', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: review.id }) }).then(async (response) => {
      if (!response.ok) {
        const body = await response.json() as { error?: string }
        setQualityError(body.error ?? 'Readiness checks need attention before approval.')
        return
      }
      await load()
    }).catch(() => setQualityError('Readiness checks could not run. Retry readiness checks.'))
  }, [load, qualityRetry, review])
  useEffect(() => {
    if (!data?.publication || !['queued', 'publishing'].includes(data.publication.status)) return
    const timer = window.setInterval(() => void load(), 2_000)
    return () => window.clearInterval(timer)
  }, [data?.publication?.status, load])
  const rememberAvailable = useCallback((pane: 'live' | 'proposed', found: Set<string>) => setAvailableByPane((current) => {
    const previous = current[pane]
    if (previous.size === found.size && [...found].every((id) => previous.has(id))) return current
    return { ...current, [pane]: found }
  }), [])
  const rememberLive = useCallback((found: Set<string>) => rememberAvailable('live', found), [rememberAvailable])
  const rememberProposed = useCallback((found: Set<string>) => rememberAvailable('proposed', found), [rememberAvailable])
  async function action(name: 'run-quality' | 'approve' | 'request-changes' | 'reject' | 'comment') {
    if (!review || acting) return
    if (name === 'comment' && !comment.trim()) return
    setActing(true); setMessage('')
    try {
      const response = await fetch(`/api/editorial/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(name === 'approve' ? { id: review.id, proof: review.approvalProof } : name === 'comment' ? { id: review.id, comment } : { id: review.id }) })
      const body = await response.json() as { error?: string }
      if (!response.ok) { setMessage(body.error ?? (name === 'comment' ? 'Unable to add this comment. Your text is still available to retry.' : 'The review action was not accepted.')); return }
      if (name === 'comment') setComment('')
      setMessage(name === 'approve' ? 'Approved. Publication is queued; this page will report the worker result.' : name === 'request-changes' ? 'Changes requested. The current live page is unchanged.' : name === 'reject' ? 'Change set rejected. The current live page is unchanged.' : name === 'run-quality' ? 'Readiness checks completed for this exact comparison.' : 'Comment added.')
      await load()
    } catch { setMessage('Unable to complete this action. Your comment is still available to retry.') } finally { setActing(false) }
  }
  async function retryComparison(target: { id: string; includedChangeKeys: string[] }) {
    if (!target.includedChangeKeys.length || acting) return
    setActing(true); setMessage('')
    try { const response = await fetch('/api/editorial/prepare-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(target) }); const body = await response.json() as { error?: string }; if (!response.ok) { setMessage(body.error ?? 'Correct the blocking issue and submit a new review.'); return }; await load() } catch { setMessage('The comparison could not be retried. Correct the blocking issue and try again.') } finally { setActing(false) }
  }
  if (data?.failedPreview) return <main className={styles.loading}><section aria-label="Failed preview diagnostics"><h1>{data.failedPreview.name}</h1><p role="alert">The private renderer found blocking readiness issues. Approval and publication are unavailable.</p>{data.failedPreview.diagnostics.map((item, index) => <p role="alert" key={`${item.code}-${index}`}>{item.message}<small>{item.code} · {item.path}{item.blockId ? ` · ${item.blockId}` : ''}</small></p>)}<button type="button" disabled={acting || !data.failedPreview.includedChangeKeys.length} onClick={() => void retryComparison(data.failedPreview!)}>Retry comparison</button><a href="/editorial">Return to Reviews</a></section></main>
  if (data?.staleReview) return <main className={styles.loading}><section aria-label="Stale review"><h1>{data.staleReview.name}</h1><p role="alert">{data.staleReview.message}</p><button type="button" disabled={acting || !data.staleReview.includedChangeKeys.length} onClick={() => void retryComparison(data.staleReview!)}>Prepare current comparison</button><a href="/editorial">Return to Reviews</a></section></main>
  if (loading) return <main className={styles.loading} aria-busy="true">Loading protected review…</main>
  if (pending) return <main className={styles.loading} aria-busy="true"><section aria-label="Preparing protected review"><h1>{pending.name}</h1><p role="status">{automatic.preparing ? 'Preparing the protected comparison…' : 'Waiting for the protected renderer…'}</p>{automatic.error && <><p role="alert">{automatic.error}</p><button type="button" onClick={automatic.retry}>Retry comparison</button></>}</section></main>
  if (!review) return <main className={styles.loading}><h1>Review unavailable</h1><p role="alert">{message}</p><a href="/editorial">Return to Reviews</a></main>
  const report = review.quality?.proof?.report
  const submitted = review.state === 'submitted'
  const publishable = report?.publishable === true && Boolean(review.approvalProof)
  const publication = data.publication
  const path = review.path === '/' ? '' : review.path
  const width = device === 'mobile' || narrow ? 390 : mode === 'side' ? 760 : 1440
  const available = mode === 'live' ? availableByPane.live : mode === 'proposed' ? availableByPane.proposed : new Set([...availableByPane.live, ...availableByPane.proposed])
  return <main className={styles.workspace} data-page-review data-panel-open={panel}>
    <header className={styles.bar} aria-label="Pending change review" data-page-review-bar>
      <div className={styles.identity}><span aria-hidden="true" /><div><strong>{submitted ? 'This page has a pending change' : `Change set ${review.state}`}</strong><small>{review.name} · revision {review.revision}</small></div></div>
      <div className={styles.viewControls} role="group" aria-label="Comparison view" data-page-review-view-controls>
        {([['live', 'Live'], ['proposed', 'Proposed'], ['side', 'Side by side']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}
      </div>
      <div className={styles.deviceControls} role="group" aria-label="Preview device" data-page-review-device-controls>
        <button type="button" aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')}>Desktop</button><button type="button" aria-pressed={device === 'mobile'} onClick={() => setDevice('mobile')}>Mobile</button>
      </div>
      <button className={styles.panelButton} type="button" aria-expanded={panel} onClick={() => setPanel((open) => !open)}>{panel ? 'Hide details' : 'Details and actions'}</button>
    </header>
    {message && <p className={styles.notice} role="status" aria-live="polite">{message}</p>}
    {publication && <p className={styles.notice} role={publication.status === 'failed' ? 'alert' : 'status'}>{publication.status === 'queued' ? 'Publication queued. Waiting for the publish worker.' : publication.status === 'publishing' ? 'Publishing the approved immutable snapshot…' : publication.status === 'published' ? 'Published. The immutable snapshot is live.' : <>Publication could not be confirmed{publication.errorCode ? ` (${publication.errorCode})` : ''}. <a href="/operations">Open Operations for details and retry.</a></>}</p>}
    <div className={styles.content}>
      <section className={styles.canvas} aria-label="Rendered page comparison" data-review-mode={mode} data-device={device}>
        <div className={styles.frames} data-single={mode !== 'side'}>
          {mode !== 'proposed' && <article className={styles.pane} data-review-frame="live"><span className={styles.paneLabel}>Live</span><ReviewFrame title="Live page" src={`/preview/changes/${review.previewJobID}/live${path || '/'}`} width={width} changed={review.changedBlocks} active={active} variant="live" onReady={rememberLive} /></article>}
          {mode !== 'live' && <article className={styles.pane} data-review-frame="proposed"><span className={`${styles.paneLabel} ${styles.proposed}`}>Proposed</span><ReviewFrame title="Proposed page" src={`/preview/changes/${review.previewJobID}/proposed${path || '/'}`} width={width} changed={review.changedBlocks} active={active} variant="proposed" onReady={rememberProposed} /></article>}
        </div>
      </section>
      {panel && <aside className={styles.rail} aria-label="Review details" data-page-review-rail>
        <section className={styles.summary}><span>Change set</span><h1>{review.name}</h1><p>Revision {review.revision} · {review.state}</p></section>
        <section className={styles.changes} aria-labelledby="page-changes" tabIndex={0} data-page-review-change-list><h2 id="page-changes">Changes on this page</h2>
          {review.changedBlocks.length ? <ol>{review.changedBlocks.map((change) => <li key={change.id}><button type="button" aria-pressed={active === change.id} onClick={() => setActive(change.id)}><strong>{change.label}</strong><span>{change.summary}</span>{!available.has(change.id) && <small>Rendered block unavailable in the visible comparison</small>}</button>{change.details.length > 0 && <dl className={styles.fieldChanges}>{change.details.map((detail, index) => <div key={`${detail.field}-${index}`}><dt>{detail.field}</dt><dd><span>Live</span>{detail.before}</dd><dd><span>Proposed</span>{detail.after}</dd></div>)}</dl>}</li>)}</ol> : <p>No block-level changes on this page.</p>}
          {review.pageFields.length > 0 && <p><strong>Page fields:</strong> {review.pageFields.join(', ')}</p>}
          {review.otherChanges.length > 0 && <p>{review.otherChanges.length} other captured record{review.otherChanges.length === 1 ? '' : 's'} in this change set.</p>}
        </section>
        <section className={styles.checks} tabIndex={0} aria-label="Quality checks"><h2>Checks</h2>
          {review.quality?.checks?.map((check) => <div className={styles.check} key={check.name}><strong data-status={check.status}>{check.status === 'passed' ? '✓' : '!'}</strong><span>{check.name}</span>{check.errors?.map((error, index) => <p role="alert" key={index}>{error.message}</p>)}</div>)}
          {report?.blockers?.map((item) => <p role="alert" key={`${item.code}-${item.path}`}>{item.message}<small>{item.code} · {item.path}</small></p>)}
          {Boolean(report?.warnings?.length) && <details className={styles.warningDetails}><summary>{report!.warnings!.length} advisory warning{report!.warnings!.length === 1 ? '' : 's'}</summary>{report!.warnings!.map((item) => <p key={`${item.code}-${item.path}`}>{item.message}<small>{item.code} · {item.path}</small></p>)}</details>}
          {!review.quality?.checks?.length && <p>Readiness checks have not run for this comparison.</p>}
          {qualityError && <p role="alert">{qualityError} <button type="button" onClick={() => { qualityAttempted.current.delete(`${review.id}:${review.revision}:${review.previewJobID}`); setQualityRetry((value) => value + 1) }}>Retry readiness checks</button></p>}
        </section>
        <section className={styles.comments}><h2>Comments</h2>{review.reviewComments.length ? review.reviewComments.map((item) => <article key={item.id}><p>{item.body}</p><small>{new Date(item.createdAt).toLocaleString()}</small></article>) : <p>No review comments.</p>}
          {submitted && <><label htmlFor="page-review-comment">Add a comment</label><textarea id="page-review-comment" rows={3} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} /><button type="button" disabled={acting || !comment.trim()} onClick={() => void action('comment')}>Add comment</button></>}
        </section>
        {submitted && <section className={styles.actions} aria-label="Review actions" data-page-review-actions><h2>Decision</h2>
          <button className={styles.approve} type="button" disabled={acting || !publishable || !data.sessionAuthorized} onClick={() => void action('approve')}>Approve and publish</button>
          {!publishable && <small>Approval requires passing readiness checks for this exact comparison.</small>}
          <button type="button" disabled={acting} onClick={() => void action('request-changes')}>Request changes</button>
          <button className={styles.reject} type="button" disabled={acting} onClick={() => void action('reject')}>Reject</button>
        </section>}
        <a className={styles.adminLink} href={`/editorial?changeSet=${encodeURIComponent(review.id)}`}>Open in Reviews</a>
      </aside>}
    </div>
  </main>
}
