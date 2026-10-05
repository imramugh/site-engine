import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { hasRole } from '../../../../../src/access'
import { serverSessionStrategy } from '../../../../../src/identity'

export const dynamic = 'force-dynamic'

const css = `
html[data-direct-edit-mode="true"] [data-direct-edit-field] {
  cursor: text;
  outline: 2px dashed #007eaa;
  outline-offset: 4px;
}

html[data-direct-edit-mode="true"] [data-direct-edit-field]:focus {
  background: rgba(0, 126, 170, 0.16);
  outline-style: solid;
  outline-width: 3px;
}
`

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config })
  const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
  if (!hasRole(authenticated.user as never, ['owner', 'approver', 'editor'])) {
    return new Response('Not authorized.', { status: authenticated.user ? 403 : 401, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } })
  }
  return new Response(css, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/css; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } })
}
