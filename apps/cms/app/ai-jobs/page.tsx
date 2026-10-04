import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '../../payload.config'
import { hasRole } from '../../src/access'
import { serverSessionStrategy } from '../../src/identity'
import { StaffShell } from '../components/staff-shell'
import { AIJobConsole } from './ai-job-console'

export default async function AIJobsPage() {
  const payload = await getPayload({ config }); const authenticated = await serverSessionStrategy.authenticate({ headers: await headers(), payload })
  if (!hasRole(authenticated.user as never, ['owner'])) redirect('/admin/login')
  return <StaffShell><AIJobConsole /></StaffShell>
}
