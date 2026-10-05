import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { serverSessionStrategy } from '../../../src/identity'
import { StaffShell } from '../../components/staff-shell'
import { SiteWorkspace } from './site-workspace'

export default async function SitePage() {
  const payload = await getPayload({ config })
  const user = (await serverSessionStrategy.authenticate({ headers: await headers(), payload })).user
  if (!hasRole(user as never, ['owner'])) redirect('/admin/login')
  return <StaffShell><SiteWorkspace /></StaffShell>
}
