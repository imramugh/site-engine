import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { receiveMicrosoftNotification } from '../../../../../src/mailbox-notifications'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) { return receiveMicrosoftNotification(await getPayload({ config }), request) }
