'use client'

import type { AdminNavigationItem, AdminRole } from '../../src/admin-navigation'
import type { ReactNode } from 'react'
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
    '/applications': 'Careers', '/editorial': 'Reviews', '/operations': 'Change log', '/integrations': 'Integrations',
    '/themes': 'Themes', '/ai-jobs': 'AI jobs', '/direct-edit': 'Hero draft editor',
  }
  const collectionTitles: Record<string, string> = { assets: 'Media', users: 'Users', pages: 'Pages', sections: 'Sections', redirects: 'Redirects', 'audit-events': 'Audit events', 'site-settings': 'Site' }
  const collection = pathname.match(/^\/admin\/collections\/([^/]+)/)?.[1]
  if (collection && collectionTitles[collection]) return collectionTitles[collection]
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

export function AdminWorkspaceHeader() {
  const pathname = usePathname()
  return <header className={styles.header} data-admin-header>{pathname === '/admin' ? <h1 data-admin-page-title>{titleForPath(pathname)}</h1> : <p data-admin-page-title>{titleForPath(pathname)}</p>}<a href="/" data-admin-view-site>View site <span aria-hidden="true">↗</span></a></header>
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
        <nav className={styles.adminLinks} data-admin-secondary aria-label="Site">{site.map(link)}</nav>
      </> : null}
      {(tools.length || collections.length) ? <details className={styles.collectionLinks}>
        <summary>More tools</summary>
        <nav className={styles.adminLinks} aria-label="More tools">{tools.map(link)}{collections.map(link)}</nav>
      </details> : null}
      <details className={styles.adminAccount} data-admin-account aria-label="Account menu">
        <summary data-admin-account-button><span className={styles.accountInitials} data-admin-account-avatar aria-hidden="true">{displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'S'}</span><span><strong data-admin-account-name>{displayName}</strong><small data-admin-account-role>{roles.join(', ') || 'staff'}</small></span><svg className={styles.accountChevron} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></svg></summary>
        <div className={styles.accountMenu} role="menu">
          <a role="menuitem" href="/admin/account">Account</a>
          <a role="menuitem" href="/admin/logout">Log out</a>
        </div>
      </details>
    </div>
  </>
}
