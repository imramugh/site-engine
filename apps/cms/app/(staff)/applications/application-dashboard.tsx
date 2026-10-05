'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './careers-workspace.module.css'
import { PermanentDeleteDialog } from '../permanent-delete-dialog'
import { MailReplyComposer } from '../mail-reply-composer'
import { MailThreadTimeline } from '../mail-thread-timeline'

type Application = { id: string; name: string; email: string; telephone: string | null; linkedIn: string | null; coverLetter: string; consent: boolean; jobId: string; status: string; createdAt: string }
type Job = { id: string; title: string; status: 'open' | 'draft' | 'closed'; applicationCount: number; employmentType?: string; location?: string; validThrough?: string; editHref?: string }
type History = { event: string; detail: { note?: string; from?: string; to?: string }; createdAt: string }
const stages = ['new', 'reviewing', 'interview', 'offer', 'hired', 'declined', 'closed'] as const
type Stage = typeof stages[number]
const label = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)
const employmentLabel = (value?: string): string => value ? value.toLowerCase().split('_').map(label).join(' ') : ''

export function ApplicationDashboard({ owner = false }: { owner?: boolean }) {
  const [view, setView] = useState<'roles' | 'applications'>('roles')
  const [applications, setApplications] = useState<Application[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [canPostRole, setCanPostRole] = useState(false)
  const [stageCounts, setStageCounts] = useState<Record<string, number>>({})
  const [applicationTotal, setApplicationTotal] = useState(0)
  const [stage, setStage] = useState('')
  const [jobId, setJobId] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Application | null>(null)
  const [history, setHistory] = useState<History[]>([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const requestID = useRef(0)

  const load = async (nextPage = page, nextStage = stage, nextJobId = jobId) => {
    const currentRequest = ++requestID.current
    setLoading(true); setError('')
    const query = new URLSearchParams({ page: String(nextPage) })
    if (nextStage) query.set('stage', nextStage)
    if (nextJobId) query.set('jobId', nextJobId)
    try {
      const [applicationResult, jobResult] = await Promise.all([fetch(`/api/hiring/applications?${query}`, { cache: 'no-store' }), fetch('/api/hiring/jobs', { cache: 'no-store' })])
      if (!applicationResult.ok || !jobResult.ok) throw new Error('access')
      const data = await applicationResult.json() as { docs?: Application[]; page?: number; totalPages?: number; allTotalDocs?: number; stageCounts?: Record<string, number> }
      const roleData = await jobResult.json() as { jobs?: Job[]; canPostRole?: boolean }
      if (currentRequest !== requestID.current) return
      setApplications(data.docs ?? []); setApplicationTotal(data.allTotalDocs ?? 0); setStageCounts(data.stageCounts ?? {}); setPage(data.page ?? nextPage); setTotalPages(Math.max(1, data.totalPages ?? 1)); setJobs(roleData.jobs ?? []); setCanPostRole(roleData.canPostRole === true)
    } catch { if (currentRequest === requestID.current) { setApplications([]); setJobs([]); setError('Unable to load Careers. Check your connection or session.') } }
    finally { if (currentRequest === requestID.current) setLoading(false) }
  }
  useEffect(() => { void load(1, '', '') }, [])

  const updateStage = async (application: Application, status: Stage) => {
    setError(''); setSaving(application.id)
    try {
      const response = await fetch(`/api/hiring/applications/${application.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) })
      if (!response.ok) throw new Error('update')
      const changed = await response.json() as Pick<Application, 'id' | 'status'>
      setApplications((items) => items.map((item) => item.id === changed.id ? { ...item, status: changed.status } : item)); setSelected((item) => item?.id === changed.id ? { ...item, status: changed.status } : item)
      setStageCounts((counts) => ({ ...counts, [application.status]: Math.max(0, (counts[application.status] ?? 0) - 1), [changed.status]: (counts[changed.status] ?? 0) + 1 }))
    } catch { setError('The application stage could not be updated. Try again.') } finally { setSaving('') }
  }
  const context = (application: Application) => jobs.find((job) => job.id === application.jobId)
  const show = async (application: Application) => { setConfirmDelete(false); setSelected(application); setHistory([]); const response = await fetch(`/api/hiring/applications/${application.id}/history`, { cache: 'no-store' }); if (response.ok) setHistory((await response.json() as { events: History[] }).events) }
  const addNote = async () => { if (!selected || !note.trim()) return; setSaving('note'); const response = await fetch(`/api/hiring/applications/${selected.id}/history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) }); if (!response.ok) setError('The note could not be saved. Try again.'); else { const event = (await response.json() as { event: History }).event; setHistory((items) => [event, ...items]); setNote('') }; setSaving('') }
  const download = async (application: Application) => { setError(''); try { const response = await fetch(`/api/hiring/applications/${application.id}/resume-link`, { method: 'POST' }); const body = await response.json() as { url?: string }; if (!response.ok || !body.url) throw new Error('link'); window.location.assign(body.url) } catch { setError('The resume link could not be created. Try again.') } }
  const switchView = (next: 'roles' | 'applications') => { setView(next); setSelected(null) }
  const filterStage = (next: string) => { setStage(next); setSelected(null); void load(1, next, jobId) }
  const purge = async () => {
    if (!selected) return
    setSaving('purge'); setError('')
    try {
      const response = await fetch('/api/retention', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ applicationID: selected.id, confirm: 'permanent-delete' }) })
      if (!response.ok) throw new Error('The application could not be deleted. Check your session and try again.')
      setSelected(null); setConfirmDelete(false); await load()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Deletion failed.'); throw failure }
    finally { setSaving('') }
  }

  return <main className={styles.workspace} aria-busy={loading || Boolean(saving)} data-careers-workspace>
    <h1 className={styles.visuallyHidden}>Careers</h1>
    <header className={styles.toolbar}><div className={styles.tabs} role="group" aria-label="Careers view"><button type="button" aria-pressed={view === 'roles'} onClick={() => switchView('roles')}>Roles · {jobs.length}</button><button type="button" aria-pressed={view === 'applications'} onClick={() => switchView('applications')}>Applications · {applicationTotal}</button></div>{canPostRole ? <a className={styles.primary} href="/content-editor/new?section=careers&template=job">+ Post a role</a> : null}</header>
    {error ? <p role="alert">{error}</p> : null}
    {loading && !jobs.length && !applications.length ? <p role="status">Loading Careers…</p> : null}

    {view === 'roles' && !loading ? <section className={styles.panel} aria-labelledby="roles-heading" data-careers-roles><h2 id="roles-heading" className={styles.visuallyHidden}>Roles</h2>
      {!jobs.length ? <div className={styles.empty} role="status"><strong>No roles yet</strong><span>{canPostRole ? 'Post a role to start a private draft for review.' : 'There are no role drafts or published roles.'}</span></div> : <div className={styles.tableScroll} tabIndex={0} aria-label="Roles table, scroll horizontally for more columns"><table><caption className={styles.visuallyHidden}>Roles</caption><thead><tr><th scope="col">Role</th><th scope="col">Location · type</th><th scope="col">Status</th><th scope="col">Applications</th>{canPostRole ? <th scope="col"><span className={styles.visuallyHidden}>Actions</span></th> : null}</tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td><strong>{job.title}</strong>{job.validThrough ? <small>Apply by {new Date(job.validThrough).toLocaleDateString()}</small> : <small>No closing date</small>}</td><td>{[job.location, employmentLabel(job.employmentType)].filter(Boolean).join(' · ') || 'Not set'}</td><td><span className={styles.status} data-status={job.status}>{label(job.status)}</span></td><td>{job.applicationCount}</td>{canPostRole && job.editHref ? <td><a href={job.editHref}>Edit role</a></td> : null}</tr>)}</tbody></table></div>}
      <p className={styles.guidance}>Role pages use the normal content review workflow. Closing a published role keeps its applications.</p></section> : null}

    {view === 'applications' ? <><div className={styles.filters} data-careers-filters><div className={styles.stageFilters} aria-label="Filter by stage"><button type="button" aria-pressed={!stage} onClick={() => filterStage('')}>All · {Object.values(stageCounts).reduce((sum, count) => sum + count, 0)}</button>{stages.map((item) => <button type="button" key={item} aria-pressed={stage === item} onClick={() => filterStage(item)}>{label(item)} · {stageCounts[item] ?? 0}</button>)}</div><label htmlFor="application-job">Role</label><select id="application-job" value={jobId} onChange={(event) => { const next = event.target.value; setJobId(next); setSelected(null); void load(1, stage, next) }}><option value="">All roles</option>{jobs.map((job) => <option key={job.id} value={job.id}>{job.title}</option>)}</select></div>
      <div className={styles.applicationLayout} data-detail-open={Boolean(selected)}><section className={styles.panel} aria-labelledby="applications-heading" data-careers-applications><h2 id="applications-heading" className={styles.visuallyHidden}>Applications</h2>
        {!loading && applications.length === 0 ? <div className={styles.empty} role="status"><strong>No applications match these filters</strong><span>Applications will appear here after a candidate submits the public role form.</span></div> : <div className={styles.tableScroll} tabIndex={applications.length ? 0 : -1} aria-label="Applications table, scroll horizontally for more columns"><table><caption className={styles.visuallyHidden}>Applications</caption><thead><tr><th scope="col">Applicant</th><th scope="col">Stage</th><th scope="col">Role</th><th scope="col">Received</th></tr></thead><tbody>{applications.map((application) => <tr key={application.id}><td><button className={styles.rowButton} type="button" aria-pressed={selected?.id === application.id} onClick={() => void show(application)}><strong>{application.name}</strong><small>{application.email}</small></button></td><td><span className={styles.status} data-stage={application.status}>{label(application.status)}</span></td><td>{context(application)?.title ?? 'Role no longer listed'}</td><td>{new Date(application.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>}
        {totalPages > 1 ? <nav className={styles.pagination} aria-label="Application pagination"><button type="button" disabled={page <= 1} onClick={() => void load(page - 1)}>Previous</button><span>Page {page} of {totalPages}</span><button type="button" disabled={page >= totalPages} onClick={() => void load(page + 1)}>Next</button></nav> : null}</section>
        {selected ? <aside className={styles.detail} aria-label="Application details" data-careers-application-detail><header><div><h2>{selected.name}</h2><p>{context(selected)?.title ?? 'Role no longer listed'}</p></div><button type="button" aria-label="Close application details" onClick={() => setSelected(null)}>×</button></header><dl><dt>Email</dt><dd><a href={`mailto:${selected.email}`}>{selected.email}</a></dd><dt>Phone</dt><dd>{selected.telephone ? <a href={`tel:${selected.telephone.replace(/[^+\d]/g, '')}`}>{selected.telephone}</a> : 'Not provided'}</dd><dt>LinkedIn</dt><dd>{selected.linkedIn ? <a href={selected.linkedIn} target="_blank" rel="noopener noreferrer">View profile</a> : 'Not provided'}</dd><dt>Received</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd><dt>Consent</dt><dd>{selected.consent ? 'Confirmed' : 'Not confirmed'}</dd></dl>
          <MailReplyComposer key={selected.id} target="application" id={selected.id} recipient={selected.email} /><MailThreadTimeline key={selected.id} target="application" id={selected.id} /><section className={styles.resume} aria-label="Resume"><strong>Resume document</strong><button type="button" aria-label="Download resume" onClick={() => void download(selected)}>Download</button></section>{owner&&<><button type="button" onClick={()=>setConfirmDelete(true)}>Permanently delete application</button>{confirmDelete && <PermanentDeleteDialog kind="application" identity={`${selected.name} (${selected.email})`} busy={saving === 'purge'} onConfirm={purge} onCancel={() => setConfirmDelete(false)} />}</>}<section className={styles.coverLetter} aria-labelledby="cover-letter-heading"><h3 id="cover-letter-heading">Cover letter</h3><p>{selected.coverLetter}</p></section><section className={styles.stagePicker} aria-labelledby="stage-heading"><h3 id="stage-heading">Stage</h3><div>{stages.map((item) => <button key={item} type="button" aria-pressed={selected.status === item} disabled={saving === selected.id} onClick={() => void updateStage(selected, item)}>{label(item)}</button>)}</div></section>
          <section className={styles.notes} aria-labelledby="notes-heading"><h3 id="notes-heading">Hiring notes and stage history</h3><label htmlFor="application-note">Add note</label><textarea id="application-note" value={note} maxLength={5000} onChange={(event) => setNote(event.target.value)} /><button type="button" disabled={!note.trim() || saving === 'note'} onClick={() => void addNote()}>{saving === 'note' ? 'Saving…' : 'Save note'}</button>{history.length ? <ul>{history.map((item, index) => <li key={`${item.createdAt}-${index}`}><span>{item.detail.note ?? `${label(item.detail.from ?? '')} → ${label(item.detail.to ?? '')}`}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></li>)}</ul> : <p>No notes or stage changes yet.</p>}</section></aside> : null}</div>
    </> : null}
  </main>
}
