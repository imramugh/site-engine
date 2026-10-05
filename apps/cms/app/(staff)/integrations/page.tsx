import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { serverSessionStrategy } from '../../../src/identity'
import { StaffShell } from '../../components/staff-shell'
import { IntegrationConfiguration } from './integration-configuration'

export default async function IntegrationsPage() {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: await headers(), payload })
  if (!hasRole(authenticated.user as never, ['owner', 'editor', 'approver', 'sales', 'hiring'])) redirect('/admin/login')
  return <StaffShell><IntegrationConfiguration canManageAll={hasRole(authenticated.user as never, ['owner'])} /></StaffShell>
}
