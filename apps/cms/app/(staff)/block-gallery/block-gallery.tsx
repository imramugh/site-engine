'use client'
import { useMemo, useState } from 'react'
import styles from './block-gallery.module.css'
import type { GalleryField } from '../../../src/block-gallery-catalog'
import type { GalleryLibrary } from '../../../src/admin-branding'

type Catalog = { type: string; name: string; description: string; insertable: boolean; recipeable: boolean; allowedTemplates: string[]; fieldLimits: string; fields: GalleryField[]; variants: string[] }
type Page = { id: string; title: string; template: string }
type Set = { id: string; name: string; revision: number }
type RecipeItem = { key: string; type: string; fields?: Record<string, unknown>; appearance: { background: string; width: string; spacing: string; motionIntent: string; logoTone: string } }
type Theme = { name: string; version: string; presets: string[]; extensions: string[] }
type Template = { id: string; label: string; allowedBlocks: string[]; generatedParts: string[]; startingBlocks: string[] }
type Preset = { id: string; label: string; allowedTemplates: string[]; landingTemplate: string; startingBlocks: string[] }
type Asset = { id: string; label: string; mimeType: string }
type Kind = 'block' | 'template' | 'preset' | 'extension'
type Usage = Record<string, { id: string; title: string }[]>
const defaults = { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' }
const templateNames = ['landing', 'standard', 'listing', 'pillar', 'service', 'article', 'job']
const title = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase())

function RecipeFields({ item, index, assets, pages, setField }: { item: RecipeItem; index: number; assets: Asset[]; pages: Page[]; setField: (index: number, field: string, value: unknown) => void }) {
  const values = item.fields ?? {}
  const selectMedia = (name: string, label: string, media: Asset[], multiple = false) => <label key={name}>{label}<select multiple={multiple} value={multiple ? (Array.isArray(values[name]) ? values[name] as string[] : []) : String(values[name] ?? '')} onChange={event => setField(index, name, multiple ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value)}>{!multiple ? <option value="">Choose media</option> : null}{media.map(asset => <option key={asset.id} value={asset.id}>{asset.label}</option>)}</select></label>
  const images = assets.filter(asset => asset.mimeType.startsWith('image/'))
  if (['media', 'imageText'].includes(item.type)) return <div className={styles.requiredFields}>{selectMedia('mediaId', 'Image', images)}</div>
  if (['gallery', 'logoStrip'].includes(item.type)) return <div className={styles.requiredFields}>{selectMedia('mediaIds', 'Images (select one or more)', images, true)}</div>
  if (item.type === 'video') return <div className={styles.requiredFields}>{selectMedia('mediaId', 'Video', assets.filter(asset => asset.mimeType.startsWith('video/')))}{selectMedia('posterMediaId', 'Poster image', images)}{selectMedia('captionsMediaId', 'Captions file', assets.filter(asset => asset.mimeType === 'text/vtt'))}</div>
  if (item.type === 'relatedServices') return <div className={styles.requiredFields}><label>Related services (up to three)<select multiple value={Array.isArray(values.pageIds) ? values.pageIds as string[] : []} onChange={event => setField(index, 'pageIds', Array.from(event.target.selectedOptions, option => option.value))}>{pages.filter(page => page.template === 'service').map(page => <option key={page.id} value={page.id}>{page.title}</option>)}</select></label></div>
  if (item.type === 'testimonials') {
    const testimonial = (Array.isArray(values.items) ? values.items[0] : undefined) as { quote?: string; attribution?: string; permissionConfirmed?: boolean } | undefined
    const change = (field: string, value: unknown) => setField(index, 'items', [{ quote: '', attribution: '', permissionConfirmed: false, ...testimonial, [field]: value }])
    return <div className={styles.requiredFields}><label>Quotation<textarea maxLength={500} value={testimonial?.quote ?? ''} onChange={event => change('quote', event.target.value)} /></label><label>Attribution<input maxLength={100} value={testimonial?.attribution ?? ''} onChange={event => change('attribution', event.target.value)} /></label><label className={styles.checkbox}><input type="checkbox" checked={testimonial?.permissionConfirmed ?? false} onChange={event => change('permissionConfirmed', event.target.checked)} />I have permission to publish this quotation.</label></div>
  }
  return null
}

