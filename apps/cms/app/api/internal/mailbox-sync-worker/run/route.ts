import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { createMailboxSyncWorkerRunHandler, runMailboxSyncCycle } from '../../../../../src/mailbox-sync-worker'

export const dynamic = 'force-dynamic'
const handler = createMailboxSyncWorkerRunHandler({ payload: () => getPayload({ config }), run: runMailboxSyncCycle })
/** Private worker route: it accepts no mailbox, provider, cursor, or message input. */
export async function POST(request: Request): Promise<Response> { return handler(request) }
