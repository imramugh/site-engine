import type { Dispatch, SetStateAction } from 'react'
import styles from './site-workspace.module.css'
import { emptyNavigation, type Reference, type References, type Settings } from './site-types'

type Props = { busy: boolean; canSave: boolean; references: References; settings: Settings; setSettings: Dispatch<SetStateAction<Settings | null>>; save: () => void }
const move = <T,>(items: T[], index: number, direction: -1 | 1) => {
  const next = [...items], target = index + direction
  if (target < 0 || target >= next.length) return next
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

function LinkRow({ item, references, header, index, count, change, reorder, remove }: { item: Reference; references: References; header?: boolean; index: number; count: number; change: (value: Reference) => void; reorder: (direction: -1 | 1) => void; remove: () => void }) {
  const options = (kind: Reference['kind']) => kind === 'page' ? references.pages : references.sections
  return <div className={styles.navLinkRow} data-site-navigation-item>
    <details><summary><strong>{item.label || 'Untitled link'}</strong><span>{item.style === 'button' ? 'Button' : item.kind === 'section' ? 'Section' : 'Page'}</span></summary>
      <div className={styles.navLinkFields}>
        <label>Type<select value={item.kind} onChange={event => { const kind = event.target.value as Reference['kind']; change({ ...item, kind, id: options(kind)[0]?.id ?? '' }) }}><option value="page">Page</option><option value="section">Section</option></select></label>
        <label>Destination<select required value={item.id} onChange={event => change({ ...item, id: event.target.value })}>{options(item.kind).map(option => <option key={option.id} value={option.id}>{option.title}</option>)}</select></label>
        <label>Label<input required maxLength={80} value={item.label} onChange={event => change({ ...item, label: event.target.value })} /></label>
        {header && <label>Style<select value={item.style ?? 'link'} onChange={event => change({ ...item, style: event.target.value as 'link' | 'button' })}><option value="link">Link</option><option value="button">Button</option></select></label>}
        <button type="button" onClick={remove}>Remove link</button>
      </div>
    </details>
    <div className={styles.navOrder}><button type="button" aria-label={`Move ${item.label || 'link'} up`} disabled={index === 0} onClick={() => reorder(-1)}>↑</button><button type="button" aria-label={`Move ${item.label || 'link'} down`} disabled={index === count - 1} onClick={() => reorder(1)}>↓</button></div>
  </div>
}

export function SiteNavigationEditor({ busy, canSave, references, settings, setSettings, save }: Props) {
  const navigation = settings.navigation ?? emptyNavigation
  const setNavigation = (next: typeof navigation) => setSettings({ ...settings, navigation: next })
  const updateHeader = (index: number, value: Reference) => { const next = structuredClone(navigation); next.header[index] = value; setNavigation(next) }
  const updateColumn = (index: number, patch: Partial<(typeof navigation.footer.columns)[number]>) => { const next = structuredClone(navigation); next.footer.columns[index] = { ...next.footer.columns[index], ...patch }; setNavigation(next) }
  const newLink = (): Reference => ({ kind: 'page', id: references.pages[0]?.id ?? '', label: references.pages[0]?.title ?? '' })
  return <section data-site-panel="navigation" data-site-navigation>
    <h2 className={styles.srOnly}>Navigation</h2>
    <form onSubmit={event => { event.preventDefault(); save() }} onInvalidCapture={event => { const details = (event.target as HTMLElement).closest('details'); if (details) details.open = true }}>
      <fieldset disabled={busy} className={styles.navigationGrid}><legend className={styles.srOnly}>Public navigation</legend>
        <section className={styles.navigationCard} data-site-navigation-header><header><h3>Header</h3><small>Up to 5 items + one button</small></header>
          {!navigation.header.length && <p className={styles.navEmpty}>The theme’s default header is in use. Add links to configure its order and labels.</p>}
          {navigation.header.map((item, index) => <LinkRow key={index} item={item} references={references} header index={index} count={navigation.header.length} change={value => updateHeader(index, value)} reorder={direction => setNavigation({ ...navigation, header: move(navigation.header, index, direction) })} remove={() => setNavigation({ ...navigation, header: navigation.header.filter((_, i) => i !== index) })} />)}
          <button className={styles.navAdd} type="button" disabled={navigation.header.length >= 6 || !references.pages.length} onClick={() => setNavigation({ ...navigation, header: [...navigation.header, { ...newLink(), style: 'link' }] })}>Add header link</button>
        </section>
        <section className={styles.navigationCard} data-site-navigation-footer><header><h3>Footer</h3><small>Three columns and a bottom line</small></header>
          {!navigation.footer.columns.length && <p className={styles.navEmpty}>The theme’s default footer is in use. Add columns to choose its links.</p>}
          {navigation.footer.columns.map((column, columnIndex) => <section className={styles.navColumn} key={columnIndex}><div className={styles.navColumnHeading}><span>Column {columnIndex + 1}</span><label><span className={styles.srOnly}>Column title</span><input required maxLength={80} value={column.heading} onChange={event => updateColumn(columnIndex, { heading: event.target.value })} /></label><button type="button" aria-label={`Remove ${column.heading} column`} onClick={() => setNavigation({ ...navigation, footer: { ...navigation.footer, columns: navigation.footer.columns.filter((_, i) => i !== columnIndex) } })}>Remove</button></div>
            {column.links.map((item, index) => <LinkRow key={index} item={item} references={references} index={index} count={column.links.length} change={value => { const links = [...column.links]; const { style: _style, ...reference } = value; links[index] = reference; updateColumn(columnIndex, { links }) }} reorder={direction => updateColumn(columnIndex, { links: move(column.links, index, direction) })} remove={() => updateColumn(columnIndex, { links: column.links.filter((_, i) => i !== index) })} />)}
            <button className={styles.navAdd} type="button" disabled={column.links.length >= 12 || !references.pages.length} onClick={() => updateColumn(columnIndex, { links: [...column.links, newLink()] })}>Add link</button>
          </section>)}
          <button className={styles.navAdd} type="button" disabled={navigation.footer.columns.length >= 3} onClick={() => setNavigation({ ...navigation, footer: { ...navigation.footer, columns: [...navigation.footer.columns, { heading: 'Explore', links: [] }] } })}>Add footer column</button>
          <div className={styles.navCopyright}><label>Copyright text<input maxLength={240} value={navigation.footer.copyright ?? ''} onChange={event => { const footer = { ...navigation.footer }; if (event.target.value) footer.copyright = event.target.value; else delete footer.copyright; setNavigation({ ...navigation, footer }) }} /></label><small>Contact information comes from Business details.</small></div>
        </section>
        <div className={styles.formActions}><button type="submit" disabled={!canSave}>Save navigation</button><span>Links are checked before the changes enter review.</span></div>
      </fieldset>
    </form>
  </section>
}
