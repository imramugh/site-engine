import type { Dispatch, SetStateAction } from 'react'
import styles from './site-workspace.module.css'
import { emptyNavigation, type FooterColumn, type FooterReference, type Reference, type References, type Settings } from './site-types'

type Props = { busy: boolean; canSave: boolean; contractVersion: string | null; references: References; settings: Settings; setSettings: Dispatch<SetStateAction<Settings | null>>; save: () => void }
const move = <T,>(items: T[], index: number, direction: -1 | 1) => {
  const next = [...items], target = index + direction
  if (target < 0 || target >= next.length) return next
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}
const isUnavailable = (item: Reference | FooterReference): item is Extract<Reference, { kind: 'unavailable' }> => item.kind === 'unavailable'

function LinkRow({ item, references, header, allowUnavailable = true, index, count, change, reorder, remove }: { item: Reference; references: References; header?: boolean; allowUnavailable?: boolean; index: number; count: number; change: (value: Reference) => void; reorder: (direction: -1 | 1) => void; remove: () => void }) {
  const options = (kind: 'page' | 'section') => kind === 'page' ? references.pages : references.sections
  return <div className={styles.navLinkRow} data-site-navigation-item data-navigation-kind={item.kind}>
    <details><summary><strong>{item.label || 'Untitled item'}</strong><span>{item.style === 'button' ? 'Button' : item.kind === 'unavailable' ? 'Unavailable' : item.kind === 'section' ? 'Section' : 'Page'}</span></summary>
      <div className={styles.navLinkFields}>
        <label>Type<select value={item.kind} onChange={event => { const kind = event.target.value as Reference['kind']; if (kind === 'unavailable') change({ kind, label: item.label, reason: 'This destination is not available yet.', style: item.style }); else change({ kind, id: options(kind)[0]?.id ?? '', label: item.label, style: item.style }) }}><option value="page">Page</option><option value="section">Section</option><option value="unavailable" disabled={!allowUnavailable}>Unavailable</option></select></label>
        {isUnavailable(item) ? <label>Explanation<input required maxLength={160} value={item.reason} onChange={event => change({ ...item, reason: event.target.value })} /></label> : <label>Destination<select required value={item.id} onChange={event => change({ ...item, id: event.target.value })}>{options(item.kind).map(option => <option key={option.id} value={option.id}>{option.title}</option>)}</select></label>}
        <label>Label<input required maxLength={80} value={item.label} onChange={event => change({ ...item, label: event.target.value })} /></label>
        {header && <label>Style<select value={item.style ?? 'link'} onChange={event => change({ ...item, style: event.target.value as 'link' | 'button' })}><option value="link">Link</option><option value="button">Button</option></select></label>}
        <button type="button" onClick={remove}>Remove item</button>
      </div>
    </details>
    <div className={styles.navOrder}><button type="button" aria-label={`Move ${item.label || 'item'} up`} disabled={index === 0} onClick={() => reorder(-1)}>↑</button><button type="button" aria-label={`Move ${item.label || 'item'} down`} disabled={index === count - 1} onClick={() => reorder(1)}>↓</button></div>
  </div>
}

