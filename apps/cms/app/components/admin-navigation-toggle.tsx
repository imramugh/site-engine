'use client'

import type { AdminNavigationItem, AdminRole } from '../../src/admin-navigation'
import { useId, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import styles from './staff-shell.module.css'

type Props = { items: readonly AdminNavigationItem[]; collections: readonly AdminNavigationItem[]; displayName: string; roles: readonly AdminRole[] }

function NavIcon({ label }: { label: string }) {
  const paths: Record<string, string> = {
    Overview: 'M3 3h7v7H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 14h7v7H3z',
    'Content tree': 'M6 3v12m0 0-3-3m3 3 3-3M18 21V9m0 0-3 3m3-3 3 3M6 15h12',
    'Editorial review': 'M9 11 12 14 22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
    'Block gallery': 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    'Lead pipeline': 'M4 20V8h4V4h8v4h4v12M8 8h8M10 12h4M10 16h4',
    Applications: 'M4 20V8h4V4h8v4h4v12M8 8h8M10 12h4M10 16h4',
    Operations: 'M12 3v3m0 12v3m9-9h-3M6 12H3m15.4-6.4-2.1 2.1M7.7 16.3l-2.1 2.1m12.8 0-2.1-2.1M7.7 7.7 5.6 5.6M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    Themes: 'M12 3a9 9 0 1 0 9 9c0-1.1-.9-2-2-2h-1.5a1.5 1.5 0 0 0-1.5 1.5c0 .8-.7 1.5-1.5 1.5H12a3 3 0 0 1-3-3V7a4 4 0 0 1 3-4Z',
    Integrations: 'M8 12h8M8 8h8M8 16h8M4 4h16v16H4z',
    'AI jobs': 'm12 3-1.9 5.8H4l5 3.6-1.9 5.8 4.9-3.6 4.9 3.6-1.9-5.8 5-3.6h-6.1z',
  }
  return <svg className={styles.navIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[label] ?? paths.Overview} /></svg>
}

export function AdminNavigationToggle({ items, collections, displayName, roles }: Props) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const pathname = usePathname()
  const close = () => { setOpen(false); button.current?.focus() }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => { if (event.key === 'Escape' && open) { event.preventDefault(); close() } }
  const link = (item: AdminNavigationItem) => <a key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined} onClick={() => setOpen(false)}><NavIcon label={item.label} />{item.label}</a>
  return <>
    <button ref={button} className={styles.mobileMenu} data-testid="mobile-menu" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((current) => !current)}>
      {open ? 'Close navigation' : 'Open navigation'}
    </button>
    <div id={id} className={styles.navigationContents} hidden={!open} onKeyDown={onKeyDown}>
      <nav className={styles.adminLinks} aria-label="Workspace">{items.map(link)}</nav>
      {collections.length ? <details className={styles.collectionLinks}>
        <summary>CMS collections</summary>
        <nav className={styles.adminLinks} aria-label="CMS collections">{collections.map(link)}</nav>
      </details> : null}
      <footer className={styles.adminAccount} aria-label="Account menu">
        <span>{displayName}</span>
        <span className={styles.roleList}>{roles.join(', ') || 'staff'}</span>
        <a href="/admin/account">Account</a>
        <a href="/admin/logout">Log out</a>
      </footer>
    </div>
  </>
}
