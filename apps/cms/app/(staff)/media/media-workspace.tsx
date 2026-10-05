'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react'
import type { MediaAsset } from '../../../src/media-workspace'
import styles from './media-workspace.module.css'

type Data = { assets: MediaAsset[]; total: number; truncated: boolean; page: number; totalPages: number; pageSize: number; focalEditingAvailable: boolean }
type Filter = 'all' | 'missing-alt' | 'unused' | 'large' | 'bin'
type Metadata = { alt: string; decorative: boolean; caption: string; credit: string; tags: string[]; focalX: number; focalY: number }
type View = { filter: Filter; query: string; page: number }
const filters: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' }, { value: 'missing-alt', label: 'Missing alt text' },
  { value: 'unused', label: 'Unused' }, { value: 'large', label: 'Large files' },
  { value: 'bin', label: 'Deletion bin' },
]
const focal = (value?: number | null) => typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(100, Math.max(0, value))) : 50
const metadata = (asset?: MediaAsset): Metadata => ({ alt: asset?.alt ?? '', decorative: Boolean(asset?.decorative), caption: asset?.caption ?? '', credit: asset?.credit ?? '', tags: asset?.tags ?? [], focalX: focal(asset?.focalX), focalY: focal(asset?.focalY) })
const sameMetadata = (left: Metadata, right: Metadata) => JSON.stringify(left) === JSON.stringify(right)
const size = (bytes?: number | null) => !bytes ? 'Size unavailable' : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const dimensions = (asset: MediaAsset) => asset.width && asset.height ? `${asset.width} × ${asset.height}` : 'Dimensions unavailable'

