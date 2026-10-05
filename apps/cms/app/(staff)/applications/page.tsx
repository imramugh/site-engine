import { StaffShell } from '../../components/staff-shell'
import { ApplicationDashboard } from './application-dashboard'
import { getPayload } from 'payload'
import { headers } from 'next/headers'
import config from '../../../payload.config'
import { serverSessionStrategy } from '../../../src/identity'

export default async function ApplicationsPage() { const payload=await getPayload({config}); const auth=await serverSessionStrategy.authenticate({headers:await headers(),payload}); return <StaffShell><ApplicationDashboard owner={Boolean((auth.user as {roles?:string[]}|null)?.roles?.includes('owner'))}/></StaffShell> }
