import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { serverSessionStrategy } from '../../../src/identity'
import { DirectHeroEditor } from './direct-hero-editor'
import { StaffShell } from '../../components/staff-shell'

export default async function DirectEditPage() {
  const payload = await getPayload({ config }); const user = (await serverSessionStrategy.authenticate({ headers: await headers(), payload })).user
  if (!hasRole(user as never, ['owner', 'editor'])) redirect('/admin/login')
  return <StaffShell><DirectHeroEditor /></StaffShell>
}
