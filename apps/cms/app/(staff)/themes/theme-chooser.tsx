'use client'

import { useEffect, useMemo, useState } from 'react'

type Theme = {
  id: string
  version: string
  contract: string
  standardBlocks: string[]
  settingKeys: string[]
  compatibility: { compatible: boolean; actions: Array<{ action: string; pageID: string; blockID: string; reason: string }> }
}
type Selection = { id: string; version: string; contract: string } | null
type Data = { themes: Theme[]; publishedSelection: Selection; draftSelection: Selection }

function selectionLabel(selection: Selection): string {
  return selection ? `${selection.id} ${selection.version}` : 'None selected'
}

function messageFor(response: Response): string {
  return response.status === 403 ? 'Owner access is required to manage themes.' : 'Unable to load themes. Check your connection and try again.'
}

export function ThemeChooser() {
  const [data, setData] = useState<Data | null>(null)
  const [selectedKey, setSelectedKey] = useState('')
  const [changeSetName, setChangeSetName] = useState('Switch theme')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const response = await fetch('/api/themes', { cache: 'no-store' })
      if (!response.ok) { setMessage(messageFor(response)); setData(null); return }
      const next = await response.json() as Data
      setData(next)
      setSelectedKey((current) => current || (next.draftSelection
        ? `${next.draftSelection.id}@${next.draftSelection.version}`
        : `${next.themes[0]?.id ?? ''}@${next.themes[0]?.version ?? ''}`))
      setMessage('')
    } catch {
      setMessage('Unable to load themes. Check your connection and try again.')
    }
  }

  useEffect(() => { void load() }, [])

  const selected = useMemo(() => data?.themes.find((theme) => `${theme.id}@${theme.version}` === selectedKey), [data, selectedKey])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || saving || !selected.compatibility.compatible) return
    setSaving(true)
    try {
      const response = await fetch('/api/themes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: selected.id, version: selected.version, changeSetName }) })
      const body = await response.json() as { error?: string; changeSet?: { name?: string } }
      if (!response.ok) { setMessage(body.error ?? 'Unable to draft a theme selection.'); return }
      await load()
      setMessage(`Draft theme selection captured in change set “${body.changeSet?.name ?? changeSetName}”. Submit it for review in Editorial review.`)
    } catch {
      setMessage('Unable to draft a theme selection. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return <main>
    <h1>Themes</h1>
    <p>Choose an installed theme for a reviewed editorial change. A selection does not publish a release.</p>
    <p role="status" aria-live="polite">{message || (!data ? 'Loading installed themes…' : '')}</p>
    {data && <>
      <section aria-label="Current theme selections">
        <h2>Current selections</h2>
        <p>Published: {selectionLabel(data.publishedSelection)}</p>
        <p>Draft: {selectionLabel(data.draftSelection)}</p>
      </section>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={saving}>
          <legend>Installed theme</legend>
          <label htmlFor="theme-selection">Theme</label>
          <select id="theme-selection" value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>
            {data.themes.map((theme) => <option key={`${theme.id}@${theme.version}`} value={`${theme.id}@${theme.version}`}>{theme.id} {theme.version}</option>)}
          </select>
          {selected && <section aria-label="Theme compatibility">
            <h2>Compatibility</h2>
            <p>{selected.compatibility.compatible ? 'Compatible with the current published content.' : 'This theme cannot render the current published content.'}</p>
            {selected.compatibility.actions.length > 0 && <ul>{selected.compatibility.actions.map((action) => <li key={`${action.pageID}-${action.blockID}`}>{action.reason.replaceAll('-', ' ')}</li>)}</ul>}
            <p>Supported blocks: {selected.standardBlocks.join(', ') || 'None declared'}</p>
            {selected.settingKeys.length > 0 && <p>Configured settings: {selected.settingKeys.join(', ')}</p>}
          </section>}
          <label htmlFor="theme-change-set-name">Change set name</label>
          <input id="theme-change-set-name" value={changeSetName} onChange={(event) => setChangeSetName(event.target.value)} maxLength={120} required />
          <button type="submit" disabled={!selected?.compatibility.compatible || saving}>{saving ? 'Saving…' : 'Create draft selection'}</button>
        </fieldset>
      </form>
      <p><a href="/editorial">Open Editorial review</a></p>
    </>}
  </main>
}
