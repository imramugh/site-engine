import { getPayload } from 'payload'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import config from '../../../../payload.config'
import { hasRole } from '../../../../src/access'
import { serverSessionStrategy } from '../../../../src/identity'
import { OnPageReview } from './review-mode'

export default async function ReviewPage({ params }: { params: Promise<{ changeSetID: string }> }) {
  const { changeSetID } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(changeSetID)) notFound()
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: await headers(), payload })
  if (!hasRole(authenticated.user as never, ['owner', 'approver'])) redirect('/admin/login')
  return <OnPageReview changeSetID={changeSetID} />
}
