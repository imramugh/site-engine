'use client'

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Block, Page } from '@site-engine/contract'
import { MetadataFields, type PageMetadataValue } from './metadata-fields'
import { isPreviewEditableField, type PreviewEditableField } from './preview-edit-policy'
import styles from './page-editor.module.css'

type Draft = PageMetadataValue & {
  title: string
  summary: string
  slug: string
  seoDescription?: string
  noindex: boolean
  blocks: Block[]
}
type ChangeSet = {
  id: string
  name: string
  state: string
  revision: number
  changes: number
  theme: { name: string; version: string } | null
  contractVersion: string | null
}
type Reference = { id: string; label: string; mimeType?: string }
type CatalogItem = {
  type: Block['type']
  fieldLimits: string
  insertable: boolean
}
type Context = {
  page: {
    id: string
    template: Page['template']
    state: string
    draft: Draft
    hash: string
  }
  breadcrumb: Array<{ label: string; href?: string }>
  changeSets: ChangeSet[]
  blockCatalog: CatalogItem[]
  appearanceCapabilities: {
    backgrounds: string[]
    widths: string[]
    spacings: string[]
    motionIntents: string[]
    logoTones: string[]
  }
  activeTheme: { name: string; version: string } | null
  activeContractVersion: string | null
  references: { media: Reference[]; pages: Reference[] }
}
type Preview = { id: string; status: string; path?: string }
type Path = Array<string | number>
type Appearance = Block['appearance']

const labels: Record<string, string> = {
  seoDescription: 'SEO description',
  noindex: 'Hide from search',
  anchorId: 'Anchor',
  mediaId: 'Media',
  mediaIds: 'Media',
  pageIds: 'Related pages',
  posterMediaId: 'Poster image',
  captionsMediaId: 'Captions',
  motionIntent: 'Motion',
  logoTone: 'Logo tone',
  inquiryForm: 'Inquiry form',
  permissionConfirmed: 'Permission confirmed',
}
const title = (key: string) =>
  labels[key] ??
  key.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase())
const appearance = {
  background: 'default',
  width: 'content',
  spacing: 'default',
  motionIntent: 'none',
  logoTone: 'default',
}
const enumOptions: Record<string, readonly string[]> = {
  background: ['default', 'subtle', 'brand', 'accent', 'highlight', 'inverse'],
  width: ['content', 'wide', 'full'],
  spacing: ['compact', 'default', 'spacious'],
  motionIntent: ['none', 'subtle', 'ambient', 'signature'],
  logoTone: ['default', 'inverse'],
  kind: ['phone', 'email', 'address', 'link'],
}
const clone = <T,>(value: T): T => structuredClone(value)

function updateAt<T>(source: T, path: Path, value: unknown): T {
  const next = clone(source) as unknown as Record<string | number, unknown>
  let target = next
  for (const part of path.slice(0, -1))
    target = target[part] as Record<string | number, unknown>
  target[path.at(-1)!] = value
  return next as T
}
function removeAt<T>(source: T, path: Path): T {
  const next = clone(source) as unknown as Record<string | number, unknown>
  let target = next
  for (const part of path.slice(0, -1))
    target = target[part] as Record<string | number, unknown>
  const key = path.at(-1)!
  if (Array.isArray(target)) target.splice(Number(key), 1)
  else delete target[key]
  return next as T
}

function optionalFieldEntries(
  block: Record<string, unknown>,
): Array<[string, unknown]> {
  const values: Record<string, Array<[string, unknown]>> = {
    hero: [
      ['eyebrow', 'Draft eyebrow'],
      ['cta', { label: 'Learn more', href: '/' }],
      ['secondaryCta', { label: 'More information', href: '/' }],
      ['phoneCta', { label: 'Call', number: '+15550123' }],
      [
        'supportPanel',
        {
          heading: 'Supporting information',
          body: 'Replace this draft supporting text.',
        },
      ],
    ],
    incidentBar: [['cta', { label: 'Details', href: '/' }]],
    pillarGrid: [
      ['eyebrow', 'Draft eyebrow'],
      ['body', 'Replace this draft introduction.'],
    ],
    featureGrid: [
      ['eyebrow', 'Draft eyebrow'],
      ['body', 'Replace this draft introduction.'],
    ],
    splitList: [
      ['eyebrow', 'Draft eyebrow'],
      ['body', 'Replace this draft introduction.'],
    ],
    chipList: [
      ['eyebrow', 'Draft eyebrow'],
      ['heading', 'Draft topics'],
      ['body', 'Replace this draft introduction.'],
    ],
    faq: [
      ['eyebrow', 'Draft eyebrow'],
      ['body', 'Replace this draft introduction.'],
    ],
    callout: [
      ['eyebrow', 'Draft eyebrow'],
      ['items', ['Draft item']],
      ['cta', { label: 'Details', href: '/' }],
    ],
    relatedServices: [['links', [{ label: 'Related information', href: '/' }]]],
    contact: [
      ['inquiryForm', false],
      ['contactDetails', { channels: [] }],
    ],
    media: [['caption', 'Draft caption']],
    video: [['transcript', 'Replace this draft transcript.']],
  }
  return values[String(block.type)] ?? []
}

function optionalFields(
  block: Record<string, unknown>,
): Array<[string, unknown]> {
  return optionalFieldEntries(block).filter(([key]) => !(key in block))
}

function optionalObjectEntries(
  field: string,
  value: Record<string, unknown>,
): Array<[string, unknown]> {
  if (field === 'supportPanel')
    return [
      ['eyebrow', 'Draft eyebrow'],
      ['cta', { label: 'Details', href: '/' }],
      ['phoneCta', { label: 'Call', number: '+15550123' }],
    ]
  if (field === 'contactDetails')
    return [
      [
        'incidentCallout',
        {
          label: 'Urgent information',
          body: 'Replace this draft information.',
        },
      ],
      ['channels', []],
      ['nextStepsHeading', 'Next steps'],
      ['nextSteps', []],
    ]
  if (field === 'incidentCallout') return [['phoneLabel', 'Call now']]
  if ('quote' in value && 'attribution' in value)
    return [['role', 'Draft role']]
  if ('title' in value && 'body' in value && 'href' in value)
    return [['links', []]]
  if (
    'kind' in value &&
    'label' in value &&
    'value' in value &&
    value.kind !== 'address'
  ) {
    const href =
      value.kind === 'phone'
        ? 'tel:+15550123'
        : value.kind === 'email'
          ? 'mailto:contact@example.test'
          : 'https://example.test/'
    return [['href', href]]
  }
  return []
}

