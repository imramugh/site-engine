'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './operations-dashboard.module.css'

type Data = { policy: { spamDays: number; mediaBinDays: number }; backupNotice: string; failedJobs: Array<{ id: string; resourceType: string; attempts: number; lastError?: string }> }

export function RetentionPanel() {
  const [data, setData] = useState<Data>()
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    setHost(document.querySelector('main[data-change-log]'))
    void fetch('/api/retention', { cache: 'no-store' }).then(async response => {
      if (response.status === 403) return // Controls are Owner-only.
      if (!response.ok) throw new Error('load')
      const value = await response.json() as Data
      if (active) setData(value)
    }).catch(() => { if (active) setError('Unable to load retention settings. Reload this page to try again.') })
    return () => { active = false }
  }, [])
  if (!host || (!data && !error)) return null
  return createPortal(<section className={styles.card} aria-label="Retention and deletion">
    <h2>Retention and deletion</h2>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {data && <>
      <p>Spam: {data.policy.spamDays} days. Unused media bin: {data.policy.mediaBinDays} days.</p>
      <form className={styles.filters} onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError(''); setNotice('')
        const fields = new FormData(event.currentTarget)
        try {
          const response = await fetch('/api/retention', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spamDays: Number(fields.get('spamDays')), mediaBinDays: Number(fields.get('mediaBinDays')) }) })
          if (!response.ok) throw new Error('Unable to save retention policy. Check your session and try again.')
          const value = await response.json() as { policy: Data['policy'] }
          setData(current => current ? { ...current, policy: value.policy } : current)
          setNotice('Retention policy saved.')
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save retention policy.') }
        finally { setBusy(false) }
      }}>
        <label>Spam days <input name="spamDays" type="number" min="1" max="365" required defaultValue={data.policy.spamDays} /></label>
        <label>Media bin days <input name="mediaBinDays" type="number" min="1" max="365" required defaultValue={data.policy.mediaBinDays} /></label>
        <button disabled={busy}>{busy ? 'Saving…' : 'Save policy'}</button>
      </form>
      <p>{data.backupNotice}</p>
      <h3>Failed purge jobs</h3>
      {data.failedJobs.length ? <ul>{data.failedJobs.map(job => <li key={job.id}>{job.resourceType}: {job.lastError} (attempt {job.attempts})</li>)}</ul> : <p>No failed purge jobs.</p>}
    </>}
  </section>, host)
}
