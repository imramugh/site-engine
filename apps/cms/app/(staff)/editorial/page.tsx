import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { serverSessionStrategy } from '../../../src/identity'
import { StaffShell } from '../../components/staff-shell'
import { EditorialWorkflow } from './workflow'

export default async function EditorialPage() {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: await headers(), payload })
  if (!hasRole(authenticated.user as never, ['owner', 'editor', 'approver'])) redirect('/admin/login')
  return <StaffShell><EditorialWorkflow /></StaffShell>
}