function arrayDefault(path: Path, current: unknown[]): unknown {
  const key = String(path.at(-1))
  if (current.length) return clone(current.at(-1))
  if (key === 'items')
    return { title: 'Draft item', body: 'Replace this draft text.' }
  if (key === 'chips') return 'Draft topic'
  if (key === 'links') return { label: 'Details', href: '/' }
  if (key === 'channels')
    return {
      kind: 'email',
      label: 'Email',
      value: 'contact@example.test',
      href: 'mailto:contact@example.test',
    }
  if (key === 'nextSteps')
    return { title: 'Next step', body: 'Replace this draft text.' }
  return 'Draft item'
}

export function blockDefault(
  type: Block['type'],
  references: Context['references'],
): Record<string, unknown> | undefined {
  const base = { id: crypto.randomUUID(), type, hidden: false, appearance }
  const image = references.media.find((item) =>
    item.mimeType?.startsWith('image/'),
  )?.id
  const video = references.media.find((item) =>
    item.mimeType?.startsWith('video/'),
  )?.id
  const captions = references.media.find(
    (item) => item.mimeType === 'text/vtt',
  )?.id
  const page = references.pages[0]?.id
  const values: Record<Block['type'], Record<string, unknown> | undefined> = {
    hero: {
      ...base,
      heading: 'Draft heading',
      body: 'Replace this neutral draft text before review.',
    },
    incidentBar: { ...base, message: 'Replace this draft status message.' },
    pillarGrid: {
      ...base,
      heading: 'Draft services',
      items: [
        { title: 'Draft item', body: 'Replace this draft text.', href: '/' },
      ],
    },
    featureGrid: {
      ...base,
      heading: 'Draft features',
      items: [{ title: 'Draft item', body: 'Replace this draft text.' }],
    },
    splitList: {
      ...base,
      heading: 'Draft list',
      items: [{ title: 'Draft item', body: 'Replace this draft text.' }],
    },
    chipList: { ...base, heading: 'Draft topics', chips: ['Draft topic'] },
    testimonials: {
      ...base,
      items: [
        {
          quote: 'Replace this approved draft quote.',
          attribution: 'Draft attribution',
          permissionConfirmed: false,
        },
      ],
    },
    faq: {
      ...base,
      heading: 'Draft questions',
      items: [
        { question: 'Draft question?', answer: 'Replace this draft answer.' },
      ],
    },
    callout: {
      ...base,
      heading: 'Draft callout',
      body: 'Replace this draft text.',
    },
    relatedServices: page
      ? { ...base, heading: 'Related services', pageIds: [page] }
      : undefined,
    cta: {
      ...base,
      heading: 'Draft call to action',
      body: 'Replace this draft text.',
      cta: { label: 'Learn more', href: '/' },
    },
    richText: {
      ...base,
      body: 'Replace this neutral draft text before review.',
    },
    contact: {
      ...base,
      heading: 'Draft contact',
      body: 'Replace this draft text.',
      inquiryForm: false,
    },
    media: image ? { ...base, mediaId: image } : undefined,
    imageText: image
      ? {
          ...base,
          heading: 'Draft image text',
          body: 'Replace this draft text.',
          mediaId: image,
        }
      : undefined,
    gallery: image ? { ...base, mediaIds: [image] } : undefined,
    logoStrip: image ? { ...base, mediaIds: [image] } : undefined,
    video:
      video && image && captions
        ? {
            ...base,
            mediaId: video,
            posterMediaId: image,
            captionsMediaId: captions,
          }
        : undefined,
  }
  return values[type]
}