export function SiteNavigationEditor({ busy, canSave, contractVersion, references, settings, setSettings, save }: Props) {
  const navigation = settings.navigation ?? emptyNavigation
  const supports16 = contractVersion === '1.6.0'
  const setNavigation = (next: typeof navigation) => setSettings({ ...settings, navigation: next })
  const updateHeader = (index: number, value: Reference) => { const next = structuredClone(navigation); next.header[index] = value; setNavigation(next) }
  const updateColumn = (index: number, value: FooterColumn) => { const next = structuredClone(navigation); next.footer.columns[index] = value; setNavigation(next) }
  const newLink = (): Reference => ({ kind: 'page', id: references.pages[0]?.id ?? '', label: references.pages[0]?.title ?? '' })
  const manual = (column: FooterColumn): column is Extract<FooterColumn, { links: FooterReference[] }> => 'links' in column
  const addColumn = (kind: 'links' | 'section-pillars' | 'contact') => {
    if (kind === 'links') setNavigation({ ...navigation, footer: { ...navigation.footer, columns: [...navigation.footer.columns, { kind, heading: 'Company', links: [] }] } })
    if (kind === 'section-pillars') setNavigation({ ...navigation, footer: { ...navigation.footer, columns: [...navigation.footer.columns, { kind, heading: 'Services', sectionId: references.sections[0]?.id ?? '' }] } })
    if (kind === 'contact') setNavigation({ ...navigation, footer: { ...navigation.footer, columns: [...navigation.footer.columns, { kind, heading: 'Contact', fields: ['phone', 'email', 'address', 'linkedIn'] }] } })
  }
  const bottomLinks = navigation.footer.bottomLinks ?? []
  return <section data-site-panel="navigation" data-site-navigation>
    <h2 className={styles.srOnly}>Navigation</h2>
    <form onSubmit={event => { event.preventDefault(); save() }} onInvalidCapture={event => { const details = (event.target as HTMLElement).closest('details'); if (details) details.open = true }}>
      <fieldset disabled={busy} className={styles.navigationGrid}><legend className={styles.srOnly}>Public navigation</legend>
        <section className={styles.navigationCard} data-site-navigation-header><header><h3>Header</h3><small>Up to 5 links + one button</small></header>
          {!navigation.header.length && <p className={styles.navEmpty}>The theme’s default header is in use. Add items to configure its order and labels.</p>}
          {navigation.header.map((item, index) => <LinkRow key={index} item={item} references={references} header allowUnavailable={supports16} index={index} count={navigation.header.length} change={value => updateHeader(index, value)} reorder={direction => setNavigation({ ...navigation, header: move(navigation.header, index, direction) })} remove={() => setNavigation({ ...navigation, header: navigation.header.filter((_, i) => i !== index) })} />)}
          <button className={styles.navAdd} data-site-navigation-add type="button" disabled={navigation.header.length >= 6 || !references.pages.length} onClick={() => setNavigation({ ...navigation, header: [...navigation.header, { ...newLink(), style: 'link' }] })}>Add header item</button>
          {!supports16 && <p className={styles.navCapability}>Choose a contract 1.6 theme in this change set to mark planned destinations as unavailable.</p>}
        </section>
        <section className={styles.navigationCard} data-site-navigation-footer><header><h3>Footer</h3><small>Three columns and a bottom line</small></header>
          {!navigation.footer.columns.length && <p className={styles.navEmpty}>The theme’s default footer is in use. Add columns to choose its content.</p>}
          {navigation.footer.columns.map((column, columnIndex) => <section className={styles.navColumn} data-site-navigation-column data-navigation-column-kind={column.kind ?? 'links'} key={columnIndex}>
            <div className={styles.navColumnHeading}><span>Column {columnIndex + 1}</span><label><span className={styles.srOnly}>Column title</span><input required maxLength={80} value={column.heading} onChange={event => updateColumn(columnIndex, { ...column, heading: event.target.value })} /></label><small>{column.kind === 'section-pillars' ? 'Generated' : column.kind === 'contact' ? 'From Business details' : 'Links'}</small><button type="button" aria-label={`Remove ${column.heading} column`} onClick={() => setNavigation({ ...navigation, footer: { ...navigation.footer, columns: navigation.footer.columns.filter((_, i) => i !== columnIndex) } })}>Remove</button></div>
            {manual(column) && <>{column.links.map((item, index) => <LinkRow key={index} item={{ ...item, style: 'link' }} references={references} index={index} count={column.links.length} change={value => { const links = [...column.links]; const { style: _style, ...reference } = value; links[index] = reference; updateColumn(columnIndex, { ...column, links }) }} reorder={direction => updateColumn(columnIndex, { ...column, links: move(column.links, index, direction) })} remove={() => updateColumn(columnIndex, { ...column, links: column.links.filter((_, i) => i !== index) })} />)}<button className={styles.navAdd} data-site-navigation-add type="button" disabled={column.links.length >= 12 || !references.pages.length} onClick={() => { const { style: _style, ...reference } = newLink(); updateColumn(columnIndex, { ...column, links: [...column.links, reference] }) }}>Add a link</button></>}
            {column.kind === 'section-pillars' && <><label>Services section<select required value={column.sectionId} onChange={event => updateColumn(columnIndex, { ...column, sectionId: event.target.value })}>{references.sections.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}</select></label><div className={styles.generatedPills}>{references.sections.find(section => section.id === column.sectionId)?.pillars.map(page => <span key={page.id}>{page.title}</span>)}</div><p>The published root pillar pages appear in their Content order.</p></>}
            {column.kind === 'contact' && <><div className={styles.contactFields}>{(['phone','email','address','linkedIn'] as const).map(field => <label key={field}><input type="checkbox" checked={column.fields.includes(field)} onChange={event => updateColumn(columnIndex, { ...column, fields: event.target.checked ? [...column.fields, field] : column.fields.filter(item => item !== field) })} />{field === 'linkedIn' ? 'LinkedIn' : field[0]!.toUpperCase() + field.slice(1)}</label>)}</div><p>Values come from Business details; empty values are omitted.</p></>}
          </section>)}
          <div className={styles.navAddRow}><button className={styles.navAdd} type="button" disabled={navigation.footer.columns.length >= 3} onClick={() => addColumn('links')}>Add links column</button><button className={styles.navAdd} type="button" disabled={!supports16 || navigation.footer.columns.length >= 3 || !references.sections.length} onClick={() => addColumn('section-pillars')}>Add generated Services</button><button className={styles.navAdd} type="button" disabled={!supports16 || navigation.footer.columns.length >= 3} onClick={() => addColumn('contact')}>Add contact details</button></div>
          <div className={styles.navBottomLinks} data-site-navigation-bottom><strong>Bottom links</strong>{bottomLinks.map((item, index) => <LinkRow key={index} item={{ ...item, style: 'link' }} references={references} index={index} count={bottomLinks.length} change={value => { const { style: _style, ...reference } = value; const links = [...bottomLinks]; links[index] = reference; setNavigation({ ...navigation, footer: { ...navigation.footer, bottomLinks: links } }) }} reorder={direction => setNavigation({ ...navigation, footer: { ...navigation.footer, bottomLinks: move(bottomLinks, index, direction) } })} remove={() => setNavigation({ ...navigation, footer: { ...navigation.footer, bottomLinks: bottomLinks.filter((_, i) => i !== index) } })} />)}<button className={styles.navAdd} type="button" disabled={!supports16 || bottomLinks.length >= 6 || !references.pages.length} onClick={() => { const { style: _style, ...reference } = newLink(); setNavigation({ ...navigation, footer: { ...navigation.footer, bottomLinks: [...bottomLinks, reference] } }) }}>Add bottom link</button></div>
          <div className={styles.navCopyright}><label>Copyright<input maxLength={240} value={navigation.footer.copyright ?? ''} placeholder={`© {year} ${settings.legalName || settings.siteName}`} onChange={event => { const footer = { ...navigation.footer }; if (event.target.value) footer.copyright = event.target.value; else delete footer.copyright; setNavigation({ ...navigation, footer }) }} /></label><small><code>{'{year}'}</code> updates automatically. The theme adds Reduce motion only when it uses motion.</small></div>
        </section>
        <div className={styles.formActions}><button type="submit" disabled={!canSave}>Save navigation</button><span>Links are checked before the changes enter review.</span></div>
      </fieldset>
    </form>
  </section>
}
