import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type GalleryLibrary = {
  url: string
  fixtureHash: string
  manifestDigest: string
  source: { themePackage: string; rendererCommit: string; contractVersion: string }
  capabilities: string[]
}

export type AdminBranding = {
  name: string
  initials: string
  logoUrl?: string
  tokens: Record<string, string>
  stylesheetUrl?: string
  blockGalleryPreviews?: Record<string, Record<string, string>>
  blockGalleryLibraries?: Record<string, GalleryLibrary>
}

const defaultBranding: AdminBranding = {
  name: 'Site workspace',
  initials: 'SW',
  tokens: {},
}

const tokenNames = new Set(['--admin-accent', '--admin-accent-contrast', '--admin-surface', '--admin-sidebar', '--admin-text', '--admin-border'])
const color = /^(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?|(?:rgb|hsl)a?\([\d.%\s,/+-]{1,64}\))$/

/**
 * The manifest is deliberately outside `public`: private build tooling copies it
 * into this traced directory. The stylesheet and logo remain public assets.
 */
export function brandingDirectory(root = process.env.ADMIN_BRANDING_DIR ?? resolve(process.cwd(), 'admin-branding')): string {
  return resolve(root)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maximum ? value.trim() : undefined
}

function sameOriginAsset(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/admin-branding/') || value.includes('..') || /[?#]/.test(value)) return undefined
  return value
}

export function parseGalleryLibraries(value: unknown): Record<string, GalleryLibrary> {
  const result: Record<string, GalleryLibrary> = {}
  if (!isRecord(value)) return result
  for (const [identity, raw] of Object.entries(value)) {
    if (!/^[a-z0-9-]{1,80}@\d+\.\d+\.\d+$/.test(identity) || !isRecord(raw) || !isRecord(raw.source)) continue
    const url = sameOriginAsset(raw.url)
    if (!url || !/^\/admin-branding\/[A-Za-z0-9@._/-]+\.html$/.test(url) || !/^[a-f0-9]{64}$/.test(String(raw.fixtureHash)) || !/^[a-f0-9]{64}$/.test(String(raw.manifestDigest))) continue
    const { themePackage, rendererCommit, contractVersion } = raw.source
    if (typeof themePackage !== 'string' || !/^[A-Za-z0-9@/._-]{1,160}$/.test(themePackage) || typeof rendererCommit !== 'string' || !/^[a-f0-9]{7,64}$/.test(rendererCommit) || typeof contractVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(contractVersion)) continue
    const allowed = ['templates', 'presets', 'variants', 'extensions', 'viewport', 'background', 'motion']
    const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.filter((item): item is string => typeof item === 'string' && allowed.includes(item)) : []
    result[identity] = { url, fixtureHash: raw.fixtureHash as string, manifestDigest: raw.manifestDigest as string, source: { themePackage, rendererCommit, contractVersion }, capabilities }
  }
  return result
}

export function exactGalleryLibrary(libraries: AdminBranding['blockGalleryLibraries'], theme: { name: string; version: string; contract: string; manifestDigest: string } | undefined): GalleryLibrary | undefined {
  if (!theme) return undefined
  const library = libraries?.[`${theme.name}@${theme.version}`]
  return library?.manifestDigest === theme.manifestDigest && library.source.contractVersion === theme.contract ? library : undefined
}

export function parseAdminBranding(value: unknown): AdminBranding {
  if (!isRecord(value)) return defaultBranding
  const name = text(value.name, 80)
  const initials = text(value.initials, 4)
  if (!name || !initials) return defaultBranding
  const tokens: Record<string, string> = {}
  if (isRecord(value.tokens)) for (const [key, token] of Object.entries(value.tokens)) {
    if (tokenNames.has(key) && typeof token === 'string' && color.test(token)) tokens[key] = token
  }
  const blockGalleryPreviews: Record<string, Record<string, string>> = {}
  if (isRecord(value.blockGalleryPreviews)) for (const [theme, previews] of Object.entries(value.blockGalleryPreviews)) {
    if (!/^[a-z0-9-]{1,80}@[0-9]+\.[0-9]+\.[0-9]+$/i.test(theme) || !isRecord(previews)) continue
    const safe: Record<string, string> = {}
    for (const [block, url] of Object.entries(previews)) {
      const asset = sameOriginAsset(url)
      if (/^[a-z][a-zA-Z0-9]{0,40}$/.test(block) && asset) safe[block] = asset
    }
    if (Object.keys(safe).length) blockGalleryPreviews[theme] = safe
  }
  const blockGalleryLibraries = parseGalleryLibraries(value.blockGalleryLibraries)
  return { name, initials, logoUrl: sameOriginAsset(value.logoUrl), tokens, stylesheetUrl: '/admin-branding/admin-branding.css', ...(Object.keys(blockGalleryPreviews).length ? { blockGalleryPreviews } : {}), ...(Object.keys(blockGalleryLibraries).length ? { blockGalleryLibraries } : {}) }
}

/** Reads only an optional public build artifact. Invalid or absent files are neutral. */
export async function loadAdminBranding(directory = brandingDirectory()): Promise<AdminBranding> {
  let branding = defaultBranding
  try {
    branding = parseAdminBranding(JSON.parse(await readFile(join(directory, 'branding.json'), 'utf8')))
  } catch { /* An unbranded engine uses the neutral renderer library. */ }
  try {
    const neutral = JSON.parse(await readFile(resolve(process.cwd(), 'public/admin-branding/gallery-libraries.json'), 'utf8'))
    const libraries = { ...parseGalleryLibraries(neutral.blockGalleryLibraries), ...branding.blockGalleryLibraries }
    if (Object.keys(libraries).length) branding = { ...branding, blockGalleryLibraries: libraries }
  } catch { /* Missing build artifacts are represented honestly by the gallery. */ }
  return branding
}
