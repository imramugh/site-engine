import type { Metadata } from 'next'
import { EnrollmentForm } from './enrollment-form'

export const metadata: Metadata = { title: 'Set up your authenticator | Site Engine' }

export default function EnrollmentPage() {
  return <main><EnrollmentForm /></main>
}