export function BlockGallery({ catalog, appearance, pages, changeSets, usage, theme, previews, templates, sectionPresets, library, assets }: { catalog: Catalog[]; templates: Template[]; sectionPresets: Preset[]; library?: GalleryLibrary; assets: Asset[]; appearance: Record<string, readonly string[]>; pages: Page[]; changeSets: Set[]; usage: Usage; theme?: Theme; previews: Record<string, string> }) {
  const [kind, setKind] = useState<Kind>('block')
  const [preview, setPreview] = useState({ kind: 'block' as Kind, id: 'hero' })
  const [previewOpen, setPreviewOpen] = useState(false)
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
  const selection = ({ type, appearance, fields }: RecipeItem) => ({ type, appearance, ...(fields && Object.keys(fields).length ? { fields } : {}) })
  const exported = JSON.stringify({ tool: 'create_page_from_recipe', recipeVersion: 1, arguments: { template, blocks: recipe.map(selection) } }, null, 2)
  function chooseTemplate(next: string) { setTemplate(next); setPageID(pages.find((page) => page.template === next)?.id ?? ''); setRecipe((items) => items.filter((item) => catalog.find((block) => block.type === item.type)?.allowedTemplates.includes(next))) }
  function add(type: string) { setRecipe((items) => items.length >= 40 ? items : [...items, { key: crypto.randomUUID(), type, appearance: { ...defaults } }]) }
  function previewItem(nextKind: Kind, id: string) { setPreview({ kind: nextKind, id }); setPreviewOpen(true) }
  function chooseKind(next: Kind) { setKind(next); previewItem(next, next === 'block' ? 'hero' : next === 'template' ? template : next === 'preset' ? sectionPresets[0]?.id ?? '' : theme?.extensions[0] ?? '') }
  function starter(next: string, blocks: string[]) { chooseTemplate(next); setRecipe(blocks.map(type => ({ key: crypto.randomUUID(), type, appearance: { ...defaults } }))); setMessage('Starting blocks added to your recipe. Review their content before submitting a draft.') }
  function fieldAt(index: number, name: string, value: unknown) { setRecipe(items => items.map((item, i) => i === index ? { ...item, fields: { ...item.fields, [name]: value } } : item)) }
  function move(index: number, direction: -1 | 1) { setRecipe((items) => { const next = [...items]; const destination = index + direction; if (destination < 0 || destination >= next.length) return items; [next[index], next[destination]] = [next[destination], next[index]]; return next }) }
  function appearanceAt(index: number, field: keyof RecipeItem['appearance'], value: string) { setRecipe((items) => items.map((item, candidate) => candidate === index ? { ...item, appearance: { ...item.appearance, [field]: value } } : item)) }
  async function copyRecipe() { try { await navigator.clipboard.writeText(exported); setMessage('Structured recipe copied for the approved MCP create_page_from_recipe tool.') } catch { setMessage('Copy failed. Select the recipe JSON and copy it manually.') } }
  async function insert() {
    if (!page || !set || !recipe.length || saving) return
    setSaving(true); setMessage('')
    try {
      const response = await fetch('/api/block-gallery/recipe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageId: page.id, changeSetId: set.id, expectedRevision: revision, requestKey, blocks: recipe.map(selection) }) })
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
        <div className={styles.categories} aria-label="Gallery categories">{([['block', 'Blocks'], ['template', 'Templates'], ['preset', 'Section presets'], ['extension', 'Theme blocks']] as const).map(([value, label]) => <button type="button" key={value} data-gallery-kind={value} aria-pressed={kind === value} onClick={() => chooseKind(value)}>{label}</button>)}</div>
        <details className={styles.livePreview} aria-label="Active-theme preview" open={previewOpen} onToggle={event => setPreviewOpen(event.currentTarget.open)}>
          <summary>Active-theme preview</summary>
          {library ? <><p>Explore sample content, appearance options and desktop or mobile layouts. These controls do not change your site.</p>{previewOpen ? <iframe title="Active-theme gallery preview" src={`${library.url}?kind=${preview.kind}&id=${encodeURIComponent(preview.id)}`} /> : null}</> : <p role="status">No rendered library is installed for this exact theme version.</p>}
        </details>
        {kind === 'template' ? <div className={styles.grid}>{templates.map(item => <article className={styles.card} data-gallery-template={item.id} key={item.id}><div className={styles.cardBody}><h2>{item.label}</h2><p>Generated parts: {item.generatedParts.join('; ')}.</p><p>Starting blocks: {item.startingBlocks.join(', ')}.</p><details><summary>Allowed blocks</summary><p>{item.allowedBlocks.join(', ')}</p></details><button onClick={() => previewItem('template', item.id)}>Preview {item.label} template</button><button onClick={() => starter(item.id, item.startingBlocks)}>Use {item.label} starting blocks</button></div></article>)}</div> : null}
        {kind === 'preset' ? <div className={styles.grid}>{sectionPresets.map(item => <article className={styles.card} data-gallery-preset={item.id} key={item.id}><div className={styles.cardBody}><h2>{item.label}</h2><p>Allowed templates: {item.allowedTemplates.join(', ')}.</p><p>Section landing: {item.landingTemplate}. Starting blocks: {item.startingBlocks.join(', ')}.</p><button onClick={() => previewItem('preset', item.id)}>Preview {item.label} preset</button><button onClick={() => starter(item.landingTemplate, item.startingBlocks)}>Use {item.label} starting blocks</button></div></article>)}</div> : null}
        {kind === 'extension' ? theme?.extensions.length ? <div className={styles.grid}>{theme.extensions.map(name => <article className={styles.card} key={name}><div className={styles.cardBody}><h2>{name}</h2><p>Theme-specific block supplied by {theme.name} {theme.version}.</p><button onClick={() => previewItem('extension', name)}>Preview {name}</button></div></article>)}</div> : <p data-gallery-empty-extensions data-gallery-extension-count="0">The active theme has no installed theme-specific blocks.</p> : null}
        {kind === 'block' ? <div className={styles.grid}>{catalog.map((block) => {
          const allowed = block.allowedTemplates.includes(template); const preview = previews[block.type]; const locations = usage[block.type] ?? []
          return <article key={block.type} className={styles.card} data-block-gallery-card data-allowed={allowed ? 'true' : 'false'}>
            <div className={styles.preview} data-block-gallery-preview>{preview ? <img src={preview} alt={`${block.name} rendered in ${theme?.name ?? 'the active theme'}`} /> : <span>{block.name} · live preview below</span>}</div>
            <div className={styles.cardBody}><header><h2>{block.name}</h2><code>{block.type}</code></header><p>{block.description}</p><small>{block.fieldLimits}</small><button onClick={() => previewItem('block', block.type)}>Preview {block.name}</button><details><summary>Fields and variants</summary><p><strong>Variants:</strong> {block.variants.join(', ')}</p><dl className={styles.fields}>{block.fields.map(field => <div key={field.path}><dt>{field.path}{field.required ? ' *' : ''}</dt><dd>{field.type}{field.limits ? ` · ${field.limits}` : ''}{field.condition ? ` · when ${field.condition} is supplied` : ''}</dd></div>)}</dl><p>* Required; nested fields apply when their parent is supplied.</p></details><small className={allowed ? styles.allowed : styles.disallowed}>{block.allowedTemplates.length === templateNames.length ? 'Allowed on every template' : `Allowed on: ${block.allowedTemplates.join(', ')}`}</small><details><summary>Usage and appearance</summary><p><strong>Used in:</strong> {locations.length ? locations.map((item, index) => <span key={item.id}>{index ? ', ' : ''}<a href={`/admin/collections/pages/${encodeURIComponent(item.id)}`}>{item.title}</a></span>) : 'No draft pages'}</p><p><strong>Background:</strong> {appearance.backgrounds?.join(', ')}</p><p><strong>Width:</strong> {appearance.widths?.join(', ')}</p><p><strong>Spacing:</strong> {appearance.spacing?.join(', ')}</p><p><strong>Motion:</strong> {appearance.motionIntents?.join(', ')}</p></details>{block.recipeable ? <button type="button" disabled={!allowed || recipe.length >= 40} onClick={() => add(block.type)}>+ Add to recipe</button> : <p className={styles.referenceOnly}>Add in the page editor after choosing the required records.</p>}</div>
          </article>
        })}</div> : null}
      </section>
      <aside className={styles.recipe} aria-label="Page recipe" data-block-gallery-recipe>
        <header><h2>Page recipe</h2><p>Template: <code>{template}</code></p></header>
        {!recipe.length ? <p className={styles.empty}>No blocks yet. Add compatible blocks in the order you want them.</p> : <ol>{recipe.map((item, index) => <li key={item.key}><div><code>{String(index + 1).padStart(2, '0')}</code><strong>{catalog.find((block) => block.type === item.type)?.name ?? item.type}</strong><button aria-label={`Move ${item.type} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button aria-label={`Move ${item.type} down`} disabled={index === recipe.length - 1} onClick={() => move(index, 1)}>↓</button><button aria-label={`Remove ${item.type}`} onClick={() => setRecipe((items) => items.filter((_, candidate) => candidate !== index))}>×</button></div><RecipeFields item={item} index={index} assets={assets} pages={pages} setField={fieldAt} /><div className={styles.appearance}>{Object.entries({ background: appearance.backgrounds, width: appearance.widths, spacing: appearance.spacing, motionIntent: appearance.motionIntents, logoTone: appearance.logoTones }).map(([field, values]) => <label key={field}>{title(field)}<select value={item.appearance[field as keyof RecipeItem['appearance']]} onChange={(event) => appearanceAt(index, field as keyof RecipeItem['appearance'], event.target.value)}>{values?.map((value) => <option key={value}>{value}</option>)}</select></label>)}</div></li>)}</ol>}
        <pre tabIndex={0}>{exported}</pre>
        <div className={styles.targets}><label>Draft page<select value={page?.id ?? ''} onChange={(event) => setPageID(event.target.value)}><option value="">Choose a {template} page</option>{compatiblePages.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>Open change set<select value={setID} onChange={(event) => setSetID(event.target.value)}>{changeSets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
        <div className={styles.actions}><button className={styles.primary} disabled={!recipe.length || !page || !set || saving} onClick={() => void insert()}>{saving ? 'Saving…' : 'Insert into draft'}</button><button disabled={!recipe.length} onClick={() => void copyRecipe()}>Copy MCP recipe</button><button className={styles.clear} disabled={!recipe.length} onClick={() => setRecipe([])}>Clear</button></div>
        {!pages.length || !changeSets.length ? <p>Create a compatible draft page and an open change set before inserting.</p> : null}<p role="status" aria-live="polite">{message}</p><a href="/editorial">Open Editorial review</a>
      </aside>
    </div>
  </main>
}
