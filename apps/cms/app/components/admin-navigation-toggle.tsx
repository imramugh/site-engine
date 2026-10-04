'use client'

import type { AdminNavigationItem, AdminRole } from '../../src/admin-navigation'
import { useId, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import styles from './staff-shell.module.css'

type Props = { items: readonly AdminNavigationItem[]; collections: readonly AdminNavigationItem[]; displayName: string; roles: readonly AdminRole[] }

function NavIcon({ label }: { label: string }) {
  const path = label === 'Overview' ? 'M3 10.5 12 3l9 7.5v8.25a.75.75 0 0 1-.75.75H15v-6H9v6H3.75a.75.75 0 0 1-.75-.75z' : label === 'Lead pipeline' || label === 'Applications' ? 'M4 20V8h4V4h8v4h4v12zm4-12h8V6H8zm-2 10h12v-8H6z' : 'M4 4h16v4H4zm0 6h16v4H4zm0 6h10v4H4z'
  return <svg className={styles.navIcon} viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>
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
