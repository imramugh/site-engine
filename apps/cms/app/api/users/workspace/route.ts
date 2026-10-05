import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { freshStaff, hasRole, roles, type Role } from '../../../../src/access'
import { serverSessionStrategy, type IdentityProvider } from '../../../../src/identity'
import { configuredProvider } from '../../../../src/oidc'
import { createUserInvitation, loadUsersWorkspace, updateManagedUser, UserManagementError } from '../../../../src/user-management'

export const dynamic = 'force-dynamic'
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const sameOrigin = (request: Request) => { const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL; const origin = request.headers.get('origin'); return Boolean(configured && origin && origin === new URL(configured).origin) }
async function body(request: Request) { const text = await request.text(); if (Buffer.byteLength(text) > 8192) throw new Error('large'); const value: unknown = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body'); return value as Record<string, unknown> }
const validRoles = (value: unknown): value is Role[] => Array.isArray(value) && value.length > 0 && value.every((role) => roles.includes(role as Role)) && new Set(value).size === value.length
async function context(request: Request) { const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); return { payload, user: auth.user as { id: string; roles?: string[] } | null } }

export async function GET(request: Request) {
  const { payload, user } = await context(request)
  if (!hasRole(user as never, ['owner'])) return json({ error: 'Owner access required.' }, 403)
  return json({ ...(await loadUsersWorkspace(payload)), providers: { google: Boolean(configuredProvider('google')), microsoft: Boolean(configuredProvider('microsoft')) } })
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'CSRF origin check failed.' }, 403)
  try {
    const { payload, user } = await context(request)
    if (!user || !(await freshStaff(['owner'])({ req: { payload, user, headers: request.headers } as never }))) return json({ error: 'Fresh Owner authentication is required.' }, 403)
    const input = await body(request)
    if (input.action === 'invite' && typeof input.email === 'string' && (input.provider === 'google' || input.provider === 'microsoft') && validRoles(input.roles)) return json(await createUserInvitation(payload, user, { email: input.email, provider: input.provider as IdentityProvider, roles: input.roles }), 201)
    if (input.action === 'update' && typeof input.id === 'string' && typeof input.name === 'string' && typeof input.disabled === 'boolean' && validRoles(input.roles)) {
      const updated = await updateManagedUser(payload, user, { id: input.id, name: input.name, roles: input.roles, disabled: input.disabled })
      return json({ user: { id: updated.id, name: updated.name, email: updated.email, roles: updated.roles, provider: updated.provider ?? null, disabled: Boolean(updated.disabled) } })
    }
    return json({ error: 'Check the submitted user details.' }, 400)
  } catch (error) {
    if (error instanceof UserManagementError) return json({ error: error.message }, error.code === 'not-found' ? 404 : error.code === 'conflict' ? 409 : 400)
    return json({ error: 'The user request could not be completed.' }, 400)
  }
}
