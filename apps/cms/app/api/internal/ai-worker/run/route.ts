import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { createAIWorkerRunHandler } from '../../../../../src/ai-worker'
import { claimAndExecuteConfiguredAIJob } from '../../../../../src/configured-ai-job-execution'

export const dynamic = 'force-dynamic'

const handler = createAIWorkerRunHandler({ payload: () => getPayload({ config }), run: payload => claimAndExecuteConfiguredAIJob(payload, { transport: fetch }) })

/** Internal-only worker entry point. It accepts no job, provider, prompt, or result payload. */
export async function POST(request: Request): Promise<Response> { return handler(request) }
