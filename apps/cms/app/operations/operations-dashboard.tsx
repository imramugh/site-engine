'use client'

import { useEffect, useRef, useState } from 'react'

type Data = {
  summary: {
    pendingReviews: number
    urgentOrNewLeads: number
    latestRelease: { sequence: number; activatedAt: string } | null
    latestPublishFailure: { sequence: number; errorCode?: string } | null
    queue: { pending: number; processing: number; failed: number }
  }
  audit: {
    docs: Array<{ id: string; event: string; actor?: string; actorId?: string; createdAt: string }>
    page: number
    totalPages: number
  }
  shortcuts: Array<{ label: string; href: string }>
}

function failureMessage(response: Response): string {
  return response.status === 403
    ? 'Owner access is required to view operations.'
    : 'Unable to load operations. Check your connection and try again.'
}

export function OperationsDashboard() {
  const [data, setData] = useState<Data>()
  const [error, setError] = useState('')
  const [event, setEvent] = useState('')
  const [actor, setActor] = useState('')
  const [since, setSince] = useState('')
  const [page, setPage] = useState(1)
  const requestID = useRef(0)

  async function load(next = page) {
    const currentRequest = ++requestID.current
    try {
      const result = await fetch(`/api/operations?page=${next}&event=${encodeURIComponent(event)}&actor=${encodeURIComponent(actor)}&since=${encodeURIComponent(since)}`)
      if (currentRequest !== requestID.current) return
      if (!result.ok) {
        setError(failureMessage(result))
        if (result.status === 403) setData(undefined)
        return
      }
      const nextData = await result.json() as Data
      if (currentRequest !== requestID.current) return
      setData(nextData)
      setPage(next)
      setError('')
    } catch {
      if (currentRequest === requestID.current) setError('Unable to load operations. Check your connection and try again.')
    }
  }

  useEffect(() => { void load(1) }, [])

  return <main>
    <h1>Operations</h1>
    {error && <p role="alert">{error}</p>}
    {data && <>
      <section aria-label="Operational summary">
        <h2>Operational summary</h2>
        <ul>
          <li>Pending reviews: {data.summary.pendingReviews}</li>
          <li>Urgent or new leads: {data.summary.urgentOrNewLeads}</li>
          <li>Publish queue: pending {data.summary.queue.pending}, processing {data.summary.queue.processing}, failed {data.summary.queue.failed}</li>
          <li>Latest release: {data.summary.latestRelease ? `#${data.summary.latestRelease.sequence}` : 'None'}</li>
          <li>Latest publish failure: {data.summary.latestPublishFailure ? `#${data.summary.latestPublishFailure.sequence} (${data.summary.latestPublishFailure.errorCode ?? 'unknown error'})` : 'None'}</li>
        </ul>
        <nav aria-label="Operations shortcuts">
          {data.shortcuts.map((item) => <a key={item.href} href={item.href}>{item.label}</a>)}
        </nav>
      </section>
      <section aria-label="Audit timeline">
        <h2>Audit timeline</h2>
        <label htmlFor="event-filter">Filter event</label>
        <input id="event-filter" value={event} onChange={(input) => setEvent(input.target.value)} />
        <label htmlFor="actor-filter">Filter actor</label>
        <input id="actor-filter" value={actor} onChange={(input) => setActor(input.target.value)} />
        <label htmlFor="since-filter">From date</label>
        <input id="since-filter" type="date" value={since} onChange={(input) => setSince(input.target.value)} />
        <button onClick={() => void load(1)}>Apply filter</button>
        <ul>
          {data.audit.docs.map((item) => <li key={item.id}>
            <strong>{item.event}</strong> {item.actor ?? 'System'} <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
          </li>)}
        </ul>
        <button disabled={page <= 1} onClick={() => void load(page - 1)}>Previous</button>
        <button disabled={page >= data.audit.totalPages} onClick={() => void load(page + 1)}>Next</button>
      </section>
    </>}
  </main>
}
