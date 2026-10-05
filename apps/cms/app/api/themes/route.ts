import { getPayload } from 'payload'
import config from '../../../payload.config'
import { withPayloadTransaction } from '../../../src/auth-transaction'
import { createNamedChangeSet } from '../../../src/editorial'
import { serverSessionStrategy } from '../../../src/identity'
import { compatibilityReport, getInstalledTheme, installedThemes, loadThemeRegistry } from '@site-engine/engine/theme-registry'
import { SiteSnapshotSchema } from '@site-engine/contract'

export const dynamic = 'force-dynamic'

type ThemeSelection = { id: string; version: string; contract: string; manifestDigest: string }
type ThemeSettings = Record<string, Record<string, string | number | boolean>>
type Actor = { id: string; roles?: string[] }

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}

function isOwner(user: unknown): user is Actor {
  return Boolean(user && typeof user === 'object' && (user as { roles?: string[] }).roles?.includes('owner'))
}

function selectedBy(change: unknown, selection: ThemeSelection): boolean {
  if (!change || typeof change !== 'object') return false
  const value = change as { collection?: unknown; after?: { selection?: unknown } }
  const selected = selectionOf(value.after?.selection)
  return value.collection === 'theme-settings' && selected?.id === selection.id && selected.version === selection.version && selected.manifestDigest === selection.manifestDigest
}

async function ownedThemeDraft(payload: Awaited<ReturnType<typeof getPayload>>, actor: Actor, selection?: ThemeSelection) {
  const result = await payload.find({ collection: 'change-sets', where: { and: [{ actor: { equals: actor.id } }, { state: { in: ['open', 'changes-requested', 'submitted'] } }] }, sort: '-updatedAt', limit: 50, depth: 0, overrideAccess: true })
  const set = result.docs.find(item => Array.isArray(item.changes) && item.changes.length > 0 && item.changes.every(change => change && typeof change === 'object' && (change as { collection?: unknown }).collection === 'theme-settings') && (!selection || item.changes.some(change => selectedBy(change, selection))))
  if (!set) return null
  return {
    id: String(set.id), name: String(set.name), state: String(set.state),
    includedChangeKeys: (set.changes as Array<{ collection?: unknown; id?: unknown }>).filter(change => change.collection === 'theme-settings' && typeof change.id === 'string').map(change => `theme-settings:${change.id}`),
  }
}

function selectionOf(value: unknown): ThemeSelection | null {
  if (!value || typeof value !== 'object') return null
  const selection = value as Record<string, unknown>
  return typeof selection.id === 'string' && typeof selection.version === 'string' && typeof selection.contract === 'string' && typeof selection.manifestDigest === 'string'
    ? selection as ThemeSelection
    : null
}

function publicSelection(value: ThemeSelection | null) {
  return value && { id: value.id, version: value.version, contract: value.contract }
}

/** A selection is reviewed as a candidate snapshot. This is the sole path
 * that may advance a contract pin; ordinary editorial changes retain theirs. */
function selectionCandidate(manifest: unknown, selection: ThemeSelection) {
  const snapshot = SiteSnapshotSchema.parse(manifest)
  const hasHeroExtensions = snapshot.pages.some((page) => page.blocks.some((block) => block.type === 'hero' && (block.secondaryCta || block.supportPanel)))
  if (snapshot.settings.contractVersion === '1.1.0' && selection.contract === '1.0.0' && hasHeroExtensions) {
    throw new Error('This theme would downgrade a snapshot that uses Hero supporting content.')
  }
  return SiteSnapshotSchema.parse({ ...snapshot, settings: { ...snapshot.settings, contractVersion: selection.contract, theme: selection } })
}

function compatibilityFor(manifest: unknown, installed: { manifest: Parameters<typeof compatibilityReport>[1]; manifestDigest: string }) {
  const selection: ThemeSelection = { id: installed.manifest.name, version: installed.manifest.version, contract: installed.manifest.contract, manifestDigest: installed.manifestDigest }
  try { return compatibilityReport(selectionCandidate(manifest, selection), installed.manifest) }
  catch { return { compatible: false, actions: [{ action: 'contract-version', pageID: '', blockID: '', reason: 'theme-contract-transition-invalid' }] } }
}

