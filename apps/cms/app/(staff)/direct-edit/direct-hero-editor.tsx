'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { directEditChecks, directEditDefinition, uniqueDirectEditMatch, type DirectEditField } from '../../../src/direct-edit-fields'
import styles from './direct-hero-editor.module.css'

type EditableBlock = { id: string; type: string; fields: Partial<Record<DirectEditField, string>> }
type Page = { id: string; title: string; blocks: EditableBlock[] }
type ChangeSet = { id: string; name: string; state: string; revision: number }
type Data = { pages: Page[]; changeSets: ChangeSet[]; truncated?: boolean }
type Preview = { id: string; status: string; path?: string }

const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map((part) => part.toString(16).padStart(2, '0')).join('')

export function DirectHeroEditor() {
  const [data, setData] = useState<Data>({ pages: [], changeSets: [] })
  const [pageID, setPageID] = useState('')
  const [changeSetID, setChangeSetID] = useState('')
  const [message, setMessage] = useState('Loading editable drafts…')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Preview>()
  const [editMode, setEditMode] = useState(false)
  const [activeBlockID, setActiveBlockID] = useState<string>()
  const [activeField, setActiveField] = useState<DirectEditField>()
  const [value, setValue] = useState('')
  const [previewMappable, setPreviewMappable] = useState<boolean>()
  const timer = useRef<number | undefined>(undefined)
  const requestVersion = useRef(0)
  const previewFrame = useRef<HTMLIFrameElement>(null)
  const activeNode = useRef<HTMLElement | undefined>(undefined)
  const frameCleanup = useRef<() => void>(() => undefined)

  const page = useMemo(() => data.pages.find((item) => item.id === pageID) ?? data.pages[0], [data.pages, pageID])
  const changeSet = useMemo(() => data.changeSets.find((item) => item.id === changeSetID) ?? data.changeSets[0], [data.changeSets, changeSetID])
  const activeBlock = page?.blocks.find((block) => block.id === activeBlockID)
  const original = activeField && activeBlock ? activeBlock.fields[activeField] ?? '' : ''
  const dirty = Boolean(activeField && value !== original)
  const checks = activeField && activeBlock ? directEditChecks(activeBlock.type, activeField, value) : []
  const valid = checks.length > 0 && checks.every((check) => check.passed)

  const stopPolling = useCallback(() => {
    requestVersion.current += 1
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = undefined
  }, [])

  const clearPreview = useCallback(() => {
    stopPolling()
    frameCleanup.current()
    setPreview(undefined)
    setPreviewMappable(undefined)
    setEditMode(false)
    setActiveBlockID(undefined)
    setActiveField(undefined)
  }, [stopPolling])

  const load = useCallback(async (): Promise<Data> => {
    const response = await fetch('/api/editorial/direct-edit/context', { cache: 'no-store' })
    const next = await response.json() as Data & { error?: string }
    if (!response.ok) throw new Error(next.error || 'Unable to load editable drafts.')
    setData(next)
    setPageID((current) => next.pages.some((item) => item.id === current) ? current : next.pages[0]?.id ?? '')
    setChangeSetID((current) => next.changeSets.some((item) => item.id === current) ? current : next.changeSets[0]?.id ?? '')
    return next
  }, [])

  useEffect(() => { void load().then(() => setMessage('')).catch((error: Error) => setMessage(error.message)); return () => { stopPolling(); frameCleanup.current() } }, [load, stopPolling])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const poll = useCallback(async (id: string, version: number, selectedPageID: string) => {
    try {
      const response = await fetch(`/api/editorial/direct-edit/preview?jobID=${id}&pageID=${selectedPageID}`, { cache: 'no-store' })
      const result = await response.json() as { job?: Preview; error?: string }
      if (version !== requestVersion.current) return
      if (!response.ok || !result.job) { setMessage(result.error || 'Preview is unavailable.'); setEditMode(false); return }
      setPreview(result.job)
      if (result.job.status === 'completed') { setMessage('Saved draft preview is ready. Turn on Edit mode, then select highlighted text.'); return }
      if (result.job.status === 'failed') { setMessage('Preview could not be created. Direct editing is unavailable; use the full page editor.'); setEditMode(false); return }
      setMessage('Preparing saved draft preview…')
      timer.current = window.setTimeout(() => void poll(id, version, selectedPageID), 1000)
    } catch {
      if (version === requestVersion.current) { setMessage('Preview provider is unavailable. Use the full page editor.'); setEditMode(false) }
    }
  }, [])

  const preparePreview = useCallback(async () => {
    if (!changeSet || !page) return
    stopPolling(); frameCleanup.current(); setPreview(undefined); setPreviewMappable(undefined); setEditMode(false); setActiveBlockID(undefined); setActiveField(undefined)
    const version = requestVersion.current
    setBusy(true); setMessage('Preparing saved draft preview…')
    try {
      const response = await fetch('/api/editorial/direct-edit/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changeSetID: changeSet.id }) })
      const result = await response.json() as { job?: Preview; error?: string }
      if (!response.ok || !result.job) throw new Error(result.error || 'Preview is unavailable.')
      setPreview(result.job)
      await poll(result.job.id, version, page.id)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Preview provider is unavailable. Use the full page editor.')
      setEditMode(false)
    } finally { setBusy(false) }
  }, [changeSet, page, poll, stopPolling])

  const cancel = useCallback(() => {
    if (activeNode.current && activeField && activeBlock) {
      activeNode.current.textContent = activeBlock.fields[activeField] ?? ''
      activeNode.current.contentEditable = 'false'
      activeNode.current.focus()
    }
    activeNode.current = undefined; setActiveBlockID(undefined); setActiveField(undefined); setValue('')
    setMessage('Edit cancelled. The saved draft is unchanged.')
  }, [activeBlock, activeField])

  const wirePreview = useCallback(() => {
    frameCleanup.current()
    const document = previewFrame.current?.contentDocument
    if (!document || !page) { setPreviewMappable(false); return }
    const stylesheet = document.createElement('link')
    stylesheet.dataset.directEditStyle = 'true'
    stylesheet.rel = 'stylesheet'
    stylesheet.href = '/api/editorial/direct-edit/style'
    document.head.append(stylesheet); document.documentElement.dataset.directEditMode = String(editMode)
    const cleanups: Array<() => void> = []
    let mappedCount = 0
    const matchingNode = (container: HTMLElement, block: EditableBlock, field: DirectEditField): HTMLElement | undefined => {
      const definition = directEditDefinition(block.type, field)
      const expected = block.fields[field]
      if (!definition || expected === undefined) return undefined
      const candidates = definition.selectors.flatMap((selector) => [...container.querySelectorAll<HTMLElement>(selector)])
      return uniqueDirectEditMatch(candidates, (candidate) => candidate.textContent?.trim() === expected)
    }
    page.blocks.forEach((editableBlock) => {
      const identified = [...document.querySelectorAll<HTMLElement>('[data-block-id]')].filter((candidate) => candidate.dataset.blockId === editableBlock.id)
      const typed = [...document.querySelectorAll<HTMLElement>('[data-block-type], [data-block]')].filter((candidate) => candidate.dataset.blockType === editableBlock.type || candidate.dataset.block === editableBlock.type)
      const fields = Object.keys(editableBlock.fields) as DirectEditField[]
      const block = identified.length === 1
        ? identified[0]
        : identified.length === 0
          ? uniqueDirectEditMatch(typed, (candidate) => fields.every((field) => Boolean(matchingNode(candidate, editableBlock, field))))
          : undefined
      if (!block) return
      fields.forEach((field) => {
        const expected = editableBlock.fields[field]
        const node = matchingNode(block, editableBlock, field)
        if (!node || expected === undefined) return
        mappedCount += 1
        const priorTabIndex = node.getAttribute('tabindex')
        const priorLabel = node.getAttribute('aria-label')
        node.dataset.directEditBlock = editableBlock.id
        node.dataset.directEditField = field
        node.tabIndex = editMode ? 0 : -1
        if (editMode) node.setAttribute('aria-label', `Edit ${editableBlock.type} ${field}: ${expected}`)
        const activate = (event: Event) => {
          if (!editMode) return
          event.preventDefault(); event.stopPropagation()
          if (activeNode.current && activeNode.current !== node) return
          activeNode.current = node; node.contentEditable = 'plaintext-only'; setActiveBlockID(editableBlock.id); setActiveField(field); setValue(node.innerText)
          setMessage(`Editing ${editableBlock.type} ${field} in the rendered page. Escape cancels.`); node.focus()
          const selection = document.getSelection(); const range = document.createRange(); range.selectNodeContents(node); selection?.removeAllRanges(); selection?.addRange(range)
        }
        const input = () => setValue(node.innerText.replace(/\r\n/g, '\n'))
        const paste = (event: ClipboardEvent) => {
          event.preventDefault()
          const text = event.clipboardData?.getData('text/plain') ?? ''
          const selection = document.getSelection()
          if (!selection?.rangeCount) return
          const range = selection.getRangeAt(0)
          range.deleteContents()
          const inserted = document.createTextNode(text)
          range.insertNode(inserted)
          range.setStartAfter(inserted); range.collapse(true)
          selection.removeAllRanges(); selection.addRange(range)
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }))
        }
        const keydown = (event: KeyboardEvent) => {
          if ((event.key === 'Enter' || event.key === 'F2') && activeNode.current !== node) {
            activate(event)
            return
          }
          if (event.key === 'Escape' && activeNode.current === node) {
            event.preventDefault(); node.textContent = expected; node.contentEditable = 'false'; node.focus()
            activeNode.current = undefined; setActiveBlockID(undefined); setActiveField(undefined); setValue(''); setMessage('Edit cancelled. The saved draft is unchanged.')
          }
        }
        node.addEventListener('click', activate); node.addEventListener('keydown', keydown); node.addEventListener('input', input); node.addEventListener('paste', paste)
        cleanups.push(() => {
          node.removeEventListener('click', activate); node.removeEventListener('keydown', keydown); node.removeEventListener('input', input); node.removeEventListener('paste', paste)
          node.contentEditable = 'false'; delete node.dataset.directEditBlock; delete node.dataset.directEditField
          priorTabIndex === null ? node.removeAttribute('tabindex') : node.setAttribute('tabindex', priorTabIndex)
          priorLabel === null ? node.removeAttribute('aria-label') : node.setAttribute('aria-label', priorLabel)
        })
      })
    })
    const mapped = mappedCount > 0
    setPreviewMappable(mapped); if (!mapped) setEditMode(false)
    frameCleanup.current = () => { cleanups.forEach((cleanup) => cleanup()); stylesheet.remove(); delete document.documentElement.dataset.directEditMode }
  }, [editMode, page])

  useEffect(() => { if (preview?.status === 'completed') wirePreview() }, [preview?.status, wirePreview])

  const save = async () => {
    if (!page || !activeBlock || !changeSet || !activeField || !dirty || !valid) return
    setBusy(true); setMessage('Saving rendered text to the owned draft…')
    try {
      const response = await fetch('/api/editorial/direct-edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageID: page.id, blockID: activeBlock.id, field: activeField, value, expectedValueHash: await digest(original), expectedRevision: changeSet.revision, changeSetID: changeSet.id }) })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Unable to save this field.')
      activeNode.current = undefined; setActiveBlockID(undefined); setActiveField(undefined); setValue(''); await load()
      setMessage('Draft saved. Rendering the saved proposal…'); await preparePreview()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to save this field.') } finally { setBusy(false) }
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

  const ready = Boolean(page && page.blocks.length && changeSet)
  return <main className={styles.editor} data-direct-edit-workspace>
    <header className={styles.heading}><div><h1>On-page text editor</h1><p>Prepare the saved draft, turn on Edit mode, then select highlighted text.</p></div>{page ? <a className={styles.fallback} href={`/content-editor/${page.id}`}>Open full page editor</a> : null}</header>
    <p role="status" aria-live="polite">{message}</p>{data.truncated ? <p>Some older drafts are not shown. Use the full page editor to find them.</p> : null}
    <div className={styles.selectors}>
      <label>Page <select value={page?.id ?? ''} disabled={busy || dirty} onChange={(event) => { clearPreview(); setPageID(event.target.value) }}>{data.pages.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
      <label>Change set <select value={changeSet?.id ?? ''} disabled={busy || dirty} onChange={(event) => { clearPreview(); setChangeSetID(event.target.value) }}>{data.changeSets.map((item) => <option value={item.id} key={item.id}>{item.name} ({item.state})</option>)}</select></label>
    </div>
    {dirty ? <p className={styles.unsaved}>You have unsaved rendered text. Save or cancel before leaving Edit mode.</p> : null}
    <section className={styles.toolbar} aria-label="On-page editing controls" data-direct-edit-actions>
      <button disabled={!ready || busy || dirty} onClick={() => void preparePreview()}>{preview?.status === 'pending' || preview?.status === 'processing' ? 'Preparing preview…' : 'Prepare saved preview'}</button>
      <button aria-pressed={editMode} disabled={preview?.status !== 'completed' || previewMappable !== true || busy || dirty} onClick={() => setEditMode((current) => !current)}>{editMode ? 'Exit Edit mode' : 'Enter Edit mode'}</button>
      <button disabled={!changeSet || busy || dirty} onClick={() => void submit()}>Submit for review</button>
    </section>
    {previewMappable === false && preview?.status === 'completed' ? <p className={styles.notice}>This renderer does not expose an unambiguous supported text match. Use the full page editor.</p> : null}
    {activeField && activeBlock ? <section className={styles.checks} aria-label="Direct edit checks" data-direct-edit-checks><h2>{activeBlock.type} {activeField}</h2><p>The rendered text is edited as plain text. The saved contract remains the source of truth.</p><ul>{checks.map((check) => <li key={check.id} data-passed={check.passed}>{check.passed ? '✓' : '!'} {check.label}</li>)}</ul><div><button disabled={busy || !dirty || !valid} onClick={() => void save()}>Save rendered text</button><button disabled={busy} onClick={cancel}>Cancel</button></div></section> : null}
    <section className={styles.preview} aria-label="Saved draft preview" data-direct-edit-preview>{preview?.status === 'completed' ? <iframe ref={previewFrame} className={styles.previewFrame} title="Editable saved draft preview" onLoad={wirePreview} src={`/preview/changes/${preview.id}/proposed${preview.path ?? '/'}`} /> : <p>Prepare a saved preview to edit supported rendered text.</p>}</section>
  </main>
}
