'use client'

import type { AdminNavigationBadges, AdminNavigationItem, AdminRole } from '../../src/admin-navigation'
import type { ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import styles from './staff-shell.module.css'

type Props = {
  primary: readonly AdminNavigationItem[]
  site: readonly AdminNavigationItem[]
  displayName: string
  email: string
  provider: string | null
  roles: readonly AdminRole[]
  badges: AdminNavigationBadges
}

const titleForPath = (pathname: string) => {
  const titles: Record<string, string> = {
    '/admin': 'Dashboard', '/content-tree': 'Pages', '/block-gallery': 'Block gallery', '/media': 'Media', '/leads': 'Leads',
    '/applications': 'Careers', '/editorial': 'Reviews', '/operations': 'Change log', '/integrations': 'Integrations',
    '/site': 'Site', '/themes': 'Themes', '/users': 'Users', '/account': 'Account', '/ai-jobs': 'AI jobs', '/direct-edit': 'Hero draft editor',
  }
  const collectionTitles: Record<string, string> = { assets: 'Media', users: 'Users', pages: 'Pages', sections: 'Sections', redirects: 'Redirects', 'audit-events': 'Audit events', 'site-settings': 'Site' }
  const collection = pathname.match(/^\/admin\/collections\/([^/]+)/)?.[1]
  if (collection && collectionTitles[collection]) return collectionTitles[collection]
  if (pathname === '/content-editor/new') return 'Create page'
  if (/^\/content-editor\/[0-9a-f-]+$/i.test(pathname)) return 'Edit page'
  return titles[pathname] ?? 'Workspace'
}

/** Static Lucide SVG primitives (ISC) keep the shell dependency-free. */
function NavIcon({ label }: { label: string }) {
  const frame = (children: ReactNode) => <svg className={styles.navIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
  switch (label) {
    case 'Dashboard': return frame(<><rect width="7" height="9" x="3" y="3" rx="1" /><rect width="7" height="5" x="14" y="3" rx="1" /><rect width="7" height="9" x="14" y="12" rx="1" /><rect width="7" height="5" x="3" y="16" rx="1" /></>)
    case 'Content': return frame(<><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 9H8M16 13H8M16 17H8" /></>)
    case 'Block gallery': return frame(<><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></>)
    case 'Media': return frame(<><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></>)
    case 'Leads': return frame(<><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>)
    case 'Careers': return frame(<><path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /><rect width="20" height="14" x="2" y="6" rx="2" /></>)
    case 'Reviews': return frame(<><rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" /></>)
    case 'Change log': return frame(<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v5h5M12 7v5l4 2" /></>)
    case 'Site': return frame(<><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" /></>)
    case 'Integrations': return frame(<><path d="M12 22v-5M15 8V2M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1zM9 8V2" /></>)
    case 'Users': return frame(<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.128a4 4 0 0 1 0 7.744M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" /></>)
    default: return frame(<path d="M12 3v18M3 12h18" />)
  }
}

function focusWorkspace(): void {
  const target = document.getElementById('admin-workspace') ?? document.querySelector<HTMLElement>('main') ?? document.querySelector<HTMLElement>('.template-default__wrap')
  if (!target) return
  target.tabIndex = -1
  target.focus()
}

export function SkipNavigation() {
  useEffect(() => {
    const target = document.getElementById('admin-workspace') ?? document.querySelector<HTMLElement>('main') ?? document.querySelector<HTMLElement>('.template-default__wrap')
    if (target) { target.id = 'admin-workspace'; target.tabIndex = -1 }
  }, [])
  const skip = (event: React.MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); focusWorkspace() }
  const skipFromKeyboard = (event: React.KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault(); focusWorkspace()
  }
  return <nav className={styles.skipNavigation} aria-label="Skip navigation"><a className={styles.skipLink} href="#admin-workspace" onClick={skip} onKeyDown={skipFromKeyboard}>Skip navigation</a></nav>
}

/** Ensures this client chunk is registered before Payload hydrates its import-map Nav. */
export function AdminNavigationClientRuntime() { return null }

type SearchResult = { title: string; url: string; category: 'Pages' | 'Media' | 'Leads' }
type SearchResponse = { results: Record<SearchResult['category'], SearchResult[]> }

function AdminGlobalSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'empty' | 'error' | 'ready'>('idle')
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const listID = useId()
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey)) return
      event.preventDefault()
      input.current?.focus()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])
  useEffect(() => {
    const value = query.trim()
    setActive(-1)
    setResults([])
    if (!value) { setResults([]); setState('idle'); return }
    if (value.length < 2) { setResults([]); setState('idle'); return }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setState('loading')
      try {
        const response = await fetch(`/api/admin/search?q=${encodeURIComponent(value)}`, { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error('Search is unavailable.')
        const body = await response.json() as SearchResponse
        if (controller.signal.aborted) return
        const found = (['Pages', 'Media', 'Leads'] as const).flatMap(category => body.results[category] ?? [])
        setResults(found); setState(found.length ? 'ready' : 'empty')
      } catch (error) { if (!controller.signal.aborted) { setResults([]); setState('error') } }
    }, 180)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [query])
  const choose = (result: SearchResult) => { window.location.assign(result.url) }
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { setQuery(''); setResults([]); setState('idle'); return }
    if (!results.length) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(current => (current + 1) % results.length) }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(current => (current - 1 + results.length) % results.length) }
    if (event.key === 'Enter' && active >= 0) { event.preventDefault(); choose(results[active]!) }
  }
  return <div className={styles.adminSearch} data-admin-search>
    <label className={styles.srOnly} htmlFor="admin-global-search">Search pages, leads, media</label>
    <svg className={styles.adminSearchIcon} data-admin-search-icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
    <input ref={input} id="admin-global-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} role="combobox" aria-autocomplete="list" aria-expanded={state !== 'idle'} aria-controls={listID} aria-activedescendant={active >= 0 ? `admin-search-result-${active}` : undefined} placeholder="Search pages, leads, media…" maxLength={80} />
    <kbd className={styles.adminSearchShortcut} data-admin-search-shortcut aria-hidden="true">⌘K</kbd>
    {state !== 'idle' && <div id={listID} className={styles.searchResults} {...(state === 'ready' ? { role: 'listbox', 'aria-label': 'Search results' } : {})}>
      {state === 'loading' && <p role="status">Searching…</p>}
      {state === 'empty' && <p role="status">No matching records.</p>}
      {state === 'error' && <p role="alert">Search is unavailable. Try again.</p>}
      {state === 'ready' && results.map((result, index) => <button id={`admin-search-result-${index}`} key={`${result.category}:${result.url}`} type="button" role="option" aria-selected={index === active} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(result)}><span>{result.title}</span><small>{result.category}</small></button>)}
    </div>}
  </div>
}

