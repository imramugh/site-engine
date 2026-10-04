import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { serverSessionStrategy } from '../../../../src/identity'
import { StaffShell } from '../../../components/staff-shell'
import { PageEditor } from './page-editor'

export default async function ContentEditorPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const payload = await getPayload({ config })
  const user = (
    await serverSessionStrategy.authenticate({
      headers: await headers(),
      payload,
    })
  ).user
  if (!hasRole(user as never, ['owner', 'approver', 'editor']))
    redirect('/admin/login')
  const { id } = await params
  return (
    <StaffShell>
      <PageEditor pageID={id} />
    </StaffShell>
  )
}
