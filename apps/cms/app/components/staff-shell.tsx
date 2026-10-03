import type { ReactNode } from 'react'
import styles from './staff-shell.module.css'

export function StaffShell({ children }: { children: ReactNode }) {
  return <div className={styles.workspace}>
    <header className={styles.header}>
      <span>Site workspace</span>
      <a href="/admin">Back to administration</a>
    </header>
    {children}
  </div>
}
