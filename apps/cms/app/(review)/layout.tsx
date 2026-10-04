import type { Metadata } from 'next'
import type { CSSProperties, ReactNode } from 'react'
import { loadAdminBranding } from '../../src/admin-branding'

export const metadata: Metadata = { title: 'Page review', robots: { index: false, follow: false } }

export default async function ReviewLayout({ children }: { children: ReactNode }) {
  const branding = await loadAdminBranding()
  return <html lang="en">
    <head>{branding.stylesheetUrl && <link rel="stylesheet" href={branding.stylesheetUrl} />}</head>
    <body data-page-review-shell style={{ margin: 0, ...branding.tokens } as CSSProperties}>{children}</body>
  </html>
}
