'use client'
import { useMemo, useState } from 'react'
import styles from './block-gallery.module.css'

type Catalog = { type: string; name: string; description: string; insertable: boolean; allowedTemplates: string[]; fieldLimits: string }
type Page = { id: string; title: string; template: string }
type Set = { id: string; name: string; revision: number }
type RecipeItem = { key: string; type: string; appearance: { background: string; width: string; spacing: string; motionIntent: string; logoTone: string } }
type Theme = { name: string; version: string; presets: string[] }
type Usage = Record<string, { id: string; title: string }[]>
const defaults = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' }
const templateNames = ['landing', 'standard', 'listing', 'pillar', 'service', 'article', 'job']
const title = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase())

export function BlockGallery({ catalog, appearance, pages, changeSets, usage, theme, previews }: { catalog: Catalog[]; appearance: Record<string, readonly string[]>; pages: Page[]; changeSets: Set[]; usage: Usage; theme?: Theme; previews: Record<string, string> }) {
  const [template, setTemplate] = useState(pages[0]?.template ?? 'standard')
  const compatiblePages = useMemo(() => pages.filter((page) => page.template === template), [pages, template])
  const [pageID, setPageID] = useState(pages[0]?.id ?? '')
  const [setID, setSetID] = useState(changeSets[0]?.id ?? '')
  const [revisions, setRevisions] = useState<Record<string, number>>(() => Object.fromEntries(changeSets.map((set) => [set.id, set.revision])))
  const [recipe, setRecipe] = useState<RecipeItem[]>([])
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID())
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const page = compatiblePages.find((item) => item.id === pageID) ?? compatiblePages[0]
  const set = changeSets.find((item) => item.id === setID)
  const revision = set ? (revisions[set.id] ?? set.revision) : 0
  const exported = JSON.stringify({ tool: 'create_page_from_recipe', recipeVersion: 1, arguments: { template, blocks: recipe.map(({ type, appearance }) => ({ type, appearance })) } }, null, 2)
  function chooseTemplate(next: string) { setTemplate(next); setPageID(pages.find((page) => page.template === next)?.id ?? ''); setRecipe((items) => items.filter((item) => catalog.find((block) => block.type === item.type)?.allowedTemplates.includes(next))) }
  function add(type: string) { setRecipe((items) => [...items, { key: crypto.randomUUID(), type, appearance: { ...defaults } }]) }
  function move(index: number, direction: -1 | 1) { setRecipe((items) => { const next = [...items]; const destination = index + direction; if (destination < 0 || destination >= next.length) return items; [next[index], next[destination]] = [next[destination], next[index]]; return next }) }
  function appearanceAt(index: number, field: keyof RecipeItem['appearance'], value: string) { setRecipe((items) => items.map((item, candidate) => candidate === index ? { ...item, appearance: { ...item.appearance, [field]: value } } : item)) }
  async function copyRecipe() { try { await navigator.clipboard.writeText(exported); setMessage('Structured recipe copied for the approved MCP create_page_from_recipe tool.') } catch { setMessage('Copy failed. Select the recipe JSON and copy it manually.') } }
  async function insert() {
    if (!page || !set || !recipe.length || saving) return
    setSaving(true); setMessage('')
    try {
      const response = await fetch('/api/block-gallery/recipe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageId: page.id, changeSetId: set.id, expectedRevision: revision, requestKey, blocks: recipe.map(({ type, appearance }) => ({ type, appearance })) }) })
      const body = await response.json() as { error?: string; message?: string; changeSetRevision?: number }
      if (response.ok && typeof body.changeSetRevision === 'number') { setRevisions((current) => ({ ...current, [set.id]: body.changeSetRevision! })); setRecipe([]); setRequestKey(crypto.randomUUID()) }
      setMessage(response.ok ? body.message ?? 'Recipe captured.' : body.error ?? 'Unable to insert this recipe.')
    } catch { setMessage('Unable to insert this recipe. Check your connection and try again.') } finally { setSaving(false) }
  }
  return <main className={styles.workspace} data-block-gallery>
    <h1 className={styles.srOnly}>Block gallery</h1>
    <div className={styles.layout}>
      <section className={styles.library} aria-label="Block library" data-block-gallery-library>
        <div className={styles.templates} data-block-gallery-templates><span>Template</span>{templateNames.map((name) => <button type="button" key={name} aria-pressed={template === name} onClick={() => chooseTemplate(name)}>{name}</button>)}</div>
        <p className={styles.intro}>Every contract block is shown for the exact active theme. Blocks unavailable to the selected template remain visible with their policy.</p>
        <p className={styles.theme} role="status">{theme ? <>Active theme <strong>{theme.name} {theme.version}</strong>{theme.presets.length ? <> · Presets: {theme.presets.join(', ')}</> : null}</> : 'Active theme identity is unavailable.'}</p>
        <div className={styles.grid}>{catalog.map((block) => {
          const allowed = block.allowedTemplates.includes(template); const preview = previews[block.type]; const locations = usage[block.type] ?? []
          return <article key={block.type} className={styles.card} data-block-gallery-card data-allowed={allowed ? 'true' : 'false'}>
            <div className={styles.preview} data-block-gallery-preview>{preview ? <img src={preview} alt={`${block.name} rendered in ${theme?.name ?? 'the active theme'}`} /> : <span>Rendered preview unavailable for this exact theme version.</span>}</div>
            <div className={styles.cardBody}><header><h2>{block.name}</h2><code>{block.type}</code></header><p>{block.description}</p><small>{block.fieldLimits}</small><small className={allowed ? styles.allowed : styles.disallowed}>{block.allowedTemplates.length === templateNames.length ? 'Allowed on every template' : `Allowed on: ${block.allowedTemplates.join(', ')}`}</small><details><summary>Usage and appearance</summary><p><strong>Used in:</strong> {locations.length ? locations.map((item) => item.title).join(', ') : 'No draft pages'}</p><p><strong>Background:</strong> {appearance.backgrounds?.join(', ')}</p><p><strong>Width:</strong> {appearance.widths?.join(', ')}</p><p><strong>Spacing:</strong> {appearance.spacing?.join(', ')}</p><p><strong>Motion:</strong> {appearance.motionIntents?.join(', ')}</p></details>{block.insertable ? <button type="button" disabled={!allowed} onClick={() => add(block.type)}>+ Add to recipe</button> : <p className={styles.referenceOnly}>Add in the page editor after choosing the required records.</p>}</div>
          </article>
        })}</div>
      </section>
      <aside className={styles.recipe} aria-label="Page recipe" data-block-gallery-recipe>
        <header><h2>Page recipe</h2><p>Template: <code>{template}</code></p></header>
        {!recipe.length ? <p className={styles.empty}>No blocks yet. Add compatible blocks in the order you want them.</p> : <ol>{recipe.map((item, index) => <li key={item.key}><div><code>{String(index + 1).padStart(2, '0')}</code><strong>{catalog.find((block) => block.type === item.type)?.name ?? item.type}</strong><button aria-label={`Move ${item.type} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button aria-label={`Move ${item.type} down`} disabled={index === recipe.length - 1} onClick={() => move(index, 1)}>↓</button><button aria-label={`Remove ${item.type}`} onClick={() => setRecipe((items) => items.filter((_, candidate) => candidate !== index))}>×</button></div><div className={styles.appearance}>{Object.entries({ background: appearance.backgrounds, width: appearance.widths, spacing: appearance.spacing, motionIntent: appearance.motionIntents, logoTone: appearance.logoTones }).map(([field, values]) => <label key={field}>{title(field)}<select value={item.appearance[field as keyof RecipeItem['appearance']]} onChange={(event) => appearanceAt(index, field as keyof RecipeItem['appearance'], event.target.value)}>{values?.map((value) => <option key={value}>{value}</option>)}</select></label>)}</div></li>)}</ol>}
        <pre tabIndex={0}>{exported}</pre>
        <div className={styles.targets}><label>Draft page<select value={page?.id ?? ''} onChange={(event) => setPageID(event.target.value)}><option value="">Choose a {template} page</option>{compatiblePages.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>Open change set<select value={setID} onChange={(event) => setSetID(event.target.value)}>{changeSets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
        <div className={styles.actions}><button className={styles.primary} disabled={!recipe.length || !page || !set || saving} onClick={() => void insert()}>{saving ? 'Saving…' : 'Insert into draft'}</button><button disabled={!recipe.length} onClick={() => void copyRecipe()}>Copy MCP recipe</button><button className={styles.clear} disabled={!recipe.length} onClick={() => setRecipe([])}>Clear</button></div>
        {!pages.length || !changeSets.length ? <p>Create a compatible draft page and an open change set before inserting.</p> : null}<p role="status" aria-live="polite">{message}</p><a href="/editorial">Open Editorial review</a>
      </aside>
    </div>
  </main>
}