export function MediaWorkspace({ initial }: { initial: Data }) {
  const initialAsset = initial.assets[0]
  const [data, setData] = useState(initial)
  const [selectedID, setSelectedID] = useState(initialAsset?.id ?? '')
  const [baseline, setBaseline] = useState(() => metadata(initialAsset))
  const [draft, setDraft] = useState(() => metadata(initialAsset))
  const [tagText, setTagText] = useState(() => metadata(initialAsset).tags.join(', '))
  const [view, setView] = useState<View>({ filter: 'all', query: '', page: initial.page })
  const [search, setSearch] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [retryView, setRetryView] = useState<View | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadAlt, setUploadAlt] = useState('')
  const [uploadDecorative, setUploadDecorative] = useState(false)
  const [replacementFile, setReplacementFile] = useState<File | null>(null)
  const [replacing, setReplacing] = useState(false)
  const replacementKey = useRef('')
  const replacementInput = useRef<HTMLInputElement>(null)
  const request = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadPanel = useRef<HTMLDivElement>(null)
  const selected = useMemo(() => data.assets.find((asset) => asset.id === selectedID), [data.assets, selectedID])
  const dirty = Boolean(selected) && !sameMetadata(draft, baseline)
  const confirmDiscard = () => !dirty || window.confirm('Discard unsaved media metadata?')

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    const followLink = (event: MouseEvent) => {
      if (!dirty || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (target && !window.confirm('Discard unsaved media metadata?')) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', followLink, true)
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', followLink, true) }
  }, [dirty])

  function useAsset(asset?: MediaAsset) {
    setSelectedID(asset?.id ?? '')
    const next = metadata(asset)
    setBaseline(next)
    setDraft(next)
    setTagText(next.tags.join(', '))
    setReplacementFile(null)
    replacementKey.current = ''
    if (replacementInput.current) replacementInput.current.value = ''
  }

  async function load(next: View, preferredID?: string) {
    const version = ++request.current
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setLoading(true); setError(''); setMessage('')
    try {
      const parameters = new URLSearchParams({ filter: next.filter, q: next.query, page: String(next.page), pageSize: String(data.pageSize || 24) })
      const response = await fetch(`/api/media/workspace?${parameters}`, { signal: controller.signal })
      const body = await response.json() as Data & { error?: string }
      if (version !== request.current) return
      if (!response.ok) throw new Error(body.error ?? 'Unable to load media.')
      setData(body)
      const accepted = { ...next, page: body.page }
      setView(accepted); setSearch(accepted.query); setRetryView(null)
      useAsset(body.assets.find((asset) => asset.id === (preferredID ?? selectedID)) ?? body.assets[0])
    } catch (reason) {
      if (version !== request.current || (reason instanceof DOMException && reason.name === 'AbortError')) return
      setError(reason instanceof Error ? reason.message : 'Unable to load media.'); setRetryView(next)
    } finally { if (version === request.current) setLoading(false) }
  }

  function changeView(next: View) { if (confirmDiscard()) void load(next) }
  function submitSearch(event: FormEvent) { event.preventDefault(); changeView({ filter: view.filter, query: search.trim(), page: 1 }) }
  function select(asset: MediaAsset) { if (asset.id !== selectedID && confirmDiscard()) { useAsset(asset); setError(''); setMessage('') } }

  function setFocalPoint(focalX: number, focalY: number) {
    setDraft((current) => ({ ...current, focalX: focal(focalX), focalY: focal(focalY) }))
  }

  function pointFromPointer(event: PointerEvent<HTMLDivElement>) {
    if (saving || !data.focalEditingAvailable) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setFocalPoint((event.clientX - bounds.left) / bounds.width * 100, (event.clientY - bounds.top) / bounds.height * 100)
  }

  function moveFocalPoint(event: KeyboardEvent<HTMLDivElement>) {
    const amount = event.shiftKey ? 10 : 1
    const movement: Record<string, [number, number]> = { ArrowLeft: [-amount, 0], ArrowRight: [amount, 0], ArrowUp: [0, -amount], ArrowDown: [0, amount] }
    const delta = movement[event.key]
    if (!delta || saving || !data.focalEditingAvailable) return
    event.preventDefault()
    setFocalPoint(draft.focalX + delta[0], draft.focalY + delta[1])
  }

  async function save() {
    if (!selected || saving) return
    setSaving(true); setError(''); setMessage('')
    try {
      const response = await fetch('/api/media/workspace', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: selected.id, ...draft }) })
      const body = await response.json() as { asset?: Partial<Metadata>; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Unable to save metadata.')
      const saved = { ...draft, ...body.asset, tags: body.asset?.tags ?? draft.tags }
      setBaseline(saved); setDraft(saved)
      setTagText(saved.tags.join(', '))
      setData((current) => ({ ...current, assets: current.assets.map((asset) => asset.id === selected.id ? { ...asset, ...saved } : asset) }))
      setMessage('Metadata saved.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save metadata.') } finally { setSaving(false) }
  }

  async function updateLifecycle(action: 'bin' | 'restore') {
    if (!selected || lifecycleBusy || !confirmDiscard()) return
    setLifecycleBusy(true); setError(''); setMessage('')
    try {
      const response = await fetch('/api/media/lifecycle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: selected.id, action }) })
      const body = await response.json() as { error?: string; status?: 'blocked' | 'binned' | 'restored' }
      if (!response.ok) throw new Error(body.error ?? 'Unable to update this asset.')
      if (body.status === 'blocked') { setError('This asset is used on a page and cannot be moved to the deletion bin.'); return }
      await load(view)
      setMessage(action === 'bin' ? 'Asset moved to the deletion bin.' : 'Asset restored.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update this asset.') } finally { setLifecycleBusy(false) }
  }

  async function submitUpload(event: FormEvent) {
    event.preventDefault()
    if (!uploadFile || uploading) return
    if (!uploadDecorative && !uploadAlt.trim()) { setError('Add accurate alt text or mark the image as decorative before uploading.'); return }
    if (!confirmDiscard()) return
    setUploading(true); setError(''); setMessage('')
    try {
      const form = new FormData(); form.set('file', uploadFile); form.set('_payload', JSON.stringify({ alt: uploadDecorative ? '' : uploadAlt.trim(), decorative: uploadDecorative }))
      const response = await fetch('/api/assets', { method: 'POST', body: form })
      const body = await response.json().catch(() => ({})) as { doc?: { id?: string }; errors?: Array<{ message?: string }>; message?: string }
      if (!response.ok) throw new Error(body.errors?.[0]?.message ?? body.message ?? 'Upload failed. Use a supported raster image under 15 MiB.')
      setUploadFile(null); setUploadAlt(''); setUploadDecorative(false); if (fileInput.current) fileInput.current.value = ''
      await load({ filter: 'all', query: '', page: 1 }, body.doc?.id)
      setMessage('Image uploaded.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Upload failed. Use a supported raster image under 15 MiB.') } finally { setUploading(false) }
  }

  async function replaceFile(event: FormEvent) {
    event.preventDefault()
    if (!selected || !replacementFile || replacing || !confirmDiscard()) return
    setReplacing(true); setError(''); setMessage('')
    try {
      if (!replacementKey.current) replacementKey.current = crypto.randomUUID()
      const form = new FormData(); form.set('assetId', selected.id); form.set('idempotencyKey', replacementKey.current); form.set('file', replacementFile)
      const response = await fetch('/api/media/replacement', { method: 'POST', body: form })
      const body = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Unable to replace this asset file.')
      setReplacementFile(null); replacementKey.current = ''; if (replacementInput.current) replacementInput.current.value = ''
      await load({ filter: 'all', query: '', page: 1 }, selected.id)
      setMessage('Asset file replaced. Published snapshots retain the previous file.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to replace this asset file.') } finally { setReplacing(false) }
  }

  const openUpload = () => {
    setUploadOpen(true)
    window.requestAnimationFrame(() => { uploadPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); fileInput.current?.focus() })
  }

  return <main className={styles.workspace} data-media-workspace>
    <h1 className={styles.srOnly}>Media</h1>
    {error ? <div className={styles.feedback} role="alert"><span>{error}</span>{retryView ? <button type="button" onClick={() => void load(retryView)}>Retry</button> : null}</div> : null}
    {message ? <p className={styles.feedback} role="status" aria-live="polite">{message}</p> : null}
    <div className={styles.layout} data-media-layout>
      <section className={styles.library} data-media-library aria-label="Media library" aria-busy={loading}>
        <div className={styles.toolbar} data-media-toolbar><div className={styles.filters} role="group" aria-label="Media filters">{filters.map(({ value, label }) => <button type="button" key={value} aria-pressed={view.filter === value} disabled={loading} onClick={() => changeView({ filter: value, query: view.query, page: 1 })}>{label}</button>)}</div><div className={styles.toolbarEnd}><span className={styles.count}>{data.total} {data.total === 1 ? 'asset' : 'assets'}</span><button type="button" className={styles.primary} data-media-primary onClick={openUpload}>Upload new asset</button></div></div>
        <form className={styles.search} role="search" onSubmit={submitSearch}><label htmlFor="media-search">Search media</label><div><input id="media-search" value={search} maxLength={80} onChange={(event) => setSearch(event.target.value)} /><button type="submit">Search</button></div></form>
        {uploadOpen ? <div ref={uploadPanel} className={styles.uploadPanel} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) setUploadFile(file) }}>
          <form onSubmit={submitUpload}>
            <div className={styles.uploadIntro}><div><strong>Upload a new image</strong><span>PNG, JPEG, WebP, or AVIF up to 15 MiB</span></div><label className={styles.fileButton}>Choose image<input ref={fileInput} type="file" accept="image/avif,image/jpeg,image/png,image/webp" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} /></label></div>
            <p className={styles.chosenFile}>{uploadFile ? uploadFile.name : 'Drop an image here or choose a file.'}</p>
            <div className={styles.uploadMetadata}>
              <label htmlFor="upload-alt">Alt text<input id="upload-alt" value={uploadAlt} maxLength={240} disabled={uploadDecorative || uploading} onChange={(event) => setUploadAlt(event.target.value)} /></label>
              <label className={styles.checkLabel}><input type="checkbox" checked={uploadDecorative} disabled={uploading} onChange={(event) => setUploadDecorative(event.target.checked)} />Decorative image</label>
              <button className={styles.primary} data-media-primary type="submit" disabled={!uploadFile || uploading || (!uploadDecorative && !uploadAlt.trim())}>{uploading ? 'Uploading…' : 'Upload image'}</button>
            </div><small>{uploadDecorative ? 'Decorative images have no alt text.' : 'Describe the image’s purpose. Do not use its filename as alt text.'}</small>
          </form>
        </div> : null}
        <div className={styles.grid} data-media-grid>{data.assets.map((asset) => <button type="button" key={asset.id} className={styles.card} data-media-asset aria-pressed={selectedID === asset.id} onClick={() => select(asset)}><span className={styles.thumb}>{asset.url ? <img src={asset.url} alt="" /> : <span>Preview unavailable</span>}</span><span className={styles.cardCopy}><strong>{asset.filename}</strong><small>{dimensions(asset)} · {size(asset.filesize)}</small>{!asset.decorative && !asset.alt?.trim() ? <em>Missing alt text</em> : null}{(asset.filesize ?? 0) > 3 * 1024 * 1024 ? <em className={styles.warning}>Large file</em> : null}</span></button>)}</div>
        {!data.assets.length ? <div className={styles.empty} data-media-empty><strong>No matching media</strong><span>Try another search or filter.</span></div> : null}
        <nav className={styles.pagination} aria-label="Media pages"><button type="button" disabled={loading || view.page <= 1} onClick={() => changeView({ ...view, page: view.page - 1 })}>Previous</button><span>Page {view.page} of {data.totalPages}</span><button type="button" disabled={loading || view.page >= data.totalPages} onClick={() => changeView({ ...view, page: view.page + 1 })}>Next</button></nav>
      </section>
      <aside className={styles.detail} aria-label="Selected media" data-media-detail>{selected ? <>
        <header className={styles.detailHeading}><div><h2>{selected.filename}</h2><span>{selected.id}</span></div><p>{selected.mimeType} · {dimensions(selected)} · {size(selected.filesize)}</p></header>
        <div className={styles.detailBody}>
          <section className={styles.focalEditor} aria-labelledby="focal-heading">
            <div><h3 id="focal-heading">Focal point</h3><p>{data.focalEditingAvailable ? 'Choose the most important part of the image. Use arrow keys for precise changes; hold Shift for larger steps.' : 'Focal-point editing becomes available when the active site theme supports contract 1.4.'}</p></div>
            <div className={styles.preview} data-media-preview data-media-focal data-media-focal-available={data.focalEditingAvailable} tabIndex={selected.url && data.focalEditingAvailable ? 0 : -1} role="group" aria-label={`Focal point ${draft.focalX}% from the left and ${draft.focalY}% from the top`} aria-disabled={!data.focalEditingAvailable} onPointerDown={pointFromPointer} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) pointFromPointer(event) }} onKeyDown={moveFocalPoint}>
              {selected.url ? <><img src={selected.url} alt="" draggable={false} /><span className={styles.focalMarker} data-media-focal-marker style={{ left: `${draft.focalX}%`, top: `${draft.focalY}%` }} aria-hidden="true" /></> : <span>Preview unavailable</span>}
            </div>
            <div className={styles.focalInputs}>
              <label htmlFor="asset-focal-x">Horizontal (%)<input id="asset-focal-x" type="number" min="0" max="100" step="1" value={draft.focalX} disabled={saving || !data.focalEditingAvailable} onChange={(event) => setFocalPoint(event.currentTarget.valueAsNumber, draft.focalY)} /></label>
              <label htmlFor="asset-focal-y">Vertical (%)<input id="asset-focal-y" type="number" min="0" max="100" step="1" value={draft.focalY} disabled={saving || !data.focalEditingAvailable} onChange={(event) => setFocalPoint(draft.focalX, event.currentTarget.valueAsNumber)} /></label>
            </div>
            {selected.url ? <div className={styles.cropPreviews} aria-label="Crop previews">
              <figure><div className={styles.cropHero} data-media-crop-preview="hero"><img src={selected.url} alt="" style={{ objectPosition: `${draft.focalX}% ${draft.focalY}%` }} /></div><figcaption>Wide · 16:9</figcaption></figure>
              <figure><div className={styles.cropCard} data-media-crop-preview="card"><img src={selected.url} alt="" style={{ objectPosition: `${draft.focalX}% ${draft.focalY}%` }} /></div><figcaption>Portrait · 4:5</figcaption></figure>
              <figure><div className={styles.cropSquare} data-media-crop-preview="square"><img src={selected.url} alt="" style={{ objectPosition: `${draft.focalX}% ${draft.focalY}%` }} /></div><figcaption>Square · 1:1</figcaption></figure>
            </div> : null}
          </section>
          <label htmlFor="asset-alt">Alt text<textarea id="asset-alt" rows={3} value={draft.alt} maxLength={240} disabled={draft.decorative || saving} onChange={(event) => setDraft((current) => ({ ...current, alt: event.target.value }))} /><small>{draft.decorative ? 'Decorative images do not need alt text.' : 'Describe the image’s purpose and relevant content.'}</small></label>
          <label className={styles.checkLabel}><input type="checkbox" checked={draft.decorative} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, decorative: event.target.checked }))} />Decorative image</label>
          <label htmlFor="asset-caption">Caption<textarea id="asset-caption" rows={2} value={draft.caption} maxLength={300} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, caption: event.target.value }))} /></label>
          <label htmlFor="asset-credit">Credit<input id="asset-credit" value={draft.credit} maxLength={240} disabled={saving} onChange={(event) => setDraft((current) => ({ ...current, credit: event.target.value }))} /></label>
          <label htmlFor="asset-tags">Tags<input id="asset-tags" value={tagText} disabled={saving} onChange={(event) => { setTagText(event.target.value); setDraft((current) => ({ ...current, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 12) })) }} /><small>Separate up to 12 tags with commas.</small></label>
          <button type="button" className={styles.primary} data-media-primary onClick={() => void save()} disabled={saving || !dirty || (!draft.decorative && !draft.alt.trim())}>{saving ? 'Saving…' : 'Save metadata'}</button>
          <section className={styles.usage}><h3>Used in</h3>{selected.usages.length ? <ul>{selected.usages.map((usage) => <li key={usage.pageId}><a href={`/content-editor/${encodeURIComponent(usage.pageId)}`}>{usage.pageTitle}</a></li>)}</ul> : <p>Not used on any page.</p>}</section>
          <p className={styles.immutable}>File replacements create an immutable version. Existing published snapshots keep their original file.</p>
          <form className={styles.replaceFile} data-media-replacement onSubmit={replaceFile}><label htmlFor="asset-replacement">Replace file<input ref={replacementInput} id="asset-replacement" type="file" accept="image/avif,image/jpeg,image/png,image/webp" disabled={replacing} onChange={(event) => { setReplacementFile(event.target.files?.[0] ?? null); replacementKey.current = crypto.randomUUID() }} /></label><button type="submit" disabled={!replacementFile || replacing}>{replacing ? 'Replacing…' : 'Replace file'}</button><small>The asset ID stays the same. Published snapshots retain the previous file.</small></form>
          <div className={styles.actions} data-media-actions><button type="button" onClick={openUpload}>Upload new asset</button>{selected.deletedAt ? <button type="button" disabled={lifecycleBusy} onClick={() => void updateLifecycle('restore')}>{lifecycleBusy ? 'Restoring…' : 'Restore'}</button> : <button type="button" className={styles.danger} disabled={lifecycleBusy || selected.usages.length > 0} title={selected.usages.length ? 'Remove this asset from every page before deleting it.' : 'Move this asset to the deletion bin.'} onClick={() => void updateLifecycle('bin')}>{lifecycleBusy ? 'Moving…' : 'Move to bin'}</button>}</div>
        </div></> : <div className={styles.empty} data-media-empty><strong>Select an asset</strong><span>Choose an item to inspect its metadata and usage.</span></div>}</aside>
    </div>
  </main>
}
