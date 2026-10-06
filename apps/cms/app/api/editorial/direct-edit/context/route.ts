import { sqliteAuthenticationBoundary } from '../../../../../src/sqlite'
import { getPayload } from 'payload'
import config from '../../../../../payload.config'
import { hasRole } from '../../../../../src/access'
import { serverSessionStrategy } from '../../../../../src/identity'
import { isAuthenticationSQLiteContention } from '../../../../../src/sqlite'

export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'no-store' }

type Hero = { id: string; heading: string; body: string }

function heroes(blocks: unknown): Hero[] {
  if (!Array.isArray(blocks)) return []
  return blocks.flatMap((block) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'hero' && typeof (block as Record<string, unknown>).id === 'string' && typeof (block as Record<string, unknown>).heading === 'string' && typeof (block as Record<string, unknown>).body === 'string'
    ? [{ id: (block as Record<string, string>).id, heading: (block as Record<string, string>).heading, body: (block as Record<string, string>).body }]
    : [])
}

/** A minimal, role-filtered read model for the direct Hero editor. It never
 * returns arbitrary page blocks, credentials, or another editor's change set. */
async function GETHandler(request: Request): Promise<Response> {
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    const user = authenticated.user as { id?: string; roles?: string[] } | null
    if (!user?.id) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: noStore })
    if (!hasRole(user as never, ['owner', 'editor'])) return Response.json({ error: 'Editor access required.' }, { status: 403, headers: noStore })
    const [pages, sets] = await Promise.all([
      payload.find({ collection: 'pages', draft: true, depth: 0, limit: 50, user: user as never, overrideAccess: false }),
      payload.find({ collection: 'change-sets', where: { and: [{ actor: { equals: user.id } }, { state: { in: ['open', 'changes-requested'] } }] }, sort: '-updatedAt', limit: 50, depth: 0, user: user as never, overrideAccess: false }),
    ])
    return Response.json({
      pages: pages.docs.map((page) => ({ id: page.id, title: String(page.title), heroes: heroes(page.blocks) })).filter((page) => page.heroes.length),
      truncated: pages.totalDocs > pages.docs.length || sets.totalDocs > sets.docs.length,
      changeSets: sets.docs.map((set) => ({ id: set.id, name: String(set.name), state: String(set.state), revision: Number(set.revision ?? 0) })),
    }, { headers: noStore })
  } catch (error) {
    if (isAuthenticationSQLiteContention(error)) throw error
    return Response.json({ error: 'Unable to load editable draft content.' }, { status: 403, headers: noStore })
  }
}

export const GET = sqliteAuthenticationBoundary(GETHandler)
