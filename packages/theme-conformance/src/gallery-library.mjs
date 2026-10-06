import { createHash } from 'node:crypto'

const safe = /^[a-z][a-z0-9-]{0,63}$/
const uuid = (value) => `90000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value)

export const galleryHash = (value) => createHash('sha256').update(stable(value)).digest('hex')
export const sectionPresets = Object.freeze({ root: ['landing', 'standard'], services: ['landing', 'pillar', 'service'], insights: ['listing', 'article'], careers: ['listing', 'job'], future: ['landing', 'standard', 'article'], landing: ['landing', 'standard', 'article'] })

/** Shared descriptor consumed by both neutral and installed-theme gallery wrappers. */
export function createGalleryLibraryModel({ themeKey, fixtureHash, blocks, templates, motions = [], extensions = [], backgrounds = [], common = [], sectionRoutes = {} }) {
  if (typeof themeKey !== 'string' || typeof fixtureHash !== 'string' || !Array.isArray(blocks) || !Array.isArray(templates)) throw new Error('Gallery library model requires a theme identity, fixture hash, blocks, and templates.')
  const presets = Object.entries(sectionPresets).map(([id]) => ({ id, label: id, route: sectionRoutes[id] }))
  if (presets.some((item) => typeof item.route !== 'string')) throw new Error('Every contract section preset requires a renderer route.')
  return { themeKey, fixtureHash, blocks, templates, presets, extensions, routes: { blocks: Object.fromEntries(blocks.map(({ id, route }) => [id, route])), templates: Object.fromEntries(templates.map(({ id, route }) => [id, route])), backgrounds, motions, common } }
}

/**
 * Adds neutral, deterministic pages for a gallery's appearance controls.
 * The caller still renders this fixture through the normal snapshot renderer;
 * this module never supplies presentation markup or theme-specific data.
 */
export function createGalleryFixture(snapshot, { backgrounds, presets = [], presetIntents = {}, motionBlocks = [], commonVariants = true } = {}) {
  if (!snapshot || !Array.isArray(snapshot.pages) || !Array.isArray(backgrounds) || !backgrounds.every((item) => safe.test(item))) throw new Error('A complete neutral snapshot and safe backgrounds are required.')
  const source = structuredClone(snapshot)
  const standard = source.pages.find((page) => page.template === 'standard')
  const landing = source.pages.find((page) => page.template === 'landing')
  if (!standard || !landing) throw new Error('Gallery fixtures require standard and landing template examples.')
  const clones = []
  let number = 800
  const complete = structuredClone(standard)
  const seen = new Set()
  complete.blocks = source.pages.flatMap((page) => page.blocks).filter((block) => !seen.has(block.type) && seen.add(block.type))
  complete.slug = 'gallery-complete'
  complete.title = 'Complete synthetic gallery fixture'
  const clone = (page, slug, title, change) => {
    const copy = structuredClone(page)
    copy.id = uuid(number++)
    copy.slug = slug
    copy.title = title
    copy.summary = 'Synthetic renderer gallery variation.'
    copy.blocks = copy.blocks.map((block, index) => ({ ...block, id: uuid(number++), ...change(block, index) }))
    clones.push(copy)
  }
  for (const background of backgrounds) clone(complete, `gallery-background-${background}`, `Background ${background}`, (block) => ({ appearance: { ...block.appearance, background } }))
  for (const preset of presets) {
    if (!safe.test(preset) || !safe.test(presetIntents[preset] ?? '')) throw new Error('Gallery motion presets need safe names and intents.')
    clone(complete, `gallery-preset-${preset}`, `Preset ${preset}`, (block, index) => ({ appearance: { ...block.appearance, motionIntent: index === 0 ? presetIntents[preset] : 'none', ...(index === 0 ? { motionPreset: preset } : {}) } }))
    for (const type of motionBlocks) {
      const safeType = type.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
      clone(complete, `gallery-motion-${preset}-${safeType}`, `Motion ${preset} ${type}`, (block) => ({ appearance: { ...block.appearance, motionIntent: block.type === type ? presetIntents[preset] : 'none', ...(block.type === type ? { motionPreset: preset } : {}) } }))
    }
  }
  if (commonVariants) {
    for (const width of ['content', 'wide', 'full']) clone(complete, `gallery-width-${width}`, `Width ${width}`, (block) => ({ appearance: { ...block.appearance, width } }))
    for (const spacing of ['compact', 'default', 'spacious']) clone(complete, `gallery-spacing-${spacing}`, `Spacing ${spacing}`, (block) => ({ appearance: { ...block.appearance, spacing } }))
    for (const logoTone of ['default', 'inverse']) clone(complete, `gallery-logo-${logoTone}`, `Logo tone ${logoTone}`, (block) => ({ appearance: { ...block.appearance, logoTone } }))
  }
  for (const [preset, templates] of Object.entries(sectionPresets)) {
    const sourcePage = source.pages.find((page) => page.template === templates[0])
    if (!sourcePage) throw new Error(`Gallery fixture does not contain the ${templates[0]} section preset template.`)
    clone(sourcePage, `gallery-section-${preset}`, `Section preset ${preset}`, () => ({}))
  }
  const featureSource = complete
  if (featureSource) for (const count of [2, 3, 4]) clone(featureSource, `gallery-feature-grid-${count}`, `Feature grid ${count}`, (block) => {
    if (block.type !== 'featureGrid' || !Array.isArray(block.items) || !block.items.length) return {}
    return { items: Array.from({ length: count }, (_, index) => structuredClone(block.items[index % block.items.length])) }
  })
  const section = source.settings?.sections?.[0]
  if (!section?.pageIds) throw new Error('Gallery fixture requires a primary section.')
  section.pageIds = [...section.pageIds, ...clones.map((page) => page.id)]
  return { ...source, pages: [...source.pages, ...clones] }
}

/** A portable, same-origin controller around renderer-generated HTML pages. */
export function galleryLibraryDocument({ title, themeKey, fixtureHash, routes, blocks, templates, presets, extensions = [] }) {
  if (![title, themeKey, fixtureHash].every((value) => typeof value === 'string') || !routes || !Array.isArray(blocks) || !Array.isArray(templates) || !Array.isArray(presets) || !Array.isArray(extensions)) throw new Error('Gallery library metadata is incomplete.')
  const esc = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><link rel="stylesheet" href="library.css"></head><body><main data-gallery-library data-theme-key="${esc(themeKey)}" data-fixture-hash="${esc(fixtureHash)}"><div class="bar" role="toolbar" aria-label="Preview kind"><button data-gallery-kind="block" type="button">Blocks</button><button data-gallery-kind="template" type="button">Templates</button><button data-gallery-kind="preset" type="button">Section presets</button><button data-gallery-kind="extension" type="button">Theme blocks</button><label>Background<select data-gallery-background></select></label><label>Motion<select data-gallery-motion></select></label><label>Variant<select data-gallery-variant></select></label><button type="button" data-gallery-viewport>Mobile</button></div><p data-gallery-template-legend hidden>Dashed outlines identify fixed template parts; block content remains editable.</p><p data-gallery-selection data-gallery-preview-kind="" data-gallery-preview-id="" aria-live="polite"></p><iframe class="frame" data-gallery-renderer sandbox="allow-scripts allow-same-origin" title="Rendered theme preview"></iframe><div class="empty" data-gallery-empty-extensions data-gallery-extension-count="${extensions.length}" hidden>No extension blocks are installed for this exact theme package.</div></main><script type="module" src="library.js"></script></body></html>`
}