export function AdminWorkspaceHeader() {
  const pathname = usePathname()
  return <header className={styles.header} data-admin-header>{pathname === '/admin' ? <h1 data-admin-page-title>{titleForPath(pathname)}</h1> : <p data-admin-page-title>{titleForPath(pathname)}</p>}<div className={styles.headerActions}><AdminGlobalSearch /><a href="/" data-admin-view-site>View site <span aria-hidden="true">↗</span></a></div></header>
}

export function AdminNavigationToggle({ primary, site, displayName, email, provider, roles, badges }: Props) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const pathname = usePathname()
  const [signingOut, setSigningOut] = useState(false)
  const signOut = async (all = false) => {
    if (all && !window.confirm('Sign out every session, including this one?')) return
    setSigningOut(true)
    const response = await fetch(all ? '/api/account/sessions' : '/api/auth/logout', all ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'revoke-all' }) } : { method: 'POST' })
    if (response.ok) window.location.assign('/admin/login')
    else setSigningOut(false)
  }
  const close = () => { setOpen(false); button.current?.focus() }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && open) close() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [open])
  const link = (item: AdminNavigationItem) => {
    const badge = badges[item.label as keyof AdminNavigationBadges]
    const grouped = (item.href === '/content-tree' && pathname.startsWith('/content-editor/'))
      || (item.label === 'Site' && (pathname === '/themes' || pathname.startsWith('/admin/collections/redirects') || pathname.startsWith('/admin/collections/site-settings')))
      || (item.href === '/integrations' && pathname === '/ai-jobs')
    const current = pathname === item.href || (item.href !== '/admin' && pathname.startsWith(`${item.href}/`)) || grouped
    return <a data-admin-nav-item key={item.href} href={item.href} aria-label={badge ? item.label : undefined} aria-description={badge ? `${badge} pending` : undefined} aria-current={current ? 'page' : undefined} onClick={() => setOpen(false)}><NavIcon label={item.label} /><span>{item.label}</span>{badge ? <span data-admin-nav-badge aria-hidden="true">{badge}</span> : null}</a>
  }

  return <>
    <button ref={button} className={styles.mobileMenu} data-testid="mobile-menu" type="button" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} aria-controls={id} onClick={() => setOpen((current) => !current)}>
      <span aria-hidden="true">{open ? '×' : '☰'}</span><span>{open ? 'Close' : 'Menu'}</span>
    </button>
    <div id={id} className={styles.navigationContents} data-admin-navigation hidden={!open}>
      <nav className={styles.adminLinks} data-admin-primary aria-label="Workspace">{primary.map(link)}</nav>
      {site.length ? <>
        <div className={styles.navDivider} data-admin-nav-separator aria-hidden="true" />
        <nav className={styles.adminLinks} data-admin-secondary aria-label="Site">{site.map(link)}</nav>
      </> : null}
      <details className={styles.adminAccount} data-admin-account aria-label="Account menu">
        <summary data-admin-account-button><span className={styles.accountInitials} data-admin-account-avatar aria-hidden="true">{displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'S'}</span><span><strong data-admin-account-name>{displayName}</strong><small data-admin-account-role>{roles.join(', ') || 'staff'}</small></span><svg className={styles.accountChevron} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></svg></summary>
        <div className={styles.accountMenu} role="menu">
          <div><strong>{email}</strong><small>{provider ? `Signed in with ${provider}` : 'Emergency access'}</small></div>
          <a role="menuitem" href="/account">Account and sessions</a>
          <a role="menuitem" href="/integrations?tab=assistants">My connected assistants</a>
          <button role="menuitem" type="button" disabled={signingOut} onClick={() => void signOut()}>Sign out</button>
          <button role="menuitem" type="button" disabled={signingOut} onClick={() => void signOut(true)}>Sign out everywhere</button>
        </div>
      </details>
    </div>
  </>
}