function Scalar({
  field,
  value,
  onChange,
  references,
}: {
  field: string
  value: string | number | boolean
  onChange: (value: unknown) => void
  references: Context['references']
}) {
  const controlID = useId()
  if (typeof value === 'boolean')
    return (
      <label className={styles.checkbox} htmlFor={controlID}>
        <input
          id={controlID}
          type="checkbox"
          checked={value}
          onChange={(event) => onChange(event.target.checked)}
        />{' '}
        {title(field)}
      </label>
    )
  const reference =
    field === 'mediaId' ||
    field === 'posterMediaId' ||
    field === 'captionsMediaId'
      ? references.media
      : undefined
  if (reference)
    return (
      <label htmlFor={controlID}>
        {title(field)}
        <select
          id={controlID}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {reference.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    )
  if (typeof value === 'number')
    return (
      <label htmlFor={controlID}>
        {title(field)}
        <input
          id={controlID}
          type="number"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </label>
    )
  if (enumOptions[field])
    return (
      <label htmlFor={controlID}>
        {title(field)}
        <select
          id={controlID}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {enumOptions[field].map((option) => (
            <option key={option} value={option}>
              {title(option)}
            </option>
          ))}
        </select>
      </label>
    )
  const long = [
    'body',
    'answer',
    'quote',
    'transcript',
    'message',
    'challenge',
    'approach',
    'outcome',
  ].includes(field)
  return (
    <label htmlFor={controlID}>
      {title(field)}
      {long ? (
        <textarea
          id={controlID}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={controlID}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  )
}

function ValueEditor({
  field,
  value,
  path,
  onSet,
  onRemove,
  references,
}: {
  field: string
  value: unknown
  path: Path
  onSet: (path: Path, value: unknown) => void
  onRemove?: (path: Path) => void
  references: Context['references']
}) {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return (
      <div className={styles.fieldRow}>
        <Scalar
          field={field}
          value={value}
          onChange={(next) => onSet(path, next)}
          references={references}
        />
        {onRemove ? (
          <button
            type="button"
            className={styles.removeField}
            onClick={() => onRemove(path)}
          >
            Remove {title(field)}
          </button>
        ) : null}
      </div>
    )
  if (Array.isArray(value)) {
    const refs =
      field === 'mediaIds'
        ? references.media
        : field === 'pageIds'
          ? references.pages
          : undefined
    return (
      <fieldset className={styles.nested}>
        <legend>{title(field)}</legend>
        {value.map((item, index) => (
          <div className={styles.arrayItem} key={index}>
            {refs && typeof item === 'string' ? (
              <select
                aria-label={`${title(field)} ${index + 1}`}
                value={item}
                onChange={(event) =>
                  onSet([...path, index], event.target.value)
                }
              >
                {refs.map((ref) => (
                  <option key={ref.id} value={ref.id}>
                    {ref.label}
                  </option>
                ))}
              </select>
            ) : (
              <ValueEditor
                field={`${title(field)} ${index + 1}`}
                value={item}
                path={[...path, index]}
                onSet={onSet}
                references={references}
              />
            )}
            <div className={styles.itemActions}>
              <button
                type="button"
                disabled={index === 0}
                onClick={() => {
                  const next = [...value]
                  ;[next[index - 1], next[index]] = [
                    next[index],
                    next[index - 1],
                  ]
                  onSet(path, next)
                }}
              >
                Up
              </button>
              <button
                type="button"
                disabled={index === value.length - 1}
                onClick={() => {
                  const next = [...value]
                  ;[next[index + 1], next[index]] = [
                    next[index],
                    next[index + 1],
                  ]
                  onSet(path, next)
                }}
              >
                Down
              </button>
              <button
                type="button"
                onClick={() =>
                  onSet(
                    path,
                    value.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onSet(path, [...value, refs?.[0]?.id ?? arrayDefault(path, value)])
          }
          disabled={Boolean(refs && !refs.length)}
        >
          + Add {title(field).replace(/s$/, '')}
        </button>
        {onRemove ? (
          <button
            type="button"
            className={styles.removeField}
            onClick={() => onRemove(path)}
          >
            Remove {title(field)}
          </button>
        ) : null}
      </fieldset>
    )
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const optional = optionalObjectEntries(field, record)
    return (
      <fieldset className={styles.nested}>
        <legend>{title(field)}</legend>
        {Object.entries(record).map(([key, item]) => (
          <ValueEditor
            key={key}
            field={key}
            value={item}
            path={[...path, key]}
            onSet={onSet}
            onRemove={
              optional.some(([name]) => name === key) ? onRemove : undefined
            }
            references={references}
          />
        ))}
        {optional
          .filter(([key]) => !(key in record))
          .map(([key, item]) => (
            <button
              type="button"
              key={key}
              onClick={() => onSet([...path, key], item)}
            >
              + {title(key)}
            </button>
          ))}
        {onRemove ? (
          <button
            type="button"
            className={styles.removeField}
            onClick={() => onRemove(path)}
          >
            Remove {title(field)}
          </button>
        ) : null}
      </fieldset>
    )
  }
  return null
}

function AppearanceEditor({
  value,
  capabilities,
  onSet,
  onPatch,
  onRemove,
  references,
}: {
  value: Appearance
  capabilities: Context['appearanceCapabilities']
  onSet: (field: keyof Appearance, value: unknown) => void
  onPatch: (path: Path, value: unknown) => void
  onRemove: (path: Path) => void
  references: Context['references']
}) {
  const compact = [
    ['motionIntent', 'Motion', capabilities.motionIntents],
    ['spacing', 'Spacing', capabilities.spacings],
    ['width', 'Width', capabilities.widths],
    ['logoTone', 'Logo tone', capabilities.logoTones],
  ] as const
  const base = new Set([
    'background',
    'motionIntent',
    'spacing',
    'width',
    'logoTone',
  ])
  return (
    <fieldset className={styles.appearancePanel} data-page-editor-appearance>
      <legend>Appearance</legend>
      <div className={styles.backgrounds} data-page-editor-backgrounds>
        <span>Background</span>
        <div>
          {capabilities.backgrounds.map((background) => (
            <button
              type="button"
              key={background}
              title={title(background)}
              aria-label={`${title(background)} background`}
              aria-pressed={value.background === background}
              data-page-editor-background={background}
              onClick={() => onSet('background', background)}
            >
              <i aria-hidden="true" />
              <span>{title(background)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.appearanceCompact}>
        {compact.map(([field, label, options]) => (
          <label key={field}>
            {label}
            <select
              aria-label={label}
              value={String(value[field])}
              onChange={(event) => onSet(field, event.target.value)}
            >
              {options.map((option) => (
                <option key={option} value={option}>
                  {title(option)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {Object.entries(value)
        .filter(([field]) => !base.has(field))
        .map(([field, nested]) => (
          <ValueEditor
            key={field}
            field={field}
            value={nested}
            path={[field]}
            onSet={onPatch}
            onRemove={onRemove}
            references={references}
          />
        ))}
    </fieldset>
  )
}

function BlockEditor({
  block,
  index,
  total,
  references,
  onChange,
  onMove,
  onRemove,
  active,
  capabilities,
  onSelect,
}: {
  block: Block
  index: number
  total: number
  references: Context['references']
  onChange: (update: (current: Block) => Block) => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
  active: boolean
  capabilities: Context['appearanceCapabilities']
  onSelect: () => void
}) {
  const record = block as unknown as Record<string, unknown>
  const set = (path: Path, value: unknown) =>
    onChange((current) => updateAt(current, path, value))
  const remove = (path: Path) => onChange((current) => removeAt(current, path))
  return (
    <details
      className={styles.block}
      data-page-editor-block
      data-page-editor-block-id={block.id}
      data-page-editor-block-active={active ? 'true' : 'false'}
      open={active}
      onFocus={(event) => {
        // Escape returns focus to the summary without reopening the panel.
        // Enter/Space and pointer activation still use the summary click handler.
        if (event.target !== event.currentTarget.querySelector('summary')) onSelect()
      }}
    >
      <summary
        onClick={(event) => {
          event.preventDefault()
          onSelect()
        }}
      >
        <span className={styles.grip} aria-hidden="true">
          ⠿
        </span>
        <span>
          <strong>
            {index + 1}. {title(block.type)}
          </strong>
          <small>{block.type}</small>
        </span>
      </summary>
      <div className={styles.blockBody}>
        <div className={styles.blockActions}>
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            Move up
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            Move down
          </button>
          <button type="button" onClick={onRemove}>
            Remove block
          </button>
        </div>
        <ValueEditor
          field="hidden"
          value={block.hidden}
          path={['hidden']}
          onSet={set}
          references={references}
        />
        {block.anchorId !== undefined ? (
          <ValueEditor
            field="anchorId"
            value={block.anchorId}
            path={['anchorId']}
            onSet={set}
            onRemove={remove}
            references={references}
          />
        ) : (
          <button
            type="button"
            onClick={() => set(['anchorId'], 'section-anchor')}
          >
            + Add anchor
          </button>
        )}
        {Object.entries(record)
          .filter(
            ([key]) =>
              !['id', 'type', 'hidden', 'anchorId', 'appearance'].includes(key),
          )
          .map(([key, value]) => (
            <ValueEditor
              key={key}
              field={key}
              value={value}
              path={[key]}
              onSet={set}
              onRemove={
                optionalFieldEntries(record).some(([name]) => name === key)
                  ? remove
                  : undefined
              }
              references={references}
            />
          ))}
        <AppearanceEditor
          value={block.appearance}
          capabilities={capabilities}
          onSet={(field, value) => set(['appearance', field], value)}
          onPatch={(path, value) => set(['appearance', ...path], value)}
          onRemove={(path) => remove(['appearance', ...path])}
          references={references}
        />
        {optionalFields(record).length ? (
          <div className={styles.optional}>
            <span>Optional fields</span>
            {optionalFields(record).map(([key, value]) => (
              <button type="button" key={key} onClick={() => set([key], value)}>
                + {title(key)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  )
}

export function PageEditor({ pageID }: { pageID: string }) {
  const [data, setData] = useState<Context>()
  const [draft, setDraft] = useState<Draft>()
  const [changeSetID, setChangeSetID] = useState('')
  const [message, setMessage] = useState('Loading page draft…')
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState(false)
  const [preview, setPreview] = useState<Preview>()
  const [mobile, setMobile] = useState(false)
  const [previewWidth, setPreviewWidth] = useState(1280)
  const [activeBlockID, setActiveBlockID] = useState<string>()
  const [previewInteractive, setPreviewInteractive] = useState<boolean>()
  const [previewEditMode, setPreviewEditMode] = useState(false)
  const [previewTextAvailable, setPreviewTextAvailable] = useState(false)
  const [readiness, setReadiness] = useState<{ message: string; fingerprint: string }>()
  const [stale, setStale] = useState(false)
  const [newSetName, setNewSetName] = useState('Page edits')
  const timer = useRef<number | undefined>(undefined)
  const requestVersion = useRef(0)
  const pickerTrigger = useRef<HTMLButtonElement>(null)
  const pickerDialog = useRef<HTMLElement>(null)
  const previewCanvas = useRef<HTMLDivElement>(null)
  const previewFrame = useRef<HTMLIFrameElement>(null)
  const previewBlockCleanup = useRef<() => void>(() => undefined)
  const activeBlockIDRef = useRef<string | undefined>(undefined)
  const draftRef = useRef<Draft | undefined>(undefined)
  const saved = data?.page.draft
  useEffect(() => { draftRef.current = draft }, [draft])
  const selectedSet =
    data?.changeSets.find((item) => item.id === changeSetID) ??
    data?.changeSets[0]
  const selectedTheme = selectedSet ? selectedSet.theme : data?.activeTheme
  const selectedContractVersion = selectedSet
    ? selectedSet.contractVersion
    : data?.activeContractVersion
  const supportsPageMetadata = selectedContractVersion === '1.4.0' || selectedContractVersion === '1.5.0' || selectedContractVersion === '1.6.0' || selectedContractVersion === '1.7.0'
  const dirty = Boolean(
    draft && saved && JSON.stringify(draft) !== JSON.stringify(saved),
  )
  const clearPreview = useCallback(() => {
    requestVersion.current += 1
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = undefined
    setPreview(undefined)
    setPreviewInteractive(undefined)
    setPreviewEditMode(false)
    setPreviewTextAvailable(false)
  }, [])
  const closePicker = useCallback(() => {
    setPicker(false)
    window.setTimeout(() => pickerTrigger.current?.focus(), 0)
  }, [])
  const setActiveBlock = useCallback((id: string | undefined) => {
    activeBlockIDRef.current = id
    setActiveBlockID(id)
  }, [])
  const selectBlock = useCallback((id: string, focusEditor = false) => {
    setActiveBlock(id)
    if (!focusEditor) return
    window.requestAnimationFrame(() => {
      const block = document.querySelector<HTMLElement>(
        `[data-page-editor-block-id="${id}"]`,
      )
      const summary = block?.querySelector<HTMLElement>('summary')
      summary?.focus()
      block?.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      })
    })
  }, [setActiveBlock])
  useEffect(() => {
    if (!picker) return
    const dialog = pickerDialog.current
    dialog
      ?.querySelector<HTMLButtonElement>('[data-page-picker-close]')
      ?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closePicker()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ]
      if (!focusable.length) return
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closePicker, picker])
  useEffect(() => {
    const canvas = previewCanvas.current
    if (!canvas) return
    const measure = () => {
      const style = getComputedStyle(canvas)
      setPreviewWidth(
        canvas.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight),
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [data])
  const collapseBlock = useCallback((id: string) => {
    if (activeBlockIDRef.current !== id) return
    setActiveBlock(undefined)
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-page-editor-block-id="${id}"] summary`)
        ?.focus()
    })
  }, [setActiveBlock])
  useEffect(() => {
    if (picker) return
    const collapse = (event: KeyboardEvent) => {
      const id = activeBlockIDRef.current
      if (event.key !== 'Escape' || !id) return
      event.preventDefault()
      collapseBlock(id)
    }
    window.addEventListener('keydown', collapse)
    return () => window.removeEventListener('keydown', collapse)
  }, [collapseBlock, picker])
  const wirePreviewBlocks = useCallback(() => {
    previewBlockCleanup.current()
    const document = previewFrame.current?.contentDocument
    const currentDraft = draftRef.current
    if (!document?.head || document.readyState === 'loading' || !currentDraft) {
      setPreviewInteractive(undefined)
      setPreviewTextAvailable(false)
      return
    }
    const visible = currentDraft.blocks.filter((block) => !block.hidden)
    const nodes = [...document.querySelectorAll<HTMLElement>('[data-block-id]')]
    const byID = new Map(visible.map((block) => [block.id, block]))
    const renderedIDs = nodes.map((node) => node.dataset.blockId ?? '')
    const matches = nodes.length === visible.length && new Set(renderedIDs).size === visible.length && renderedIDs.every((id) => byID.has(id)) && nodes.every((node) => {
      const block = byID.get(node.dataset.blockId ?? '')
      return Boolean(block && (node.dataset.blockType ?? node.dataset.block) === block.type)
    })
    if (!matches) {
      setPreviewInteractive(false)
      setPreviewTextAvailable(false)
      return
    }
    const style = document.createElement('link')
    style.dataset.pageEditorSelectionStyle = 'true'
    style.rel = 'stylesheet'
    style.href = '/page-editor-preview.css'
    document.head.append(style)
    const cleanups: Array<() => void> = []
    nodes.forEach((node) => {
      const block = byID.get(node.dataset.blockId!)!
      const previousTabIndex = node.getAttribute('tabindex')
      const previousLabel = node.getAttribute('aria-label')
      node.dataset.pageEditorPreviewBlockId = block.id
      node.dataset.pageEditorSelected = String(activeBlockID === block.id)
      node.tabIndex = 0
      node.setAttribute('aria-label', `Edit ${title(block.type)} block`)
      const activate = (event: Event) => { if (previewEditMode) return; event.preventDefault(); event.stopPropagation(); selectBlock(block.id, true) }
      const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && !previewEditMode) { event.preventDefault(); collapseBlock(block.id) }
        else if (!previewEditMode && event.target === node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); selectBlock(block.id, true) }
      }
      node.addEventListener('click', activate); node.addEventListener('keydown', keydown)
      cleanups.push(() => { node.removeEventListener('click', activate); node.removeEventListener('keydown', keydown); delete node.dataset.pageEditorPreviewBlockId; delete node.dataset.pageEditorSelected; if (previousLabel === null) node.removeAttribute('aria-label'); else node.setAttribute('aria-label', previousLabel); if (previousTabIndex === null) node.removeAttribute('tabindex'); else node.setAttribute('tabindex', previousTabIndex) })
    })
    const candidates = [...document.querySelectorAll<HTMLElement>('[data-site-engine-edit-field]')].filter((target) => !target.closest('[data-site-engine-edit-disabled="true"]'))
    const editable = candidates.filter((target) => {
      const field = target.dataset.siteEngineEditField ?? ''
      const blockNode = target.closest<HTMLElement>('[data-block-id]')
      const block = blockNode ? byID.get(blockNode.dataset.blockId ?? '') : undefined
      return Boolean(block && blockNode && nodes.includes(blockNode) && !target.closest('[data-site-engine-edit-disabled="true"]') && isPreviewEditableField(block, field) && target.textContent === (block as unknown as Record<string, unknown>)[field])
    })
    const unique = editable.length > 0 && editable.length === candidates.length && new Set(editable.map((target) => `${target.closest('[data-block-id]')?.getAttribute('data-block-id')}:${target.dataset.siteEngineEditField}`)).size === editable.length
    setPreviewTextAvailable(unique)
    if (previewEditMode && unique) {
      const preventInteractive = (event: Event) => {
        const target = event.target as Element | null
        if (target?.closest('[contenteditable="plaintext-only"]')) return
        if (target?.closest('a, button, input, select, textarea, form')) { event.preventDefault(); event.stopPropagation() }
      }
      document.addEventListener('click', preventInteractive, true)
      document.addEventListener('submit', preventInteractive, true)
      cleanups.push(() => { document.removeEventListener('click', preventInteractive, true); document.removeEventListener('submit', preventInteractive, true) })
      editable.forEach((target) => {
      const field = target.dataset.siteEngineEditField as PreviewEditableField
      const blockNode = target.closest<HTMLElement>('[data-block-id]')!
      const blockID = blockNode.dataset.blockId!
      const original = target.textContent ?? ''
      const previousContentEditable = target.getAttribute('contenteditable')
      const previousRole = target.getAttribute('role')
      const previousLabel = target.getAttribute('aria-label')
      target.dataset.pageEditorPreviewEdit = 'true'
      target.contentEditable = 'plaintext-only'
      target.setAttribute('role', 'textbox')
      target.setAttribute('aria-label', `Edit ${title(field)}`)
      const input = () => {
        const value = target.textContent ?? ''
        setDraft((current) => current ? { ...current, blocks: current.blocks.map((block) => block.id === blockID ? ({ ...block, [field]: value } as Block) : block) } : current)
        setMessage('Unsaved page changes. Run checks before saving.')
        setReadiness(undefined)
      }
      const paste = (event: ClipboardEvent) => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') ?? '') }
      const editKeydown = (event: KeyboardEvent) => { if (event.key === 'Enter' && field !== 'body' && !event.isComposing) { event.preventDefault(); return } if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); target.textContent = original; input(); setPreviewEditMode(false); window.parent.requestAnimationFrame(() => (document.defaultView?.frameElement as HTMLElement | null)?.focus()) } }
      const blockInteraction = (event: Event) => { if ((event.target as Element | null)?.closest('a, button, input, select, textarea, form') && !target.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation() } }
      blockNode.addEventListener('click', blockInteraction, true); target.addEventListener('input', input); target.addEventListener('paste', paste); target.addEventListener('keydown', editKeydown)
      cleanups.push(() => { blockNode.removeEventListener('click', blockInteraction, true); target.removeEventListener('input', input); target.removeEventListener('paste', paste); target.removeEventListener('keydown', editKeydown); delete target.dataset.pageEditorPreviewEdit; if (previousContentEditable === null) target.removeAttribute('contenteditable'); else target.setAttribute('contenteditable', previousContentEditable); if (previousRole === null) target.removeAttribute('role'); else target.setAttribute('role', previousRole); if (previousLabel === null) target.removeAttribute('aria-label'); else target.setAttribute('aria-label', previousLabel) })
      })
    }
    setPreviewInteractive(true)
    previewBlockCleanup.current = () => { cleanups.forEach((cleanup) => cleanup()); style.remove() }
  }, [activeBlockID, collapseBlock, previewEditMode, selectBlock])
  useEffect(() => {
    if (preview?.status === 'completed') wirePreviewBlocks()
    return () => previewBlockCleanup.current()
  }, [preview?.status, wirePreviewBlocks])
  const load = useCallback(async () => {
    const response = await fetch(
      `/api/editorial/page-editor/${encodeURIComponent(pageID)}`,
      { cache: 'no-store' },
    )
    const next = (await response.json()) as Context & { error?: string }
    if (!response.ok)
      throw new Error(next.error || 'Unable to load this page draft.')
    setData(next)
    setDraft(clone(next.page.draft))
    setStale(false)
    const active = activeBlockIDRef.current
    setActiveBlock(
      next.page.draft.blocks.some((block) => block.id === active)
        ? active
        : next.page.draft.blocks[0]?.id,
    )
    setChangeSetID((current) =>
      next.changeSets.some((item) => item.id === current)
        ? current
        : (next.changeSets[0]?.id ?? ''),
    )
    return next
  }, [pageID, setActiveBlock])
  useEffect(() => {
    void load()
      .then(() => setMessage(''))
      .catch((error: Error) => setMessage(error.message))
    return clearPreview
  }, [clearPreview, load])
  const edit = (update: Draft | ((current: Draft) => Draft)) => {
    clearPreview()
    setDraft((current) =>
      current
        ? typeof update === 'function'
          ? update(current)
          : update
        : current,
    )
    setMessage('Unsaved page changes.')
    setReadiness(undefined)
  }
  const poll = useCallback(
    async (jobID: string, page: string, version: number) => {
      const response = await fetch(
        `/api/editorial/direct-edit/preview?jobID=${encodeURIComponent(jobID)}&pageID=${encodeURIComponent(page)}`,
        { cache: 'no-store' },
      )
      const result = (await response.json()) as {
        job?: Preview
        error?: string
      }
      if (version !== requestVersion.current) return
      if (!response.ok || !result.job)
        throw new Error(result.error || 'Preview is unavailable.')
      setPreview(result.job)
      if (result.job.status === 'completed') {
        setMessage('Saved draft preview is ready.')
        return
      }
      if (result.job.status === 'failed')
        throw new Error('Preview could not be created.')
      setMessage('Rendering saved draft preview…')
      timer.current = window.setTimeout(
        () =>
          void poll(jobID, page, version).catch((error: Error) =>
            setMessage(error.message),
          ),
        1000,
      )
    },
    [],
  )
  const preparePreview = async (setID = selectedSet?.id) => {
    if (!setID) return
    clearPreview()
    const version = requestVersion.current
    setMessage('Rendering saved draft preview…')
    const response = await fetch('/api/editorial/direct-edit/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changeSetID: setID }),
    })
    const result = (await response.json()) as { job?: Preview; error?: string }
    if (!response.ok || !result.job)
      throw new Error(result.error || 'Preview is unavailable.')
    setPreview(result.job)
    await poll(result.job.id, pageID, version)
  }
  const validateDraft = async () => {
    if (!data || !draft || !selectedSet || !dirty) return false
    setBusy(true)
    setReadiness(undefined)
    setMessage('Checking page draft…')
    try {
      const response = await fetch(`/api/editorial/page-editor/${encodeURIComponent(pageID)}/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changeSetID: selectedSet.id, expectedPageHash: data.page.hash, expectedChangeSetRevision: selectedSet.revision, draft }) })
      const result = await response.json() as { valid?: boolean; error?: string; validation?: Array<{ path: string; message: string }>; quality?: { checks?: Array<{ name: string; status: string; errors?: Array<{ message: string }> }>; warnings?: string[]; readiness?: { publishable?: boolean; blockers?: Array<{ code?: string; path?: string; message?: string }>; issues?: Array<{ code?: string; path?: string; message?: string }>; warnings?: Array<{ code?: string; path?: string; message?: string }> } } }
      if (!response.ok || !result.valid) { if (response.status === 409) setStale(true); const details = result.validation?.map((item) => `${item.path}: ${item.message}`).join(' ') ; throw new Error(details || result.error || 'The page draft did not pass checks.') }
      const checks = result.quality?.checks ?? []
      const failed = checks.filter((check) => check.status !== 'passed')
      const checkErrors = failed.flatMap((check) => check.errors?.map((error) => error.message) ?? [])
      const warnings = result.quality?.warnings ?? []
      const readinessErrors = [...(result.quality?.readiness?.blockers ?? []), ...(result.quality?.readiness?.issues ?? [])]
      const text = (item: { code?: string; path?: string; message?: string } | string) => typeof item === 'string' ? item : `${item.code ? `${item.code}: ` : ''}${item.message ?? 'Readiness issue'}${item.path ? ` (${item.path})` : ''}`
      const message = !result.quality?.readiness?.publishable ? `Draft is valid to save, but is not ready to publish: ${[...checkErrors, ...readinessErrors.map(text)].join(' ') || 'resolve the reported readiness checks.'}` : failed.length ? `Draft is valid to save. ${checkErrors.join(' ') || `${failed.length} readiness checks need attention.`}` : warnings.length ? `Draft is valid to save with advisory warnings: ${warnings.join(' ')}` : checks.length ? `Checks passed: ${checks.map((check) => check.name).join(', ')}.` : 'Page draft is valid and ready to save.'
      setReadiness({ message, fingerprint: JSON.stringify({ draft, changeSetID: selectedSet.id, revision: selectedSet.revision, pageHash: data.page.hash }) })
      setMessage('Draft checks are ready for review before saving.')
      return true
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to check this page draft.'); return false } finally { setBusy(false) }
  }
  const save = async () => {
    if (!data || !draft || !selectedSet || !dirty) return
    if (!readiness || readiness.fingerprint !== JSON.stringify({ draft, changeSetID: selectedSet.id, revision: selectedSet.revision, pageHash: data.page.hash })) {
      await validateDraft()
      return
    }
    setBusy(true)
    clearPreview()
    setMessage('Saving page draft…')
    try {
      const response = await fetch(
        `/api/editorial/page-editor/${encodeURIComponent(pageID)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            changeSetID: selectedSet.id,
            expectedPageHash: data.page.hash,
            expectedChangeSetRevision: selectedSet.revision,
            draft,
          }),
        },
      )
      const result = (await response.json()) as { error?: string }
      if (!response.ok) {
        if (response.status === 409) setStale(true)
        throw new Error(result.error || 'Unable to save this page draft.')
      }
      const next = await load()
      const set = next.changeSets.find((item) => item.id === selectedSet.id)
      setChangeSetID(set?.id ?? '')
      setMessage('Draft saved. Rendering preview…')
      await preparePreview(set?.id)
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to save this page draft.',
      )
    } finally {
      setBusy(false)
    }
  }
  const createSet = async () => {
    setBusy(true)
    setMessage('Creating change set…')
    try {
      const response = await fetch('/api/editorial/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newSetName }),
      })
      const result = (await response.json()) as { id?: string; error?: string }
      if (!response.ok || !result.id)
        throw new Error(result.error || 'Unable to create a change set.')
      const next = await load()
      setChangeSetID(
        next.changeSets.find((item) => item.id === result.id)?.id ?? '',
      )
      setMessage('Change set created.')
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to create a change set.',
      )
    } finally {
      setBusy(false)
    }
  }
  const submit = async () => {
    if (!selectedSet || dirty) return
    setBusy(true)
    clearPreview()
    setMessage('Submitting for review…')
    try {
      const response = await fetch('/api/editorial/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: selectedSet.id }),
      })
      const result = (await response.json()) as { error?: string }
      if (!response.ok)
        throw new Error(result.error || 'Unable to submit this change set.')
      setMessage('Submitted for review.')
      setData((current) =>
        current
          ? {
              ...current,
              changeSets: current.changeSets.filter(
                (item) => item.id !== selectedSet.id,
              ),
            }
          : current,
      )
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to submit this change set.',
      )
    } finally {
      setBusy(false)
    }
  }
  const moveBlock = (index: number, direction: -1 | 1) =>
    edit((current) => {
      const blocks = [...current.blocks]
      ;[blocks[index], blocks[index + direction]] = [
        blocks[index + direction]!,
        blocks[index]!,
      ]
      return { ...current, blocks }
    })
  const addBlock = (type: Block['type']) => {
    if (!data) return
    const block = blockDefault(type, data.references)
    if (!block) return
    edit((current) => ({
      ...current,
      blocks: [...current.blocks, block as unknown as Block],
    }))
    setActiveBlock(String(block.id))
    closePicker()
  }
  if (!data || !draft)
    return (
      <main className={styles.editor} data-page-editor>
        <p role="status">{message}</p>
      </main>
    )
  return (
    <main
      className={styles.editor}
      data-page-editor
      data-page-editor-theme={selectedTheme?.name}
      data-page-editor-theme-version={selectedTheme?.version}
    >
      <header className={styles.editorHeader}>
        <div>
          <nav aria-label="Breadcrumb" data-page-editor-breadcrumb>
            {data.breadcrumb.map((item, index) => (
              <span key={`${item.label}:${index}`}>
                {index ? ' / ' : ''}
                {item.href ? <a href={item.href}>{item.label}</a> : item.label}
              </span>
            ))}
          </nav>
          <div className={styles.titleRow}>
            <h1>{draft.title}</h1>
            <span data-page-template>{data.page.template}</span>
          </div>
        </div>
        <div className={styles.actions} data-page-editor-actions>
          <span className={styles.changeState} data-page-state>
            {data.page.state} ·{' '}
            {selectedSet
              ? `${selectedSet.name} · ${selectedSet.changes} changes`
              : 'No editable change set'}
          </span>
          <button
            type="button"
            disabled={busy || !dirty || !selectedSet}
            onClick={() => void validateDraft()}
          >
            Check draft
          </button>
          <button
            type="button"
            disabled={busy || !dirty || !selectedSet}
            onClick={() => void save()}
          >
            Save draft
          </button>
          <button
            type="button"
            disabled={
              busy || dirty || !selectedSet || selectedSet.changes === 0
            }
            onClick={() => void submit()}
          >
            Submit for review
          </button>
        </div>
      </header>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {readiness ? <section className={styles.readiness} data-page-editor-readiness aria-label="Draft check results"><strong>Draft checks</strong><p>{readiness.message}</p></section> : null}
      {stale ? <section className={styles.stale} role="alert" data-page-editor-stale><p>This draft changed elsewhere. Your unsaved text is still available.</p><button type="button" onClick={() => { if (window.confirm('Reload and discard your unsaved page changes?')) { clearPreview(); void load().then(() => setMessage('Reloaded the latest draft.')).catch((error: Error) => setMessage(error.message)) } }}>Reload and discard changes</button></section> : null}
      {!selectedSet ? (
        <section className={styles.createSet}>
          <label>
            Change set name
            <input
              value={newSetName}
              maxLength={120}
              onChange={(event) => setNewSetName(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !newSetName.trim()}
            onClick={() => void createSet()}
          >
            Create change set
          </button>
        </section>
      ) : (
        <label className={styles.setPicker}>
          Change set
          <select
            value={selectedSet.id}
            disabled={busy || dirty}
            onChange={(event) => {
              clearPreview()
              setChangeSetID(event.target.value)
              setReadiness(undefined)
            }}
          >
            {data.changeSets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.state})
              </option>
            ))}
          </select>
        </label>
      )}
      {dirty ? (
        <p className={styles.unsaved}>
          You have unsaved page changes. The preview shows only the last saved
          draft, and submission is disabled until you save or reload.
        </p>
      ) : null}
      <div className={styles.workspace} data-page-editor-workspace>
        <div className={styles.controls}>
          <details className={styles.pageFields} data-page-editor-fields>
            <summary>
              Page fields <span>Title, summary, metadata, URL and SEO</span>
            </summary>
            <div>
              <label>
                Title
                <input
                  value={draft.title}
                  maxLength={160}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Summary
                <textarea
                  value={draft.summary}
                  maxLength={300}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      summary: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                URL segment
                <input
                  value={draft.slug}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      slug: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                SEO description
                <input
                  value={draft.seoDescription ?? ''}
                  maxLength={160}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      seoDescription: event.target.value,
                    }))
                  }
                />
              </label>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={draft.noindex}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      noindex: event.target.checked,
                    }))
                  }
                />{' '}
                Hide from search engines and public search
              </label>
              <MetadataFields
                template={data.page.template}
                value={draft}
                disabled={busy}
                supportsServiceMetadata={supportsPageMetadata}
                onChange={(metadata) =>
                  edit((current) => ({ ...current, ...metadata }))
                }
              />
            </div>
          </details>
          <section className={styles.blocks} data-page-editor-blocks>
            <header>
              <h2>Blocks</h2>
              <span>Ordered contract content</span>
            </header>
            {draft.blocks.map((block, index) => (
              <BlockEditor
                key={block.id}
                block={block}
                index={index}
                total={draft.blocks.length}
                references={data.references}
                active={activeBlockID === block.id}
                capabilities={data.appearanceCapabilities}
                onSelect={() => selectBlock(block.id)}
                onChange={(update) =>
                  edit((current) => ({
                    ...current,
                    blocks: current.blocks.map((item, itemIndex) =>
                      itemIndex === index ? update(item) : item,
                    ),
                  }))
                }
                onMove={(direction) => moveBlock(index, direction)}
                onRemove={() =>
                  edit((current) => {
                    const blocks = current.blocks.filter(
                      (_, itemIndex) => itemIndex !== index,
                    )
                    setActiveBlock(blocks[index]?.id ?? blocks[index - 1]?.id)
                    return { ...current, blocks }
                  })
                }
              />
            ))}
            <button
              ref={pickerTrigger}
              type="button"
              className={styles.addBlock}
              onClick={() => setPicker(true)}
            >
              + Add block
            </button>
          </section>
        </div>
        <section
          className={styles.preview}
          aria-label="Saved draft preview"
          data-page-editor-preview
        >
          <header>
            <span>
              <i />
              Saved draft preview · {selectedTheme
                ? `${title(selectedTheme.name)} ${selectedTheme.version}`
                : 'Theme unavailable'}
            </span>
            <div>
              <button
                type="button"
                aria-pressed={!mobile}
                onClick={() => setMobile(false)}
              >
                Desktop
              </button>
              <button
                type="button"
                aria-pressed={mobile}
                onClick={() => setMobile(true)}
              >
                Mobile
              </button>
            </div>
            <button type="button" aria-pressed={previewEditMode} disabled={preview?.status !== 'completed' || !previewTextAvailable} onClick={() => setPreviewEditMode((current) => !current)}>
              {previewEditMode ? 'Finish preview text editing' : 'Edit text in preview'}
            </button>
            {preview?.status === 'completed' ? (
              <small data-page-editor-preview-selection>
                {previewInteractive === false
                  ? 'Block selection unavailable for this renderer.'
                  : previewEditMode
                    ? 'Type in supported text fields. Escape cancels the focused field.'
                    : previewTextAvailable
                      ? 'Select a rendered block or edit supported text in the preview.'
                      : 'Select a rendered block to edit it.'}
              </small>
            ) : null}
          </header>
          <div
            ref={previewCanvas}
            className={styles.previewCanvas}
            tabIndex={0}
            aria-label="Rendered page preview"
          >
            {preview?.status === 'completed' ? (
              <div
                className={styles.previewFrameViewport}
                style={{
                  width: `${(mobile ? 390 : 1280) * Math.min(1, previewWidth / (mobile ? 390 : 1280))}px`,
                  height: `${600 * Math.min(1, previewWidth / (mobile ? 390 : 1280))}px`,
                }}
              >
                <iframe
                  ref={previewFrame}
                  title="Saved page draft preview"
                  style={{
                    width: mobile ? 390 : 1280,
                    transform: `scale(${Math.min(1, previewWidth / (mobile ? 390 : 1280))})`,
                  }}
                  src={`/preview/changes/${preview.id}/proposed${preview.path ?? '/'}`}
                  onLoad={wirePreviewBlocks}
                />
              </div>
            ) : (
              <div className={styles.previewEmpty}>
                <p>
                  {dirty
                    ? 'Save changes to render an updated preview.'
                    : 'Render the current saved draft with the production preview worker.'}
                </p>
                <button
                  type="button"
                  disabled={
                    busy || dirty || !selectedSet || selectedSet.changes === 0
                  }
                  onClick={() =>
                    void preparePreview().catch((error: Error) =>
                      setMessage(error.message),
                    )
                  }
                >
                  Prepare preview
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
      {picker ? (
        <div
          className={styles.backdrop}
          data-page-editor-picker
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closePicker()
          }}
        >
          <section
            ref={pickerDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="block-picker-title"
            className={styles.dialog}
          >
            <header>
              <div>
                <h2 id="block-picker-title">Add a block</h2>
                <p>
                  Blocks allowed by the {data.page.template} template. Reference
                  blocks use existing authorized pages and media.
                </p>
              </div>
              <button
                type="button"
                data-page-picker-close
                onClick={closePicker}
              >
                Close
              </button>
            </header>
            <div className={styles.catalog}>
              {data.blockCatalog.map((item) => {
                const candidate = blockDefault(item.type, data.references)
                return (
                  <button
                    type="button"
                    data-page-block-type={item.type}
                    key={item.type}
                    disabled={!candidate}
                    onClick={() => addBlock(item.type)}
                  >
                    <strong>{title(item.type)}</strong>
                    <span>{item.fieldLimits}</span>
                    {!candidate ? (
                      <small>
                        Add the required media or service-page reference first.
                      </small>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}
