import { loadAdminBranding } from '../../src/admin-branding'
import styles from './staff-shell.module.css'

export async function AdminTopbar({ user }: { user?: { name?: string | null; email?: string | null } | null }) {
  const branding = await loadAdminBranding()
  return <header className={styles.payloadTopbar} data-admin-header>
    <a href="/admin" className={styles.payloadBrand}>{branding.logoUrl ? <img src={branding.logoUrl} alt={branding.name} /> : branding.name}</a>
    <span>{user?.name || user?.email || 'Staff account'}</span>
    <a href="/">View site</a>
  </header>
}

export async function AdminBrandLogo() {
  const branding = await loadAdminBranding()
  return branding.logoUrl ? <img src={branding.logoUrl} alt={branding.name} /> : <span aria-label={branding.name}>{branding.initials}</span>
}
