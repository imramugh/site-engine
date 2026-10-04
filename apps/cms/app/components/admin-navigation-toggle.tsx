'use client'

import type { AdminNavigationItem, AdminRole } from '../../src/admin-navigation'
import { useEffect, useId, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import styles from './staff-shell.module.css'

type Props = {
  primary: readonly AdminNavigationItem[]
  site: readonly AdminNavigationItem[]
  tools: readonly AdminNavigationItem[]
  collections: readonly AdminNavigationItem[]
  displayName: string
  roles: readonly AdminRole[]
}

const titleForPath = (pathname: string) => {
  const titles: Record<string, string> = {
    '/admin': 'Dashboard', '/content-tree': 'Content', '/block-gallery': 'Block gallery', '/leads': 'Leads',
    '/applications': 'Careers', '/editorial': 'Reviews', '/operations': 'Changelog', '/integrations': 'Integrations',
    '/themes': 'Themes', '/ai-jobs': 'AI jobs', '/direct-edit': 'Hero draft editor',
  }
  const collectionTitles: Record<string, string> = { assets: 'Media', users: 'Users', pages: 'Pages', sections: 'Sections', redirects: 'Redirects', 'audit-events': 'Audit events' }
  const collection = pathname.match(/^\/admin\/collections\/([^/]+)/)?.[1]
  if (collection && collectionTitles[collection]) return collectionTitles[collection]
  return titles[pathname] ?? 'Workspace'
}

function NavIcon({ label }: { label: string }) {
  const paths: Record<string, string> = {
    Dashboard: 'M4 4h6v6H4zM14 4h6v4h-6zM14 12h6v8h-6zM4 14h6v6H4z',
    Content: 'M5 3h10l4 4v14H5zM15 3v5h5M8 12h8M8 16h8',
    'Block gallery': 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    Media: 'M4 5h16v14H4zM7 15l3-3 3 3 2-2 3 3M8 9h.01',
    Leads: 'M4 20V8h4V4h8v4h4v12M8 8h8M10 12h4M10 16h4',
    Careers: 'M4 8h16v12H4zM9 8V5h6v3M4 12h16',
    Reviews: 'M5 4h14v16H5zM8 12l2 2 5-5',
    'Changelog': 'M12 8v4l3 2M5 4h14v16H5zM8 2v4M16 2v4',
    Integrations: 'M8 12h8M8 8h8M8 16h8M4 4h16v16H4z',
    Users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    'Hero draft editor': 'M4 20h16M6 16l9-9 3 3-9 9-4 1z', Themes: 'M12 3a9 9 0 1 0 9 9c0-1.1-.9-2-2-2h-1.5a1.5 1.5 0 0 0-1.5 1.5c0 .8-.7 1.5-1.5 1.5H12a3 3 0 0 1-3-3V7a4 4 0 0 1 3-4Z',
    'AI jobs': 'm12 3-1.9 5.8H4l5 3.6-1.9 5.8 4.9-3.6 4.9 3.6-1.9-5.8 5-3.6h-6.1z',
  }
  return <svg className={styles.navIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[label] ?? paths.Dashboard} /></svg>
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

export function AdminWorkspaceHeader() {
  const pathname = usePathname()
  return <header className={styles.header} data-admin-header><p data-admin-page-title>{titleForPath(pathname)}</p><a href="/" data-admin-view-site>View site <span aria-hidden="true">↗</span></a></header>
}

export function AdminNavigationToggle({ primary, site, tools, collections, displayName, roles }: Props) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const pathname = usePathname()
  const close = () => { setOpen(false); button.current?.focus() }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && open) close() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [open])
  const link = (item: AdminNavigationItem) => <a data-admin-nav-item key={item.href} href={item.href} aria-current={pathname === item.href || (item.href !== '/admin' && pathname.startsWith(`${item.href}/`)) ? 'page' : undefined} onClick={() => setOpen(false)}><NavIcon label={item.label} /><span>{item.label}</span></a>

  return <>
    <button ref={button} className={styles.mobileMenu} data-testid="mobile-menu" type="button" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} aria-controls={id} onClick={() => setOpen((current) => !current)}>
      <span aria-hidden="true">{open ? '×' : '☰'}</span><span>{open ? 'Close' : 'Menu'}</span>
    </button>
    <div id={id} className={styles.navigationContents} data-admin-navigation hidden={!open}>
      <nav className={styles.adminLinks} data-admin-primary aria-label="Workspace">{primary.map(link)}</nav>
      {site.length ? <>
        <div className={styles.navDivider} data-admin-nav-separator aria-hidden="true" />
        <nav className={styles.adminLinks} data-admin-secondary aria-label="Site"><p className={styles.navHeading} data-admin-nav-group="site">Site</p>{site.map(link)}</nav>
      </> : null}
      {(tools.length || collections.length) ? <details className={styles.collectionLinks}>
        <summary>More tools</summary>
        <nav className={styles.adminLinks} aria-label="More tools">{tools.map(link)}{collections.map(link)}</nav>
      </details> : null}
      <details className={styles.adminAccount} data-admin-account aria-label="Account menu">
        <summary data-admin-account-button><span className={styles.accountInitials} data-admin-account-avatar aria-hidden="true">{displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'S'}</span><span><strong data-admin-account-name>{displayName}</strong><small data-admin-account-role>{roles.join(', ') || 'staff'}</small></span><span className={styles.accountChevron} aria-hidden="true">⌄</span></summary>
        <div className={styles.accountMenu} role="menu">
          <a role="menuitem" href="/admin/account">Account</a>
          <a role="menuitem" href="/admin/logout">Log out</a>
        </div>
      </details>
    </div>
  </>
}
