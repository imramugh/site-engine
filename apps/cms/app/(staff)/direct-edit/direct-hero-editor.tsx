'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styles from './direct-hero-editor.module.css'

type Hero = { id: string; heading: string; body: string }
type Page = { id: string; title: string; heroes: Hero[] }
type ChangeSet = { id: string; name: string; state: string }
type Data = { pages: Page[]; changeSets: ChangeSet[] }
type Preview = { id: string; status: string; path?: string }

const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map((part) => part.toString(16).padStart(2, '0')).join('')

export function DirectHeroEditor() {
  const [data, setData] = useState<Data>({ pages: [], changeSets: [] })
  const [pageID, setPageID] = useState('')
  const [changeSetID, setChangeSetID] = useState('')
  const [heading, setHeading] = useState('')
  const [body, setBody] = useState('')
  const [message, setMessage] = useState('Loading editable drafts…')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Preview | undefined>()
  const timer = useRef<number | undefined>(undefined)
  const requestVersion = useRef(0)

  const page = useMemo(() => data.pages.find((item) => item.id === pageID) ?? data.pages[0], [data.pages, pageID])
  const changeSet = useMemo(() => data.changeSets.find((item) => item.id === changeSetID) ?? data.changeSets[0], [data.changeSets, changeSetID])
  const hero = page?.heroes[0]
  const headingDirty = Boolean(hero && heading !== hero.heading)
  const bodyDirty = Boolean(hero && body !== hero.body)
  const dirty = headingDirty || bodyDirty
  const clearPreview = useCallback(() => { requestVersion.current += 1; if (timer.current) window.clearTimeout(timer.current); timer.current = undefined; setPreview(undefined) }, [])

  const load = useCallback(async () => {
    const response = await fetch('/api/editorial/direct-edit/context', { cache: 'no-store' })
    const next = await response.json() as Data & { error?: string }
    if (!response.ok) throw new Error(next.error || 'Unable to load editable drafts.')
    setData(next)
    setPageID((current) => next.pages.some((item) => item.id === current) ? current : next.pages[0]?.id ?? '')
    setChangeSetID((current) => next.changeSets.some((item) => item.id === current) ? current : next.changeSets[0]?.id ?? '')
  }, [])

  useEffect(() => { void load().then(() => setMessage('')).catch((error: Error) => setMessage(error.message)); return () => clearPreview() }, [clearPreview, load])
  useEffect(() => { setHeading(hero?.heading ?? ''); setBody(hero?.body ?? '') }, [hero?.id])

  const poll = useCallback(async (id: string, version: number) => {
    try {
      const response = await fetch(`/api/editorial/direct-edit/preview?jobID=${id}&pageID=${page?.id ?? ''}`, { cache: 'no-store' })
      const result = await response.json() as { job?: Preview; error?: string }
      if (version !== requestVersion.current) return
      if (!response.ok || !result.job) { setMessage(result.error || 'Preview is unavailable.'); return }
      setPreview(result.job)
      if (result.job.status === 'completed') { setMessage('Preview is ready.'); return }
      if (result.job.status === 'failed') { setMessage('Preview could not be created.'); return }
      setMessage('Preparing preview…')
      timer.current = window.setTimeout(() => void poll(id, version), 1000)
    } catch {
      if (version === requestVersion.current) setMessage('Preview is unavailable.')
    }
  }, [page?.id])

  const save = async (field: 'heading' | 'body') => {
    if (!page || !hero || !changeSet) return
    clearPreview(); setBusy(true); setMessage('Saving draft…')
    const value = field === 'heading' ? heading : body
    const original = field === 'heading' ? hero.heading : hero.body
    try {
      const response = await fetch('/api/editorial/direct-edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageID: page.id, blockID: hero.id, field, value, expectedValueHash: await digest(original), changeSetID: changeSet.id }) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Unable to save this field.')
      await load(); setMessage('Draft saved.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to save this field.') } finally { setBusy(false) }
  }

  const preparePreview = async () => {
    if (!changeSet) return
    clearPreview(); const version = requestVersion.current; setBusy(true); setMessage('Preparing preview…')
    try {
      const response = await fetch('/api/editorial/direct-edit/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changeSetID: changeSet.id }) })
      const result = await response.json() as { job?: Preview; error?: string }
      if (!response.ok || !result.job) throw new Error(result.error || 'Preview is unavailable.')
      setPreview(result.job); await poll(result.job.id, version)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Preview is unavailable.') } finally { setBusy(false) }
  }

  const submit = async () => {
    if (!changeSet) return
    clearPreview(); setBusy(true); setMessage('Submitting draft…')
    try {
      const response = await fetch('/api/editorial/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: changeSet.id }) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Unable to submit this change set.')
      await load(); setMessage('Submitted for review.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to submit this change set.') } finally { setBusy(false) }
  }

  const ready = Boolean(page && hero && changeSet)
  return <main className={styles.editor}>
    <h1>Hero draft editor</h1>
    <p>Edit a Hero heading or body. Use the <a href="/content-tree">Content tree</a> for other fields.</p>
    <p role="status" aria-live="polite">{message}</p>{(data as Data & { truncated?: boolean }).truncated ? <p>Some older drafts are not shown. Use the standard editor to find them.</p> : null}
    <div className={styles.selectors}>
      <label>Page <select value={page?.id ?? ''} disabled={busy} onChange={(event) => { clearPreview(); setPageID(event.target.value) }}>{data.pages.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
      <label>Change set <select value={changeSet?.id ?? ''} disabled={busy} onChange={(event) => { clearPreview(); setChangeSetID(event.target.value) }}>{data.changeSets.map((item) => <option value={item.id} key={item.id}>{item.name} ({item.state})</option>)}</select></label>
    </div>
    {dirty ? <p className={styles.unsaved}>You have unsaved Hero changes. Save each changed field before submitting for review.</p> : null}
    <div className={styles.workspace}>
      <section>
        {hero ? <>
          <h2>Hero</h2>
          <label>Heading <input value={heading} disabled={busy} onChange={(event) => setHeading(event.target.value)} /></label>
          <button disabled={!ready || busy || !headingDirty} onClick={() => void save('heading')}>Save heading</button>
          <label>Body <textarea value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} /></label>
          <button disabled={!ready || busy || !bodyDirty} onClick={() => void save('body')}>Save body</button>
        </> : <p>No editable Hero is available for this page.</p>}
      </section>
      <section aria-label="Preview">
        <h2>Preview</h2>
        <p>Preview uses the last saved draft. Unsaved fields are not included.</p>
        <button disabled={!changeSet || busy} onClick={() => void preparePreview()}>{preview?.status === 'pending' || preview?.status === 'processing' ? 'Preparing preview…' : 'Prepare preview'}</button>
        {preview?.status === 'completed' ? <iframe className={styles.previewFrame} title="Proposed draft preview" src={`/preview/changes/${preview.id}/proposed${preview.path ?? '/'}`} /> : <p>Prepare a preview after saving your changes.</p>}
      </section>
    </div>
    <button disabled={!changeSet || busy || dirty} onClick={() => void submit()}>Submit for review</button>
  </main>
}
