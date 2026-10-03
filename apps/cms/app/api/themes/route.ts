import { getPayload } from 'payload'
import config from '../../../payload.config'
import { withPayloadTransaction } from '../../../src/auth-transaction'
import { createNamedChangeSet } from '../../../src/editorial'
import { serverSessionStrategy } from '../../../src/identity'
import { compatibilityReport, loadThemeRegistry } from '@site-engine/engine/theme-registry'

export const dynamic = 'force-dynamic'

type ThemeSelection = { id: string; version: string; contract: string; manifestDigest: string }
type ThemeSettings = Record<string, Record<string, string | number | boolean>>

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}

function isOwner(user: unknown): user is { id: string; roles?: string[] } {
  return Boolean(user && typeof user === 'object' && (user as { roles?: string[] }).roles?.includes('owner'))
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

async function chooserData(payload: Awaited<ReturnType<typeof getPayload>>) {
  const [registry, state] = await Promise.all([loadThemeRegistry(), currentState(payload)])
  const published = selectionOf((state.manifest as { settings?: { theme?: unknown } }).settings?.theme)
  return {
    themes: [...registry.values()].map((installed) => ({
      id: installed.manifest.name,
      version: installed.manifest.version,
      contract: installed.manifest.contract,
      standardBlocks: installed.manifest.standardBlocks,
      settingKeys: installed.manifest.settingKeys,
      compatibility: compatibilityReport(state.manifest, installed.manifest),
    })),
    publishedSelection: publicSelection(published),
    draftSelection: publicSelection(state.setting?.selection ?? null),
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const payload = await getPayload({ config })
    const authenticated = await serverSessionStrategy.authenticate({ headers: request.headers, payload })
    if (!isOwner(authenticated.user)) return Response.json({ error: 'Owner access required.' }, { status: 403 })
    return Response.json(await chooserData(payload), { headers: { 'Cache-Control': 'no-store' } })
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
    const installed = registry.get(body.id)
    if (!installed || installed.manifest.version !== body.version) throw new Error('Choose a currently installed theme version.')
    const state = await currentState(payload)
    const compatibility = compatibilityReport(state.manifest, installed.manifest)
    if (!compatibility.compatible) throw new Error('This theme cannot render the current published content.')
    const selection: ThemeSelection = {
      id: installed.manifest.name,
      version: installed.manifest.version,
      contract: installed.manifest.contract,
      manifestDigest: installed.manifestDigest,
    }
    if (state.setting?.selection?.id === selection.id && state.setting.selection.version === selection.version && state.setting.selection.manifestDigest === selection.manifestDigest) throw new Error('This theme version is already the pending selection.')

    const result = await withPayloadTransaction(payload, async (req) => {
      req.user = authenticated.user
      req.headers = new Headers(request.headers)
      const changeSet = await createNamedChangeSet(payload, req, authenticated.user as never, name)
      req.headers.set('x-site-engine-change-set', String(changeSet.id))
      req.context = { ...req.context, editorialInternal: false }
      const settings = { ...(state.setting?.settings ?? {}), [selection.id]: state.setting?.settings?.[selection.id] ?? {} }
      const doc = state.setting
        ? await payload.update({ collection: 'theme-settings', id: state.setting.id, data: { selection, settings }, draft: true, overrideAccess: false, req })
        : await payload.create({ collection: 'theme-settings', data: { selection, settings }, draft: true, overrideAccess: false, req })
      return { changeSet, doc }
    })
    return Response.json({ changeSet: { id: result.changeSet.id, name: result.changeSet.name }, selection: publicSelection(selection), compatibility }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to draft a theme selection.' }, { status: 400 })
  }
}
