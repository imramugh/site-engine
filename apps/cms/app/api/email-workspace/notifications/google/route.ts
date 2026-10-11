import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { receiveGoogleNotification } from '../../../../../src/mailbox-notifications'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) { return receiveGoogleNotification(await getPayload({ config }), request) }
