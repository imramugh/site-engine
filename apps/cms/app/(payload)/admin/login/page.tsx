import type { CSSProperties } from 'react'
import { loadAdminBranding } from '../../../../src/admin-branding'
import { EmergencyOwnerForm } from './emergency-owner-form'
import styles from './login.module.css'

export default async function LoginPage() {
  const branding = await loadAdminBranding()
  const brandName = branding.name
  return <main className={styles.shell} data-admin-login style={branding.tokens as CSSProperties}>
    {branding.stylesheetUrl ? <link rel="stylesheet" href={branding.stylesheetUrl} /> : null}
    <section className={styles.card} data-login-card aria-labelledby="admin-login-heading">
      <header className={styles.brand} data-login-brand>
        {branding.logoUrl ? <img src={branding.logoUrl} alt={brandName} /> : <strong aria-label={brandName}>{branding.initials}</strong>}
      </header>
      <div className={styles.content}>
        <p className={styles.eyebrow}>Staff workspace</p>
        <h1 id="admin-login-heading">Staff sign in</h1>
        <p className={styles.intro}>Use your work email to access your workspace.</p>
        <EmergencyOwnerForm />
      </div>
    </section>
  </main>
}
