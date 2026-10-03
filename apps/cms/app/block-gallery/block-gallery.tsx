'use client'
import { useMemo, useState } from 'react'

type Catalog = { type: string; insertable: boolean; allowedTemplates: string[]; fieldLimits: string }
type Page = { id: string; title: string; template: string }
type Set = { id: string; name: string; revision: number }
export function BlockGallery({ catalog, appearance, pages, changeSets }: { catalog: Catalog[]; appearance: Record<string, readonly string[]>; pages: Page[]; changeSets: Set[] }) {
  const [pageID, setPageID] = useState(pages[0]?.id ?? '')
  const [setID, setSetID] = useState(changeSets[0]?.id ?? '')
  const [revision, setRevision] = useState(changeSets[0]?.revision ?? 0)
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const page = pages.find((item) => item.id === pageID)
  const set = changeSets.find((item) => item.id === setID)
  const allowed = useMemo(() => catalog.filter((block) => block.insertable && page && block.allowedTemplates.includes(page.template)), [catalog, page])
  function toggle(type: string) { setSelected((current) => current.includes(type) ? current.filter((item) => item !== type) : [...current, type]) }
  async function insert() {
    if (!page || !set || !selected.length || saving) return
    setSaving(true); setMessage('')
    try {
      const response = await fetch('/api/block-gallery/recipe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageId: page.id, changeSetId: set.id, expectedRevision: revision, blockTypes: selected }) })
      const body = await response.json() as { error?: string; message?: string; changeSetRevision?: number }
      if (response.ok && typeof body.changeSetRevision === 'number') setRevision(body.changeSetRevision)
      setMessage(response.ok ? body.message ?? 'Recipe captured.' : body.error ?? 'Unable to insert this recipe.')
    } catch { setMessage('Unable to insert this recipe. Check your connection and try again.') } finally { setSaving(false) }
  }
  return <main>
    <h1>Block gallery</h1><p>Review supported content blocks before composing a private draft recipe. Inserting a recipe replaces the selected page’s draft blocks and captures the change for review; it does not publish.</p>
    <section aria-label="Appearance controls"><h2>Appearance controls</h2>{Object.entries(appearance).map(([name, values]) => <p key={name}><strong>{name}:</strong> {values.join(', ')}</p>)}</section>
    <section aria-label="Supported blocks"><h2>Supported blocks</h2><ul>{catalog.map((block) => <li key={block.type}><h3>{block.type}</h3><p>Templates: {block.allowedTemplates.join(', ')}</p><p>{block.insertable ? 'Available for draft insertion.' : 'Reference or consent-required: shown for planning only.'}</p><p>{block.fieldLimits}</p></li>)}</ul></section>
    <section aria-label="Draft recipe"><h2>Draft recipe</h2>{!pages.length || !changeSets.length ? <p role="status">Create a draft page and an open change set before inserting a recipe.</p> : <><label htmlFor="recipe-page">Draft page</label><select id="recipe-page" value={pageID} onChange={(event) => { setPageID(event.target.value); setSelected([]) }}>{pages.map((item) => <option key={item.id} value={item.id}>{item.title} ({item.template})</option>)}</select><label htmlFor="recipe-set">Open change set</label><select id="recipe-set" value={setID} onChange={(event) => { setSetID(event.target.value); setRevision(changeSets.find((item) => item.id === event.target.value)?.revision ?? 0) }}>{changeSets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><fieldset disabled={saving}><legend>Blocks allowed by {page?.template}</legend>{allowed.map((block) => <label key={block.type}><input type="checkbox" checked={selected.includes(block.type)} onChange={() => toggle(block.type)} /> {block.type}</label>)}</fieldset><button type="button" onClick={() => void insert()} disabled={!selected.length || saving}>{saving ? 'Saving…' : 'Insert draft recipe'}</button></>}<p role="status" aria-live="polite">{message}</p><p><a href="/admin/editorial">Open Editorial review</a></p></section>
  </main>
}
