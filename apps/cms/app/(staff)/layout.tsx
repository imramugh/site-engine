import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'Site workspace',
  description: 'Staff workspace for site content and operations.',
}

export default function StaffLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>
}
