import type { ReactNode } from 'react'
import { getPayload } from 'payload'
import { headers } from 'next/headers'
import config from '../../payload.config'
import { serverSessionStrategy } from '../../src/identity'
import { WorkspaceNavigation } from './admin-navigation'
import styles from './staff-shell.module.css'

export async function StaffShell({ children }: { children: ReactNode }) {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: await headers(), payload })
  return <div className={styles.workspace} data-admin-shell data-testid="admin-shell">
    <WorkspaceNavigation user={authenticated.user as { name?: string | null; email?: string | null; roles?: string[] | null } | null} />
    <div className={styles.adminWorkspace} data-admin-workspace id="admin-workspace">{children}</div>
  </div>
}