async function currentState(payload: Awaited<ReturnType<typeof getPayload>>) {
  const [release, setting] = await Promise.all([
    payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true }),
    payload.find({ collection: 'theme-settings', where: { key: { equals: 'active' } }, limit: 1, depth: 0, draft: true, overrideAccess: true }),
  ])
  const snapshot = release.docs[0] && typeof release.docs[0].snapshot === 'object' ? release.docs[0].snapshot : undefined
  const manifest = snapshot && typeof snapshot.manifest === 'object' ? snapshot.manifest : undefined
  if (!manifest) throw new Error('No published release is available for theme compatibility checks.')
  const active = setting.docs[0] as { id: string; selection?: unknown; settings?: unknown } | undefined
  return {
    manifest,
    setting: active && { id: active.id, selection: selectionOf(active.selection), settings: active.settings && typeof active.settings === 'object' ? active.settings as ThemeSettings : {} },
  }
}

async function chooserData(payload: Awaited<ReturnType<typeof getPayload>>, actor: Actor) {
  const [registry, state] = await Promise.all([loadThemeRegistry(), currentState(payload)])
  const published = selectionOf((state.manifest as { settings?: { theme?: unknown } }).settings?.theme)
  const draft = state.setting?.selection ?? null
  return {
    themes: installedThemes(registry).map((installed) => ({
      id: installed.manifest.name,
      version: installed.manifest.version,
      contract: installed.manifest.contract,
      manifestDigest: installed.manifestDigest,
      standardBlocks: installed.manifest.standardBlocks,
      settingKeys: installed.manifest.settingKeys,
      compatibility: compatibilityFor(state.manifest, installed),
    })),
    publishedSelection: publicSelection(published),
    draftSelection: publicSelection(draft),
    draftChangeSet: draft ? await ownedThemeDraft(payload, actor, draft) : null,
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!isOwner(authenticated.user)) return Response.json({ error: 'Owner access required.' }, { status: 403 })
    return Response.json(await chooserData(payload, authenticated.user), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to load themes.' }, { status: 400 })
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!isOwner(authenticated.user)) return Response.json({ error: 'Owner access required.' }, { status: 403 })
    const body = await request.json() as { id?: unknown; version?: unknown; changeSetName?: unknown }
    if (typeof body.id !== 'string' || typeof body.version !== 'string' || typeof body.changeSetName !== 'string') throw new Error('Choose an installed theme and provide a change set name.')
    const name = body.changeSetName.trim()
    if (!name || name.length > 120) throw new Error('A change set name must contain 1 to 120 characters.')
    const registry = await loadThemeRegistry()
    const installed = getInstalledTheme(registry, body.id, body.version)
    if (!installed) throw new Error('Choose a currently installed theme version.')
    const state = await currentState(payload)
    const selection: ThemeSelection = {
      id: installed.manifest.name,
      version: installed.manifest.version,
      contract: installed.manifest.contract,
      manifestDigest: installed.manifestDigest,
    }
    const candidate = selectionCandidate(state.manifest, selection)
    const compatibility = compatibilityReport(candidate, installed.manifest)
    if (!compatibility.compatible) throw new Error('This theme cannot render the current published content.')
    const existing = await ownedThemeDraft(payload, authenticated.user, selection)
    if (existing) return Response.json({ changeSet: existing, selection: publicSelection(selection), compatibility, reused: true }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
    const reusable = await ownedThemeDraft(payload, authenticated.user)
    if (state.setting?.selection && (!reusable || !['open', 'changes-requested'].includes(reusable.state))) throw new Error('Another reviewed draft controls the pending theme selection. Resolve or discard it before creating a different theme preview.')

    const result = await withPayloadTransaction(payload, async (req) => {
      req.user = authenticated.user
      req.headers = new Headers(request.headers)
      const changeSet = reusable
        ? await payload.findByID({ collection: 'change-sets', id: reusable.id, depth: 0, overrideAccess: true, req })
        : await createNamedChangeSet(payload, req, authenticated.user as never, name)
      req.headers.set('x-site-engine-change-set', String(changeSet.id))
      req.context = { ...req.context, editorialInternal: false }
      const settings = { ...(state.setting?.settings ?? {}), [selection.id]: state.setting?.settings?.[selection.id] ?? {} }
      const doc = state.setting
        ? await payload.update({ collection: 'theme-settings', id: state.setting.id, data: { selection, settings }, draft: true, overrideAccess: false, req })
        : await payload.create({ collection: 'theme-settings', data: { selection, settings }, draft: true, overrideAccess: false, req })
      return { changeSet, doc }
    })
    return Response.json({ changeSet: { id: result.changeSet.id, name: result.changeSet.name, state: result.changeSet.state, includedChangeKeys: [`theme-settings:${result.doc.id}`] }, selection: publicSelection(selection), compatibility, reused: Boolean(reusable) }, { status: reusable ? 200 : 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to draft a theme selection.' }, { status: 400 })
  }
}
