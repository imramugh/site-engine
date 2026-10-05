import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'
import config from '../../../payload.config'
import { serverSessionStrategy } from '../../../src/identity'
import { StaffShell } from '../../components/staff-shell'
import { AccountWorkspace } from './account-workspace'
export default async function AccountPage() { const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: await headers(), payload }); if (!auth.user) redirect('/admin/login'); return <StaffShell><AccountWorkspace /></StaffShell> }
