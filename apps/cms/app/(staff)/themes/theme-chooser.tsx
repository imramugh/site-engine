'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import styles from './theme-chooser.module.css'

type Theme = { id: string; version: string; contract: string; standardBlocks: string[]; settingKeys: string[]; compatibility: { compatible: boolean; actions: Array<{ action: string; pageID: string; blockID: string; reason: string }> } }
type Selection = { id: string; version: string; contract: string } | null
type ChangeSet = { id: string; name: string; state: string; includedChangeKeys: string[] }
type Data = { themes: Theme[]; publishedSelection: Selection; draftSelection: Selection; draftChangeSet: ChangeSet | null }
type EditorialSet = { id: string; preview?: { status?: string } }

const displayName = (value: string) => value.split('-').filter(Boolean).map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ')
const sameSelection = (theme: Theme, selection: Selection) => Boolean(selection && theme.id === selection.id && theme.version === selection.version)
function compareVersions(left: Theme, right: Theme) {
  const a = left.version.split(/[.-]/).map(Number); const b = right.version.split(/[.-]/).map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) if ((a[index] || 0) !== (b[index] || 0)) return (b[index] || 0) - (a[index] || 0)
  return 0
}

export function ThemeChooser({ embedded = false }: { embedded?: boolean }) {
  const [data, setData] = useState<Data | null>(null)
  const [versions, setVersions] = useState<Record<string, string>>({})
  const [openFamily, setOpenFamily] = useState<string | null>(null)
  const [changeSetName, setChangeSetName] = useState('Preview theme with current content')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ setID: string; status: 'queued' | 'ready' } | null>(null)

  const load = useCallback(async (quiet = false) => {
    try {
      const response = await fetch('/api/themes', { cache: 'no-store' })
      if (!response.ok) { setData(null); setMessage(response.status === 403 ? 'Owner access is required to manage themes.' : 'Unable to load themes. Check your connection and try again.'); return }
      const next = await response.json() as Data
      setData(next)
      setVersions(current => {
        const result = { ...current }
        const grouped = new Map<string, Theme[]>()
        for (const theme of next.themes) grouped.set(theme.id, [...(grouped.get(theme.id) ?? []), theme])
        for (const [id, themes] of grouped) {
          const ordered = themes.sort(compareVersions)
          result[id] = ordered.find(theme => sameSelection(theme, next.draftSelection))?.version
            ?? ordered.find(theme => sameSelection(theme, next.publishedSelection))?.version
            ?? ordered.find(theme => theme.version === current[id])?.version
            ?? ordered[0]!.version
        }
        return result
      })
      if (!quiet) setMessage('')
    } catch { setMessage('Unable to load themes. Check your connection and try again.') }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!preview || preview.status === 'ready') return
    let active = true
    const check = async () => {
      try {
        const response = await fetch('/api/editorial/list', { cache: 'no-store' }); if (!response.ok) return
        const body = await response.json() as { sets?: EditorialSet[] }
        if (active && body.sets?.find(set => set.id === preview.setID)?.preview?.status === 'ready') { setPreview({ ...preview, status: 'ready' }); setMessage('The protected reviewed preview is ready.') }
      } catch { /* A later poll can recover without discarding the reviewed draft. */ }
    }
    void check(); const timer = window.setInterval(() => void check(), 4_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [preview])

  const families = useMemo(() => {
    const grouped = new Map<string, Theme[]>()
    for (const theme of data?.themes ?? []) grouped.set(theme.id, [...(grouped.get(theme.id) ?? []), theme])
    return [...grouped].map(([id, themes]) => ({ id, themes: themes.sort(compareVersions) }))
  }, [data])

  async function createPreview(theme: Theme) {
    if (busy || !theme.compatibility.compatible) return
    setBusy(true); setMessage('')
    try {
      const captured = await fetch('/api/themes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: theme.id, version: theme.version, changeSetName }) })
      const body = await captured.json() as { error?: string; changeSet?: ChangeSet; reused?: boolean }
      if (!captured.ok || !body.changeSet) throw new Error(body.error ?? 'Unable to create the reviewed theme draft.')
      const set = body.changeSet; let keys = set.includedChangeKeys ?? []
      if (set.state !== 'submitted') {
        const submitted = await fetch('/api/editorial/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: set.id }) })
        const result = await submitted.json() as { error?: string; changes?: Array<{ collection?: string; id?: string }> }
        if (!submitted.ok) throw new Error(result.error ?? 'Unable to submit the reviewed theme draft.')
        keys = result.changes?.filter(change => change.collection === 'theme-settings' && typeof change.id === 'string').map(change => `theme-settings:${change.id}`) ?? []
      }
      if (!keys.length) throw new Error('The reviewed theme draft does not contain a theme selection.')
      const prepared = await fetch('/api/editorial/prepare-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: set.id, includedChangeKeys: keys }) })
      const result = await prepared.json() as { error?: string }
      if (!prepared.ok) throw new Error(result.error ?? 'Unable to queue the protected preview.')
      setPreview({ setID: set.id, status: 'queued' }); setOpenFamily(theme.id)
      setMessage(`${body.reused ? 'Existing' : 'New'} reviewed draft submitted. The protected preview is queued.`)
      await load(true)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to create the reviewed theme preview. Try again.') }
    finally { setBusy(false) }
  }

  const Wrapper = embedded ? 'div' : 'main'
  return <Wrapper data-theme-chooser data-theme-embedded={embedded ? 'true' : undefined} className={`${styles.workspace} ${embedded ? styles.embedded : ''}`} aria-busy={!data || busy}>
    {embedded
      ? <h2 className={styles.srOnly}>Themes</h2>
      : <header className={styles.heading}><div><h1>Themes</h1><p>Choose how the current content is presented, then review the exact result before publishing.</p></div><a href="/editorial">Editorial review</a></header>}
    <p className={styles.message} role="status" aria-live="polite">{message || (!data ? 'Loading installed themes…' : '')}</p>
    {data && <>
      {!embedded && <p className={styles.selectionSummary} aria-label="Current theme selections"><span><strong>Published</strong> {data.publishedSelection ? `${displayName(data.publishedSelection.id)} ${data.publishedSelection.version}` : 'No explicit theme'}</span>{data.draftSelection && <span><strong>Reviewed draft</strong> {displayName(data.draftSelection.id)} {data.draftSelection.version}</span>}</p>}
      {data.draftSelection && !data.draftChangeSet && <p className={styles.pendingConflict} role="note">Another reviewed draft controls the pending theme selection. Resolve or discard that draft before creating a different theme preview.</p>}
      <section className={styles.grid} aria-label="Installed theme families" data-theme-grid>
        {families.map(family => {
          const theme = family.themes.find(item => item.version === versions[family.id]) ?? family.themes[0]!
          const active = sameSelection(theme, data.publishedSelection); const drafted = sameSelection(theme, data.draftSelection); const expanded = openFamily === family.id
          const status = active ? 'Active' : drafted ? 'Reviewed draft' : theme.compatibility.compatible ? 'Available' : 'Needs upgrade'
          return <article key={family.id} className={styles.card} data-theme-card data-theme-family={family.id} data-theme-status={status.toLowerCase().replaceAll(' ', '-')}>
            <div className={styles.preview} data-theme-preview aria-hidden="true"><span /><span /><span /></div>
            <div className={styles.cardBody}>
              <header><div><h3>{displayName(family.id)}</h3><p>Installed presentation · Version {theme.version}</p></div><span className={styles.status}>{status}</span></header>
              {!theme.compatibility.compatible && <div className={styles.compatibility} role="note"><strong>Current content is not compatible.</strong><ul>{theme.compatibility.actions.map((action, index) => <li key={`${action.action}-${action.pageID}-${action.blockID}-${index}`}>{action.reason.replaceAll('-', ' ')}</li>)}</ul></div>}
              {active && theme.settingKeys.length === 0 && <p className={styles.settings}>No theme-specific settings.</p>}
              {theme.settingKeys.length > 0 && <p className={styles.settings}>Theme-specific settings are not available in this workspace.</p>}
              <details className={styles.technical}><summary>Theme options</summary>{family.themes.length > 1 && <label>Installed version<select value={theme.version} onChange={event => { setVersions(current => ({ ...current, [family.id]: event.target.value })); setOpenFamily(null); setPreview(null) }}>{family.themes.map(item => <option key={item.version} value={item.version}>{item.version}</option>)}</select></label>}<p>Contract {theme.contract}</p></details>
              {active
                ? <a className={styles.currentPreview} href="/" target="_blank" rel="noreferrer">Preview current site <span aria-hidden="true">↗</span></a>
                : <button type="button" data-theme-primary disabled={!theme.compatibility.compatible || busy || Boolean(data.draftSelection && !data.draftChangeSet)} aria-expanded={expanded} onClick={() => setOpenFamily(expanded ? null : family.id)}>{drafted ? 'Prepare reviewed preview' : 'Create reviewed preview'}</button>}
              {expanded && !active && theme.compatibility.compatible && <div className={styles.reviewDraft} data-theme-review-draft><label htmlFor={`theme-change-set-${family.id}`}>Reviewed draft name</label><input id={`theme-change-set-${family.id}`} value={changeSetName} maxLength={120} required onChange={event => setChangeSetName(event.target.value)} /><button type="button" data-theme-primary disabled={busy || !changeSetName.trim()} onClick={() => void createPreview(theme)}>{busy ? 'Preparing…' : 'Create reviewed draft and preview'}</button><small>This creates or reuses your reviewed draft, submits it, and queues a protected preview. It does not publish the theme.</small></div>}
              {preview?.setID && expanded && <div className={styles.previewResult}>{preview.status === 'ready' ? <a data-theme-protected-preview href={`/review/${preview.setID}`}>Open protected preview</a> : <span>Protected preview queued</span>}<a href={`/editorial?changeSet=${preview.setID}`}>View reviewed draft</a></div>}
            </div>
          </article>
        })}
      </section>
    </>}
  </Wrapper>
}
