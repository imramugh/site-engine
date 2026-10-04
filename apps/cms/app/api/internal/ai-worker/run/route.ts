import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { aiWorkerAuthorized, aiWorkerResponse } from '../../../../../src/ai-worker'
import { claimAndExecuteConfiguredAIJob } from '../../../../../src/configured-ai-job-execution'

export const dynamic = 'force-dynamic'

type Dependencies = { payload: () => Promise<any>; run: (payload: any) => Promise<unknown> }
export function createAIWorkerRunHandler(dependencies: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (!aiWorkerAuthorized(request)) return Response.json({ error: 'Unauthorized.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
    try { return aiWorkerResponse(await dependencies.run(await dependencies.payload())) }
    catch { return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
  }
}

const handler = createAIWorkerRunHandler({ payload: () => getPayload({ config }), run: payload => claimAndExecuteConfiguredAIJob(payload, { transport: fetch }) })

/** Internal-only worker entry point. It accepts no job, provider, prompt, or result payload. */
export async function POST(request: Request): Promise<Response> { return handler(request) }
