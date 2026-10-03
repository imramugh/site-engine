import { configuredProvider } from '../../../../src/oidc'
import { EmergencyOwnerForm } from './emergency-owner-form'

export default function LoginPage() {
  const google = configuredProvider('google')
  const microsoft = configuredProvider('microsoft')
  return <main><h1>Staff sign in</h1><p>Only invited, verified provider identities may sign in.</p>{google ? <a href="/api/auth/google" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Continue with Google</a> : <p>Google sign-in is not configured.</p>}{microsoft ? <a href="/api/auth/microsoft" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Continue with Microsoft</a> : <p>Microsoft sign-in is not configured.</p>}<EmergencyOwnerForm /></main>
}
