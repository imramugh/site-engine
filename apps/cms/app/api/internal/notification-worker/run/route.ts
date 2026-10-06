import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { createNotificationWorkerRunHandler } from '../../../../../src/notification-worker'
import { runNotificationCycle } from '../../../../../src/notification-cycle'

export const dynamic = 'force-dynamic'
const handler = createNotificationWorkerRunHandler({ payload: () => getPayload({ config }), run: runNotificationCycle })
/** Internal-only: it accepts no recipient, content, provider, or result input. */
export async function POST(request: Request): Promise<Response> { return handler(request) }
