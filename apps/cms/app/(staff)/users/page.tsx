import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '../../../payload.config'
import { hasRole } from '../../../src/access'
import { serverSessionStrategy } from '../../../src/identity'
import { StaffShell } from '../../components/staff-shell'
import { UsersWorkspace } from './users-workspace'
export default async function UsersPage() { const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: await headers(), payload }); if (!hasRole(auth.user as never, ['owner'])) redirect('/admin/login'); return <StaffShell><UsersWorkspace /></StaffShell> }