export const galleryLibraryStyles = `body{margin:0;background:#f4f6f8;color:#13212c;font:14px/1.45 system-ui,sans-serif}main{display:grid;gap:12px;padding:12px}.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.bar label{display:grid;gap:2px;font-size:12px}.bar select,.bar button{font:inherit;padding:6px 8px;border:1px solid #aab7c1;border-radius:4px;background:#fff}.bar button[aria-pressed=true]{background:#013a63;color:#fff}.frame{width:100%;height:720px;border:1px solid #aab7c1;background:#fff}.frame[data-viewport=mobile]{width:390px;max-width:100%;margin:auto}.empty{padding:24px;background:#fff;border:1px solid #aab7c1}`

export const galleryLibraryScript = `const d=await fetch('library.json',{credentials:'same-origin'}).then(r=>r.json());const q=new URLSearchParams(location.search),kinds=['block','template','preset','extension'];let kind=kinds.includes(q.get('kind'))?q.get('kind'):'block',id=q.get('id')||d.blocks[0]?.id||'',viewport='desktop',override='';const f=document.querySelector('[data-gallery-renderer]'),s=document.querySelector('[data-gallery-selection]'),legend=document.querySelector('[data-gallery-template-legend]'),empty=document.querySelector('[data-gallery-empty-extensions]'),bg=document.querySelector('[data-gallery-background]'),motion=document.querySelector('[data-gallery-motion]'),variant=document.querySelector('[data-gallery-variant]');const blockSelector=t=>'[data-block-type="'+t+'"],[data-block="'+t+'"]';const by=k=>k==='block'?d.blocks:k==='template'?d.templates:k==='preset'?d.presets:d.extensions;const add=(el,items)=>{el.add(new Option('Default',''));for(const x of items)el.add(new Option(x.label,x.id));};add(bg,d.routes.backgrounds);add(motion,d.routes.motions);add(variant,d.routes.common);const reset=(except)=>{if(except!=='background')bg.value='';if(except!=='motion')motion.value='';if(except!=='variant')variant.value=''};function route(){const item=by(kind).find(x=>x.id===id)||by(kind)[0];if(!item){s.dataset.galleryPreviewKind=kind;s.dataset.galleryPreviewId='';s.textContent='No extension blocks installed';empty.hidden=false;f.hidden=true;return}id=item.id;const interactive=kind==='block';for(const el of [bg,motion,variant])el.disabled=!interactive;legend.hidden=kind!=='template';if(!interactive){override='';reset('');}const block=item.block;for(const option of motion.options)option.disabled=Boolean(option.value)&&!d.routes.motions.find(x=>x.id===option.value)?.routes?.[block];if(motion.selectedOptions[0]?.disabled)motion.value='';const target=override||item.route||d.routes.templates[item.id]||d.routes.blocks[item.id];s.dataset.galleryPreviewKind=kind;s.dataset.galleryPreviewId=id;s.textContent=item.label||id;for(const b of document.querySelectorAll('[data-gallery-kind]'))b.setAttribute('aria-pressed',String(b.dataset.galleryKind===kind));empty.hidden=kind!=='extension'||d.extensions.length>0;f.hidden=kind==='extension'&&!d.extensions.length;const u=new URL(location);u.searchParams.set('kind',kind);u.searchParams.set('id',id);history.replaceState(null,'',u);f.onload=()=>{const doc=f.contentDocument,target=block?doc?.querySelector(blockSelector(block)):doc?.querySelector('main');if(target){target.id='gallery-'+(block||item.id);target.dataset.galleryPreviewKind=kind;target.dataset.galleryPreviewId=id;target.scrollIntoView({block:'start'})}if(kind==='template'){for(const fixed of doc?.querySelectorAll('header,footer,main > *')||[]){if(!fixed.closest('[data-block-type],[data-block]'))fixed.dataset.galleryTemplateFixedPart='true'}const style=doc?.createElement('style');if(style){style.textContent='[data-gallery-template-fixed-part="true"]{outline:2px dashed #007eaa;outline-offset:-2px}';doc.head.append(style)}}};f.src=target+(block?'#gallery-'+block:'')}for(const b of document.querySelectorAll('[data-gallery-kind]'))b.onclick=()=>{kind=b.dataset.galleryKind;id=by(kind)[0]?.id||'';override='';route()};document.querySelector('[data-gallery-viewport]').onclick=()=>{viewport=viewport==='desktop'?'mobile':'desktop';f.dataset.viewport=viewport;document.querySelector('[data-gallery-viewport]').textContent=viewport==='desktop'?'Mobile':'Desktop'};bg.onchange=e=>{reset('background');override=d.routes.backgrounds.find(x=>x.id===e.target.value)?.route||'';route()};motion.onchange=e=>{reset('motion');override=d.routes.motions.find(x=>x.id===e.target.value)?.routes?.[by(kind).find(x=>x.id===id)?.block]||'';route()};variant.onchange=e=>{reset('variant');override=d.routes.common.find(x=>x.id===e.target.value)?.route||'';route()};route();`
