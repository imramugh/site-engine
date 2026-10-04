'use client'

import { useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Page } from '@site-engine/contract'
import type { PageCreationContext, PageCreationParent } from '../../../../src/page-creator'
import styles from './new-page.module.css'

export const slugFromTitle = (value: string): string => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 120)
  .replace(/-$/g, '')

export function availableParents(
  pages: readonly PageCreationParent[],
  sectionID: string,
  template: Page['template'],
): PageCreationParent[] {
  return pages.filter((page) => page.sectionID === sectionID && page.depth < 3 && (template !== 'service' || page.template === 'pillar'))
}

function pathFor(parent: PageCreationParent | undefined, sectionSlug: string, pages: readonly PageCreationParent[], slug: string): string {
  const segments: string[] = []
  const byID = new Map(pages.map((page) => [page.id, page]))
  let current = parent
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    segments.unshift(current.slug)
    current = current.parentID ? byID.get(current.parentID) : undefined
  }
  return `/${[sectionSlug, ...segments, slug || 'page-url'].filter(Boolean).join('/')}`
}

export function NewPage({ context }: { context: PageCreationContext }) {
  const initialSection = context.sections[0]
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [slug, setSlug] = useState('')
  const slugWasEdited = useRef(false)
  const [sectionID, setSectionID] = useState(initialSection?.id ?? '')
  const [template, setTemplate] = useState<Page['template']>(initialSection?.allowedTemplates[0] ?? context.templates[0] ?? 'standard')
  const [parentID, setParentID] = useState('')
  const [requestKey] = useState(() => crypto.randomUUID())
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [error, setError] = useState('')
  const section = context.sections.find((item) => item.id === sectionID)
  const parents = useMemo(() => availableParents(context.pages, sectionID, template), [context.pages, sectionID, template])
  const selectedParent = parents.find((page) => page.id === parentID)
  const path = pathFor(selectedParent, section?.slug ?? '', context.pages, slug)

  const changeSection = (nextID: string) => {
    const next = context.sections.find((item) => item.id === nextID)
    setSectionID(nextID)
    setTemplate(next?.allowedTemplates[0] ?? context.templates[0] ?? 'standard')
    setParentID('')
  }
  const changeTemplate = (next: Page['template']) => {
    setTemplate(next)
    const valid = availableParents(context.pages, sectionID, next).some((page) => page.id === parentID)
    if (!valid) setParentID('')
  }
  const changeTitle = (next: string) => {
    setTitle(next)
    if (!slugWasEdited.current) setSlug(slugFromTitle(next))
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setState('saving')
    setError('')
    try {
      const response = await fetch('/api/editorial/page-editor/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestKey, title, summary, slug, sectionID, ...(parentID ? { parentID } : {}), template }),
      })
      const body = await response.json() as { pageID?: string; error?: string }
      if (!response.ok || !body.pageID) throw new Error(body.error || 'The page draft could not be created.')
      window.location.assign(`/content-editor/${body.pageID}`)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'The page draft could not be created.')
      setState('error')
    }
  }

  return <main className={styles.creator} data-page-create>
    <header className={styles.header}>
      <nav aria-label="Breadcrumb"><a href="/content-tree">Pages</a><span aria-hidden="true"> / </span><span>New page</span></nav>
      <h1>Create page</h1>
      <p>Start a draft in its own change set. It stays private until review and publication are complete.</p>
    </header>
    {!context.sections.length ? <section className={styles.empty} role="alert" data-page-create-empty>
      <h2>A content section is required</h2>
      <p>Create or request a section with an allowed page template before adding a page.</p>
      <a href="/content-tree">Return to Pages</a>
    </section> : <form onSubmit={submit} data-page-create-form>
      <section className={styles.fields} aria-labelledby="page-details-title" data-page-create-fields>
        <h2 id="page-details-title">Page details</h2>
        <div className={styles.control}><label htmlFor="page-create-title">Title</label><input id="page-create-title" required maxLength={160} value={title} onChange={(event) => changeTitle(event.target.value)} autoFocus /></div>
        <div className={styles.control}><label htmlFor="page-create-summary">Summary</label><textarea id="page-create-summary" required minLength={24} maxLength={300} rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} aria-describedby="page-create-summary-help" /><small id="page-create-summary-help">{summary.length}/300 · at least 24 characters</small></div>
        <div className={styles.control}><label htmlFor="page-create-slug">URL segment</label><input id="page-create-slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={120} value={slug} onChange={(event) => { slugWasEdited.current = true; setSlug(event.target.value) }} aria-describedby="page-create-slug-help" /><small id="page-create-slug-help">Preview: <code>{path}</code></small></div>
      </section>
      <section className={styles.structure} aria-labelledby="page-structure-title" data-page-create-structure>
        <h2 id="page-structure-title">Page structure</h2>
        <div className={styles.control}><label htmlFor="page-create-section">Section</label><select id="page-create-section" required value={sectionID} onChange={(event) => changeSection(event.target.value)}>{context.sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        <div className={styles.control}><label htmlFor="page-create-template">Template</label><select id="page-create-template" required value={template} onChange={(event) => changeTemplate(event.target.value as Page['template'])} aria-describedby="page-create-template-help">{section?.allowedTemplates.map((item) => <option key={item} value={item}>{item}</option>)}</select><small id="page-create-template-help">Available templates are set by this section.</small></div>
        <div className={styles.control}><label htmlFor="page-create-parent">Parent page{template === 'service' ? ' (required)' : ' (optional)'}</label><select id="page-create-parent" required={template === 'service'} value={parentID} onChange={(event) => setParentID(event.target.value)} aria-describedby="page-create-parent-help"><option value="">{template === 'service' ? 'Select a pillar page' : 'Top level'}</option>{parents.map((page) => <option key={page.id} value={page.id}>{page.title} · /{page.slug}</option>)}</select><small id="page-create-parent-help">Pages can be at most three levels deep. Service pages require a pillar parent.</small></div>
      </section>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <footer className={styles.actions} data-page-create-actions><a href="/content-tree">Cancel</a><button type="submit" disabled={state === 'saving'}>{state === 'saving' ? 'Creating…' : 'Create draft'}</button></footer>
    </form>}
  </main>
}
