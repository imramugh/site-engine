import { StaffShell } from '../../components/staff-shell'
import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { serverSessionStrategy } from '../../../src/identity'
import { LeadDashboard } from './lead-dashboard'

export default async function LeadsPage() {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: await headers(), payload })
  if (!hasRole(authenticated.user as never, ['owner', 'sales'])) redirect('/admin/login')
  return <StaffShell><LeadDashboard owner={hasRole(authenticated.user as never, ['owner'])} /></StaffShell>
}
