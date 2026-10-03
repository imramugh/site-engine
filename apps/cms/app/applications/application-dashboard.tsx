'use client'

import { useEffect, useRef, useState } from 'react'

type Application = { id: string; name: string; email: string; coverLetter: string; consent: boolean; jobId: string; status: string; createdAt: string }
type Job = { id: string; title: string; status: string; employmentType?: string; location?: string }
type History = { event: string; detail: { note?: string; from?: string; to?: string }; createdAt: string }
const stages = ['new', 'reviewing', 'closed']

export function ApplicationDashboard() {
  const [applications, setApplications] = useState<Application[]>([]); const [jobs, setJobs] = useState<Job[]>([]); const [stage, setStage] = useState(''); const [jobId, setJobId] = useState(''); const [page, setPage] = useState(1); const [totalPages, setTotalPages] = useState(1); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [selected, setSelected] = useState<Application | null>(null); const [history, setHistory] = useState<History[]>([]); const [note, setNote] = useState(''); const [saving, setSaving] = useState(''); const requestID = useRef(0)
  const load = async (nextPage = page, nextStage = stage, nextJobId = jobId) => {
    const currentRequest = ++requestID.current; setLoading(true); setError('')
    const query = new URLSearchParams({ limit: '25', page: String(nextPage), sort: '-createdAt', depth: '0' }); if (nextStage) query.set('where[status][equals]', nextStage); if (nextJobId) query.set('where[jobId][equals]', nextJobId)
    try {
      const [result, jobResult] = await Promise.all([fetch(`/api/applications?${query}`, { cache: 'no-store' }), jobs.length ? Promise.resolve(undefined) : fetch('/api/hiring/jobs', { cache: 'no-store' })])
      if (!result.ok) throw new Error('access')
      const data = await result.json() as { docs?: Application[]; page?: number; totalPages?: number }
      if (jobResult) { if (!jobResult.ok) throw new Error('access'); setJobs((await jobResult.json() as { jobs: Job[] }).jobs) }
      if (currentRequest !== requestID.current) return; setApplications(data.docs ?? []); setPage(data.page ?? nextPage); setTotalPages(Math.max(1, data.totalPages ?? 1))
    } catch { if (currentRequest === requestID.current) { setApplications([]); setError('Unable to load applications. Check your connection or session.') } } finally { if (currentRequest === requestID.current) setLoading(false) }
  }
  useEffect(() => { void load(1, '', '') }, [])
  const updateStage = async (application: Application, status: string) => {
    setError('')
    try { const response = await fetch(`/api/hiring/applications/${application.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) }); if (!response.ok) throw new Error('update'); const changed = await response.json() as Pick<Application, 'id' | 'status'>; setApplications((items) => items.map((item) => item.id === changed.id ? { ...item, status: changed.status } : item)); setSelected((item) => item?.id === changed.id ? { ...item, status: changed.status } : item) } catch { setError('The application stage could not be updated. Try again.') }
  }
  const context = (application: Application) => jobs.find((job) => job.id === application.jobId)
  const show = async (application: Application) => { setSelected(application); const response = await fetch(`/api/hiring/applications/${application.id}/history`); if (response.ok) setHistory((await response.json() as { events: History[] }).events) }
  const addNote = async () => { if (!selected || !note.trim()) return; const response = await fetch(`/api/hiring/applications/${selected.id}/history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) }); if (!response.ok) { setError('The note could not be saved. Try again.'); return }; const event = (await response.json() as { event: History }).event; setHistory((items) => [event, ...items]); setNote('') }
  const download = async (application: Application) => { setError(''); try { const response = await fetch(`/api/hiring/applications/${application.id}/resume-link`, { method: 'POST' }); const body = await response.json() as { url?: string }; if (!response.ok || !body.url) throw new Error('link'); window.location.assign(body.url) } catch { setError('The resume link could not be created. Try again.') } }
  return <main>
    <h1>Applications</h1><p>Private hiring records and resumes.</p>
    <p><label htmlFor="application-stage">Filter stage</label> <select id="application-stage" value={stage} onChange={(event) => { const next = event.target.value; setStage(next); void load(1, next, jobId) }}><option value="">All stages</option>{stages.map((item) => <option key={item} value={item}>{item}</option>)}</select> <label htmlFor="application-job">Filter role</label> <select id="application-job" value={jobId} onChange={(event) => { const next = event.target.value; setJobId(next); void load(1, stage, next) }}><option value="">All roles</option>{jobs.map((job) => <option key={job.id} value={job.id}>{job.title}</option>)}</select></p>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">Loading applications…</p> : applications.length === 0 ? <p role="status">No applications match these filters.</p> : <table><caption>Applications</caption><thead><tr><th scope="col">Applicant</th><th scope="col">Role</th><th scope="col">Stage</th><th scope="col">Received</th><th scope="col">Actions</th></tr></thead><tbody>{applications.map((application) => { const job = context(application); return <tr key={application.id}><td>{application.name}<br /><a href={`mailto:${application.email}`}>{application.email}</a></td><td>{job ? <>{job.title}<br /><small>{[job.employmentType, job.location].filter(Boolean).join(' · ')}</small></> : application.jobId}</td><td><select aria-label={`Stage for ${application.email}`} value={application.status} onChange={(event) => void updateStage(application, event.target.value)}>{stages.map((item) => <option key={item} value={item}>{item}</option>)}</select></td><td>{new Date(application.createdAt).toLocaleDateString()}</td><td><button type="button" onClick={() => void show(application)}>View details</button></td></tr> })}</tbody></table>}
    {totalPages > 1 && <p aria-label="Application pagination"><button type="button" disabled={page <= 1} onClick={() => void load(page - 1)}>Previous</button> Page {page} of {totalPages} <button type="button" disabled={page >= totalPages} onClick={() => void load(page + 1)}>Next</button></p>}
    {selected && <section aria-label="Application details"><h2>{selected.name}</h2><p><strong>Role:</strong> {context(selected)?.title ?? selected.jobId}</p><p><strong>Cover letter:</strong> {selected.coverLetter}</p><p><strong>Consent:</strong> {selected.consent ? 'Confirmed' : 'Not confirmed'}</p><p><button type="button" onClick={() => void download(selected)}>Download resume</button> <button type="button" onClick={() => setSelected(null)}>Close details</button></p><h3>Hiring notes and stage history</h3><label htmlFor="application-note">Add note</label><textarea id="application-note" value={note} maxLength={5000} onChange={(event) => setNote(event.target.value)} /><button type="button" onClick={() => void addNote()}>Save note</button><ul>{history.map((item, index) => <li key={`${item.createdAt}-${index}`}>{item.detail.note ?? `${item.detail.from} → ${item.detail.to}`}</li>)}</ul></section>}
  </main>
}
