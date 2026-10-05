import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { serverSessionStrategy } from '../../../../src/identity'
import { pageCreationContext } from '../../../../src/page-creator'
import { StaffShell } from '../../../components/staff-shell'
import { NewPage } from './new-page'

export default async function NewPageRoute({ searchParams }: { searchParams: Promise<{ section?: string; template?: string }> }) {
  const payload = await getPayload({ config })
  const user = (await serverSessionStrategy.authenticate({ headers: await headers(), payload })).user
  if (!hasRole(user as never, ['owner', 'editor'])) redirect('/admin/login')
  const context = await pageCreationContext(payload, user as never)
  const requested = await searchParams
  return <StaffShell><NewPage context={context} initial={{ section: requested.section, template: requested.template }} /></StaffShell>
}
