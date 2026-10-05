import { createServer as createHTTPServer, request as requestUpstream, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { getPayload } from 'payload'
import sharp from 'sharp'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { hashOpaqueToken } from '../src/identity.js'
import { withPayloadTransaction } from '../src/auth-transaction.js'
import { claimPreviewRenderJob, completePreviewRenderJob } from '../src/review-preview.js'
import { canonicalHash } from '../src/publishing.js'
import { deriveRoutes } from '@site-engine/engine'
import { runPreviewOnce } from '../../site/scripts/run-preview-worker.mjs'
import { encryptSecret, recoveryHash } from '../src/totp.js'
import { mintResumeLink } from '../src/resume-links.js'
import { createRequire } from 'node:module'

const e2ePort = Number(process.env.CMS_E2E_PORT ?? 4300)
const axeSourcePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
const cmsOrigin = `https://127.0.0.1:${e2ePort}`
const issuerOrigin = `https://127.0.0.1:${e2ePort + 1}`
const clientID = 'synthetic-browser-client'
const clientSecret = 'synthetic-browser-secret'
const inviteToken = 'synthetic-browser-owner-invite'
const encryptedFixture = 'synthetic-encrypted-secret-sentinel'
const recoveryFixture = 'synthetic-recovery-hash-sentinel'
const emergencyEmail = 'emergency-owner.synthetic@example.test'
const emergencyRecoveryCode = 'synthetic-recovery-code-01'
const localOwnerRecoveryCode = 'synthetic-local-recovery-code-02'
const localOwnerDisableRecoveryCode = 'synthetic-local-recovery-code-03'
const reviewOwnerEmail = 'review-owner.synthetic@example.test'
const reviewOwnerRecoveryCode = 'synthetic-review-owner-code-04'
const leadOwnerEmail = 'lead-owner.synthetic@example.test'
const leadOwnerRecoveryCode = 'synthetic-lead-owner-code-07'
const leadSessionTokens = { owner: 'synthetic-lead-owner-session-token', editor: 'synthetic-lead-editor-session-token' } as const
const scheduleOwnerEmail = 'schedule-owner.synthetic@example.test'
const scheduleOwnerRecoveryCode = 'synthetic-schedule-owner-code-09'
const themeOwnerEmail = 'theme-owner.synthetic@example.test'
const themeOwnerRecoveryCode = 'synthetic-theme-owner-code-08'
const themeOwnerSessionToken = 'synthetic-theme-owner-session-token'
const mediaOwnerSessionToken = 'synthetic-media-owner-session-token'
const applicationJobID = '66666666-6666-4666-8666-666666666666'
const applicationSectionID = '77777777-7777-4777-8777-777777777777'
const applicationChangeSetID = '88888888-8888-4888-8888-888888888888'
const draftApplicationJobID = '99999999-9999-4999-8999-999999999999'
const expiredApplicationJobID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const directEditPageID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const directEditBlockID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const directEditSetID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const onPageReviewPageID = '12345678-1234-4234-8234-1234567890ab'
const onPageReviewBlockID = '12345678-1234-4234-8234-1234567890ac'
const onPageReviewSetID = '12345678-1234-4234-8234-1234567890ad'
const secondOnPageReviewSetID = '12345678-1234-4234-8234-1234567890ae'
const onPageEditorSessionToken = 'synthetic-on-page-editor-session-token'
const onPageReviewerSessionToken = 'synthetic-on-page-reviewer-session-token'
const pageEditorPageID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbe'
const pageEditorSetID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbf'
const pageEditorMetadataPageID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbba3'
const pageEditorSessionToken = 'synthetic-page-editor-owner-session-token'
const metadataEditorSessionToken = 'synthetic-metadata-editor-owner-session-token'
const metadataSectionID = 'abcd0000-0000-4000-8000-000000000001'
const metadataPillarID = 'abcd0000-0000-4000-8000-000000000002'
const metadataServiceID = 'abcd0000-0000-4000-8000-000000000003'
const metadataArticleID = pageEditorMetadataPageID
const metadataJobID = 'abcd0000-0000-4000-8000-000000000004'
const metadataSetID = 'abcd0000-0000-4000-8000-000000000005'
const pageCreatorSessionToken = 'synthetic-page-creator-owner-session-token'
const approverEditorPageID = 'abababab-abab-4bab-8bab-ababababab01'
const approverEditorBlockID = 'abababab-abab-4bab-8bab-ababababab02'
const approverEditorSetID = 'abababab-abab-4bab-8bab-ababababab03'
const approverEditorSessionToken = 'synthetic-page-editor-approver-session-token'
const applicationSessionTokens = { owner: 'synthetic-application-owner-session-token', hiring: 'synthetic-application-hiring-session-token', editor: 'synthetic-application-editor-session-token', sales: 'synthetic-application-sales-session-token' }
const operationsSessionToken = 'synthetic-operations-owner-session-token'
const galleryOwnerSessionToken = 'synthetic-gallery-owner-session-token'
const siteOwnerSessionToken = 'synthetic-site-owner-session-token'
const usersOwnerSessionToken = 'synthetic-users-owner-session-token'
const usersOwnerOtherSessionToken = 'synthetic-users-owner-other-session-token'
const galleryPageID = 'face0000-0000-4000-8000-000000000001'
const gallerySetID = 'face0000-0000-4000-8000-000000000002'
const shellSessionTokens = {
  owner: 'synthetic-shell-owner-session-token',
  editor: 'synthetic-shell-editor-session-token',
  approver: 'synthetic-shell-approver-session-token',
} as const
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'site-engine-cms-e2e-'))
const databasePath = join(temporaryDirectory, 'cms.sqlite')
const bootstrapPath = join(temporaryDirectory, 'bootstrap-token')
const caCertificate = join(temporaryDirectory, 'synthetic-ca.pem')
const caKey = join(temporaryDirectory, 'synthetic-ca.key')
const serverCertificate = join(temporaryDirectory, 'synthetic-issuer.pem')
const serverKey = join(temporaryDirectory, 'synthetic-issuer.key')
const certificateRequest = join(temporaryDirectory, 'synthetic-issuer.csr')
const certificateExtensions = join(temporaryDirectory, 'synthetic-issuer.ext')
const initialPreviewBaseline = join(temporaryDirectory, 'initial-preview-baseline.json')
const themeRegistry = join(temporaryDirectory, 'theme-registry.json')
const previewArtifacts = join(temporaryDirectory, 'preview-artifacts')
const browserThemeManifest = { name: 'browser-theme', version: '2.4.6', contract: '1.4.0', entry: './dist/renderer.js', standardBlocks: ['hero', 'faq', 'contact', 'richText'], settingKeys: ['tone'], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } }
const navigationThemeManifest = { ...browserThemeManifest, name: 'navigation-browser-theme', version: '1.6.0', contract: '1.6.0', settingKeys: [] }
const incompatibleBrowserThemeManifest = { name: 'incomplete-browser-theme', version: '1.0.0', contract: '1.0.0', entry: './dist/renderer.js', standardBlocks: ['hero'], settingKeys: [], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } }
const galleryTheme = process.env.BLOCK_GALLERY_E2E_THEME_ID && process.env.BLOCK_GALLERY_E2E_THEME_VERSION ? { name: process.env.BLOCK_GALLERY_E2E_THEME_ID, version: process.env.BLOCK_GALLERY_E2E_THEME_VERSION, contract: '1.4.0', entry: './dist/renderer.js', standardBlocks: ['hero', 'incidentBar', 'pillarGrid', 'featureGrid', 'splitList', 'chipList', 'testimonials', 'faq', 'callout', 'relatedServices', 'cta', 'richText', 'contact', 'media', 'imageText', 'gallery', 'logoStrip', 'video'], settingKeys: [], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } } : undefined
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value) ?? 'null'
writeFileSync(bootstrapPath, 'synthetic-browser-bootstrap-token')
writeFileSync(themeRegistry, JSON.stringify({ themes: [
  { manifest: browserThemeManifest, installedAt: '2026-10-03T00:00:00.000Z' },
  { manifest: navigationThemeManifest, installedAt: '2026-10-06T00:00:00.000Z' },
  { manifest: incompatibleBrowserThemeManifest, installedAt: '2026-10-03T00:00:00.000Z' },
  ...(galleryTheme ? [{ manifest: galleryTheme, installedAt: '2026-10-05T00:00:00.000Z' }] : []),
] }))
const initialBaseline = structuredClone(neutralFixture)
initialBaseline.settings.contractVersion = '1.4.0'
if (galleryTheme) initialBaseline.settings.theme = { id: galleryTheme.name, version: galleryTheme.version, contract: galleryTheme.contract, manifestDigest: createHash('sha256').update(stable(galleryTheme)).digest('hex') }
initialBaseline.settings.sections.push({ id: applicationSectionID, name: 'Careers', slug: 'careers', allowedTemplates: ['listing', 'job'], pageIds: [applicationJobID, draftApplicationJobID, expiredApplicationJobID] })
initialBaseline.pages.push({ id: applicationJobID, sectionId: applicationSectionID, title: 'Synthetic Application Engineer', summary: 'A published synthetic role used only to exercise the private application HTTP flow.', slug: 'synthetic-application-engineer', template: 'job', status: 'published', publishedAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z', blocks: [], jobPosting: { datePosted: '2026-10-01T12:00:00.000Z', employmentType: 'FULL_TIME', location: { addressLocality: 'Toronto', addressCountry: 'CA' }, validThrough: '2030-01-01T00:00:00.000Z' } })
initialBaseline.pages.push({ id: draftApplicationJobID, sectionId: applicationSectionID, title: 'Synthetic Draft Role', summary: 'A draft synthetic role which must not accept applications.', slug: 'synthetic-draft-role', template: 'job', status: 'draft', blocks: [], jobPosting: { datePosted: '2026-10-01T12:00:00.000Z', employmentType: 'FULL_TIME', location: { addressLocality: 'Toronto', addressCountry: 'CA' } } })
initialBaseline.pages.push({ id: expiredApplicationJobID, sectionId: applicationSectionID, title: 'Synthetic Expired Role', summary: 'An expired synthetic role which must not accept applications.', slug: 'synthetic-expired-role', template: 'job', status: 'published', publishedAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z', blocks: [], jobPosting: { datePosted: '2026-10-01T12:00:00.000Z', employmentType: 'FULL_TIME', location: { addressLocality: 'Toronto', addressCountry: 'CA' }, validThrough: '2026-10-02T00:00:00.000Z' } })
const directEditSectionID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
initialBaseline.settings.sections.push({ id: directEditSectionID, name: 'Direct edit browser section', slug: 'direct-edit-browser', allowedTemplates: ['landing', 'standard'], pageIds: [directEditPageID, pageEditorPageID, approverEditorPageID] })
initialBaseline.pages.push({ id: directEditPageID, sectionId: directEditSectionID, title: 'Direct edit browser page', summary: 'Synthetic page for the protected direct Hero browser flow.', slug: 'direct-edit-browser-page', template: 'landing', status: 'published', blocks: [{ id: directEditBlockID, type: 'hero', heading: 'Browser original heading', body: 'Browser original body.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] })
const onPageReviewSectionID = '12345678-1234-4234-8234-1234567890aa'
initialBaseline.settings.sections.push({ id: onPageReviewSectionID, name: 'On-page review browser section', slug: 'on-page-review', allowedTemplates: ['landing'], pageIds: [onPageReviewPageID] })
initialBaseline.pages.push({ id: onPageReviewPageID, sectionId: onPageReviewSectionID, title: 'On-page review target', summary: 'Synthetic published page for the protected on-page review flow.', slug: 'review-target', template: 'landing', status: 'published', blocks: [{ id: onPageReviewBlockID, type: 'hero', heading: 'Original review heading', body: 'This is the live rendered review body.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] })
initialBaseline.pages.push({ id: pageEditorPageID, sectionId: directEditSectionID, title: 'Page editor browser page', summary: 'Synthetic page for the complete protected page editor flow.', slug: 'page-editor-browser-page', template: 'standard', status: 'published', blocks: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbba1', type: 'hero', heading: 'Page editor original heading', body: 'Page editor original body.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbba2', type: 'contact', heading: 'Original contact block', body: 'Remove this block during the browser flow.', inquiryForm: false, hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] })
initialBaseline.pages.push({ id: approverEditorPageID, sectionId: directEditSectionID, title: 'Approver page editor target', summary: 'Synthetic published page for the Approver whole-page editing flow.', slug: 'approver-page-editor', template: 'standard', status: 'published', blocks: [{ id: approverEditorBlockID, type: 'hero', heading: 'Approver original heading', body: 'Approver original body.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] })
initialBaseline.settings.sections.push({ id: metadataSectionID, name: 'Metadata browser section', slug: 'metadata-browser', allowedTemplates: ['pillar', 'service', 'article', 'job'], pageIds: [metadataPillarID, metadataServiceID, metadataArticleID, metadataJobID] })
initialBaseline.pages.push({ id: metadataPillarID, sectionId: metadataSectionID, title: 'Metadata service pillar', summary: 'Synthetic pillar for service metadata browser verification.', slug: 'service-pillar', template: 'pillar', status: 'published', blocks: [] })
initialBaseline.pages.push({ id: metadataServiceID, sectionId: metadataSectionID, parentId: metadataPillarID, title: 'Metadata service page', summary: 'Synthetic service for type-specific metadata browser verification.', slug: 'service-page', template: 'service', status: 'published', blocks: [] })
initialBaseline.pages.push({ id: metadataArticleID, sectionId: metadataSectionID, title: 'Metadata article page', summary: 'Synthetic article for type-specific metadata browser verification.', slug: 'article-page', template: 'article', status: 'published', blocks: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbba4', type: 'richText', body: 'Synthetic article body.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] })
initialBaseline.pages.push({ id: metadataJobID, sectionId: metadataSectionID, title: 'Metadata job page', summary: 'Synthetic job for type-specific metadata browser verification.', slug: 'job-page', template: 'job', status: 'published', blocks: [] })
const inquiryPageID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc'
initialBaseline.settings.sections[0]!.allowedTemplates.push('standard')
initialBaseline.settings.sections[0]!.pageIds.push(inquiryPageID)
initialBaseline.pages.push({ id: inquiryPageID, sectionId: initialBaseline.settings.sections[0]!.id, title: 'Inquiry form', summary: 'Synthetic intake browser fixture.', seoDescription: 'A synthetic consented inquiry form used for browser verification.', slug: 'gallery', template: 'standard', status: 'published', blocks: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd', type: 'contact', heading: 'Contact details', body: 'Send a synthetic inquiry.', inquiryForm: true, hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] })
writeFileSync(initialPreviewBaseline, JSON.stringify(initialBaseline))

Object.assign(process.env, { NODE_ENV: 'test' })
process.env.DATABASE_URI = `file:${databasePath}`
process.env.MEDIA_STORAGE_DIR = join(temporaryDirectory, 'media')
process.env.APPLICATION_STORAGE_DIR = join(temporaryDirectory, 'applications')
process.env.PAYLOAD_SECRET = 'synthetic-browser-payload-secret-not-for-production'
process.env.PAYLOAD_PUBLIC_SERVER_URL = cmsOrigin
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = bootstrapPath
process.env.SITE_THEME_REGISTRY_JSON = themeRegistry
process.env.OIDC_GOOGLE_ISSUER_URL = issuerOrigin
process.env.OIDC_GOOGLE_CLIENT_ID = clientID
process.env.OIDC_GOOGLE_CLIENT_SECRET = clientSecret
process.env.EMERGENCY_TOTP_ENCRYPTION_KEY = randomBytes(32).toString('base64url')
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64url')
process.env.INITIAL_PUBLISH_BASELINE_FILE = initialPreviewBaseline
process.env.PREVIEW_THEME_VERSION = galleryTheme?.version ?? '1.0.0'
process.env.PREVIEW_ENGINE_VERSION = '1.0.0'
process.env.PREVIEW_CONTRACT_VERSION = neutralFixture.settings.contractVersion
process.env.PREVIEW_WORKER_TOKEN = 'synthetic-preview-worker-token-long-enough-for-browser-tests'
const { GET: previewSession } = await import('../app/api/auth/preview/review-session/route.js')
const { GET: pageReviewEntry } = await import('../app/api/editorial/page-review-entry/route.js')

type Identity = { email: string; name: string; subject: string }
type Authorization = { challenge: string; nonce: string; redirectURI: string; identity: Identity }
const identities: Record<'editor' | 'owner' | 'hiring' | 'sales', Identity> = {
  owner: { email: 'owner.synthetic@example.test', name: 'Synthetic Owner', subject: 'synthetic-owner' },
  editor: { email: 'editor.synthetic@example.test', name: 'Synthetic Editor', subject: 'synthetic-editor' },
  hiring: { email: 'hiring.synthetic@example.test', name: 'Synthetic Hiring', subject: 'synthetic-hiring' },
  sales: { email: 'sales.synthetic@example.test', name: 'Synthetic Sales', subject: 'synthetic-sales' },
}
const authorizations = new Map<string, Authorization>()
let privateKey: CryptoKey
let jwk: Record<string, unknown>
let payload: Awaited<ReturnType<typeof getPayload>>
let issuer: ReturnType<typeof createServer>
let cmsProxy: ReturnType<typeof createServer>
let readiness: ReturnType<typeof createHTTPServer>
let next: ChildProcess | undefined
let stopping = false
let localOwnerID: string | undefined
let applicationOwnerID: string | undefined
let reviewOwnerID: string | undefined

function createCertificates(): void {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes', '-keyout', caKey, '-out', caCertificate, '-subj', '/CN=site-engine-e2e-ca', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' })
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', serverKey, '-out', certificateRequest, '-subj', '/CN=localhost'], { stdio: 'ignore' })
  writeFileSync(certificateExtensions, 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n')
  execFileSync('openssl', ['x509', '-req', '-in', certificateRequest, '-CA', caCertificate, '-CAkey', caKey, '-CAcreateserial', '-out', serverCertificate, '-days', '1', '-sha256', '-extfile', certificateExtensions], { stdio: 'ignore' })
}

function readBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(new URLSearchParams(body)))
    request.on('error', reject)
  })
}

function html(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

function previewContentType(path: string): string {
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'application/javascript; charset=utf-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

async function provider(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || '/', issuerOrigin)
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(response, { issuer: issuerOrigin, authorization_endpoint: `${issuerOrigin}/authorize`, token_endpoint: `${issuerOrigin}/token`, jwks_uri: `${issuerOrigin}/jwks`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], id_token_signing_alg_values_supported: ['RS256'] })
  }
  if (url.pathname === '/jwks') return json(response, { keys: [{ ...jwk, alg: 'RS256', kid: 'synthetic-browser-key', use: 'sig' }] })
  if (url.pathname === '/cross-origin-post') {
    return html(response, `<form action="${cmsOrigin}/api/auth/logout" method="post"><button>Submit cross-origin logout</button></form>`)
  }
  if (url.pathname === '/authorize' && request.method === 'GET') {
    const redirectURI = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state')
    const nonce = url.searchParams.get('nonce')
    const challenge = url.searchParams.get('code_challenge')
    if (!redirectURI || !state || !nonce || !challenge || url.searchParams.get('client_id') !== clientID) return html(response, 'Invalid synthetic authorization request.', 400)
    const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`
    return html(response, `<main><h1>Synthetic identity provider</h1><form method="post" action="/authorize">${hidden('redirect_uri', redirectURI)}${hidden('state', state)}${hidden('nonce', nonce)}${hidden('code_challenge', challenge)}<button name="identity" value="owner">Sign in as Synthetic Owner</button><button name="identity" value="editor">Sign in as Synthetic Editor</button></form></main>`)
  }
  if (url.pathname === '/authorize' && request.method === 'POST') {
    const form = await readBody(request)
    const choice = form.get('identity')
    const identity = choice === 'owner' || choice === 'editor' || choice === 'hiring' || choice === 'sales' ? identities[choice] : undefined
    const redirectURI = form.get('redirect_uri')
    const state = form.get('state')
    const nonce = form.get('nonce')
    const challenge = form.get('code_challenge')
    if (!identity || !redirectURI || !state || !nonce || !challenge || !redirectURI.startsWith(`${cmsOrigin}/api/auth/callback/google`)) return html(response, 'Invalid synthetic authorization request.', 400)
    const code = randomUUID()
    authorizations.set(code, { challenge, nonce, redirectURI, identity })
    response.writeHead(303, { location: `${redirectURI}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, 'cache-control': 'no-store' })
    response.end()
    return
  }
  if (url.pathname === '/token' && request.method === 'POST') {
    const form = await readBody(request)
    const authorization = form.get('code') ? authorizations.get(form.get('code')!) : undefined
    const verifier = form.get('code_verifier')
    const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : ''
    const basicCredentials = `Basic ${Buffer.from(`${clientID}:${clientSecret}`).toString('base64')}`
    const clientAuthenticated = request.headers.authorization === basicCredentials || (form.get('client_id') === clientID && form.get('client_secret') === clientSecret)
    if (!authorization || !clientAuthenticated || form.get('redirect_uri') !== authorization.redirectURI || challenge !== authorization.challenge) {
      return json(response, { error: 'invalid_grant' }, 400)
    }
    authorizations.delete(form.get('code')!)
    const idToken = await new SignJWT({ email: authorization.identity.email, email_verified: true, name: authorization.identity.name, nonce: authorization.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-browser-key' })
      .setIssuer(issuerOrigin).setAudience(clientID).setSubject(authorization.identity.subject).setIssuedAt().setExpirationTime('5m').sign(privateKey)
    return json(response, { access_token: 'synthetic-access-token', id_token: idToken, token_type: 'Bearer' })
  }
  html(response, 'Not found', 404)
}

async function seed(): Promise<void> {
  const { default: config } = await import('../payload.config.js')
  payload = await getPayload({ config })
  const editor = await payload.create({ collection: 'users', data: { email: identities.editor.email, name: identities.editor.name, roles: ['editor'], provider: 'google', providerIssuer: issuerOrigin, providerSubject: identities.editor.subject, emergencyTotpSecret: encryptedFixture, emergencyRecoveryHashes: [recoveryFixture] }, overrideAccess: true })
  const onPageEditor = await payload.create({ collection: 'users', data: { email: 'on-page-editor.synthetic@example.test', name: 'Synthetic On-page Editor', roles: ['editor'] }, overrideAccess: true })
  const localOwner = await payload.create({ collection: 'users', data: { email: emergencyEmail, name: 'Synthetic Emergency Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash(emergencyRecoveryCode), recoveryHash(localOwnerRecoveryCode), recoveryHash(localOwnerDisableRecoveryCode)] }, overrideAccess: true })
  localOwnerID = String(localOwner.id)
  const onPageReviewer = await payload.create({ collection: 'users', data: { email: 'on-page-reviewer.synthetic@example.test', name: 'Synthetic On-page Reviewer', roles: ['owner'] }, overrideAccess: true })
  const applicationOwner = await payload.create({ collection: 'users', data: { email: 'application-owner.synthetic@example.test', name: 'Synthetic Application Owner', roles: ['owner'] }, overrideAccess: true })
  applicationOwnerID = String(applicationOwner.id)
  const pageEditorOwner = await payload.create({ collection: 'users', data: { email: 'page-editor-owner.synthetic@example.test', name: 'Synthetic Page Editor Owner', roles: ['owner'] }, overrideAccess: true })
  const metadataEditorOwner = await payload.create({ collection: 'users', data: { email: 'metadata-editor-owner.synthetic@example.test', name: 'Synthetic Metadata Editor Owner', roles: ['owner'] }, overrideAccess: true })
  const pageCreatorOwner = await payload.create({ collection: 'users', data: { email: 'page-creator-owner.synthetic@example.test', name: 'Synthetic Page Creator Owner', roles: ['owner'] }, overrideAccess: true })
  const pageEditorApprover = await payload.create({ collection: 'users', data: { email: 'page-editor-approver.synthetic@example.test', name: 'Synthetic Page Editor Approver', roles: ['approver'] }, overrideAccess: true })
  const operationsOwner = await payload.create({ collection: 'users', data: { email: 'operations-owner.synthetic@example.test', name: 'Synthetic Operations Owner', roles: ['owner'] }, overrideAccess: true })
  const galleryOwner = await payload.create({ collection: 'users', data: { email: 'gallery-owner.synthetic@example.test', name: 'Synthetic Gallery Owner', roles: ['owner'] }, overrideAccess: true })
  const siteOwner = await payload.create({ collection: 'users', data: { email: 'site-owner.synthetic@example.test', name: 'Synthetic Site Owner', roles: ['owner'] }, overrideAccess: true })
  const usersOwner = await payload.create({ collection: 'users', data: { email: 'users-owner.synthetic@example.test', name: 'Synthetic Users Owner', roles: ['owner'], provider: 'google', providerIssuer: issuerOrigin, providerSubject: 'synthetic-users-owner' }, overrideAccess: true })
  const usersTarget = await payload.create({ collection: 'users', data: { email: 'users-target.synthetic@example.test', name: 'Synthetic Users Target', roles: ['editor'], provider: 'google', providerIssuer: issuerOrigin, providerSubject: 'synthetic-users-target' }, overrideAccess: true })
  const shellUsers: Record<keyof typeof shellSessionTokens, { id: string }> = {} as Record<keyof typeof shellSessionTokens, { id: string }>
  for (const role of ['owner', 'editor', 'approver'] as const) {
    shellUsers[role] = await payload.create({
      collection: 'users',
      data: { email: `shell-${role}.synthetic@example.test`, name: `Synthetic Shell ${role}`, roles: [role] },
      overrideAccess: true,
    })
  }
  const reviewOwner = await payload.create({ collection: 'users', data: { email: reviewOwnerEmail, name: 'Synthetic Review Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash(reviewOwnerRecoveryCode)] }, overrideAccess: true })
  reviewOwnerID = String(reviewOwner.id)
  await payload.create({ collection: 'users', data: { email: 'content-owner.synthetic@example.test', name: 'Synthetic Content Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash('synthetic-content-owner-code-05'), recoveryHash('synthetic-intake-owner-code-06')] }, overrideAccess: true })
  const leadOwner = await payload.create({ collection: 'users', data: { email: leadOwnerEmail, name: 'Synthetic Lead Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash(leadOwnerRecoveryCode)] }, overrideAccess: true })
  const leadEditor = await payload.create({ collection: 'users', data: { email: 'lead-editor.synthetic@example.test', name: 'Synthetic Lead Editor', roles: ['editor'] }, overrideAccess: true })
  await payload.create({ collection: 'users', data: { email: scheduleOwnerEmail, name: 'Synthetic Schedule Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash(scheduleOwnerRecoveryCode)] }, overrideAccess: true })
  const themeOwner = await payload.create({ collection: 'users', data: { email: themeOwnerEmail, name: 'Synthetic Theme Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash(themeOwnerRecoveryCode)] }, overrideAccess: true })
  const mediaOwner = await payload.create({ collection: 'users', data: { email: 'media-owner.synthetic@example.test', name: 'Synthetic Media Owner', roles: ['owner'] }, overrideAccess: true })
  await payload.create({ collection: 'invitations', data: { email: identities.owner.email, provider: 'google', providerIssuer: issuerOrigin, providerSubject: identities.owner.subject, requiredSubject: identities.owner.subject, roles: ['owner'], tokenHash: hashOpaqueToken(inviteToken), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }, overrideAccess: true })
  const applicationUsers: Record<'hiring' | 'sales', { id: string }> = {} as Record<'hiring' | 'sales', { id: string }>
  for (const [role, identity] of Object.entries({ hiring: identities.hiring, sales: identities.sales }) as Array<['hiring' | 'sales', Identity]>) {
    applicationUsers[role] = await payload.create({ collection: 'users', data: { email: identity.email, name: identity.name, roles: [role], provider: 'google', providerIssuer: issuerOrigin, providerSubject: identity.subject }, overrideAccess: true })
  }
  const sessionNow = new Date().toISOString(); const sessionExpiry = new Date(Date.now() + 10 * 60_000).toISOString()
  for (const [role, user] of Object.entries({ owner: applicationOwner, hiring: applicationUsers.hiring, editor, sales: applicationUsers.sales }) as Array<[keyof typeof applicationSessionTokens, { id: string }]>) {
    await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(applicationSessionTokens[role]), user: user.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  }
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(onPageEditorSessionToken), user: onPageEditor.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(onPageReviewerSessionToken), user: onPageReviewer.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  const directSection = await payload.create({ collection: 'sections', data: { id: directEditSectionID, name: 'Direct edit browser section', slug: 'direct-edit-browser', allowedTemplates: ['landing', 'standard'] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'pages', data: { id: directEditPageID, title: 'Direct edit browser page', summary: 'Synthetic page for the protected direct Hero browser flow.', slug: 'direct-edit-browser-page', sectionId: directSection.id, template: 'landing', blocks: [{ id: directEditBlockID, type: 'hero', heading: 'Browser original heading', body: 'Browser original body.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'change-sets', data: { id: directEditSetID, name: 'Browser Editor draft', state: 'open', actor: editor.id, revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  const onPageSection = await payload.create({ collection: 'sections', data: { id: onPageReviewSectionID, name: 'On-page review browser section', slug: 'on-page-review', allowedTemplates: ['landing'] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'pages', data: { id: onPageReviewPageID, title: 'On-page review target', summary: 'Synthetic published page for the protected on-page review flow.', slug: 'review-target', sectionId: onPageSection.id, template: 'landing', blocks: [{ id: onPageReviewBlockID, type: 'hero', heading: 'Original review heading', body: 'This is the live rendered review body.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'change-sets', data: { id: onPageReviewSetID, name: 'Review the rendered Hero change', state: 'open', actor: onPageEditor.id, revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(pageEditorSessionToken), user: pageEditorOwner.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(pageCreatorSessionToken), user: pageCreatorOwner.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  await payload.create({ collection: 'pages', data: { id: pageEditorPageID, title: 'Page editor browser page', summary: 'Synthetic page for the complete protected page editor flow.', slug: 'page-editor-browser-page', sectionId: directSection.id, template: 'standard', blocks: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbba1', type: 'hero', heading: 'Page editor original heading', body: 'Page editor original body.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbba2', type: 'contact', heading: 'Original contact block', body: 'Remove this block during the browser flow.', inquiryForm: false, hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'change-sets', data: { id: pageEditorSetID, name: 'Browser full page draft', state: 'open', actor: pageEditorOwner.id, revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(metadataEditorSessionToken), user: metadataEditorOwner.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  const metadataSection = await payload.create({ collection: 'sections', data: { id: metadataSectionID, name: 'Metadata browser section', slug: 'metadata-browser', allowedTemplates: ['pillar', 'service', 'article', 'job'] }, overrideAccess: true, context: { editorialInternal: true } })
  const careersSection = await payload.create({ collection: 'sections', data: { id: applicationSectionID, name: 'Careers', slug: 'careers', allowedTemplates: ['listing', 'job'] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'pages', data: { id: applicationJobID, title: 'Synthetic Application Engineer', summary: 'A published synthetic role used only to exercise the private application HTTP flow.', slug: 'synthetic-application-engineer', sectionId: careersSection.id, template: 'job', blocks: [], jobPosting: { datePosted: '2026-10-01T12:00:00.000Z', employmentType: 'FULL_TIME', location: { addressLocality: 'Toronto', addressCountry: 'CA' }, validThrough: '2030-01-01T00:00:00.000Z' } }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'pages', data: { id: draftApplicationJobID, title: 'Synthetic Draft Role', summary: 'A draft synthetic role which must not accept applications.', slug: 'synthetic-draft-role', sectionId: careersSection.id, template: 'job', blocks: [], jobPosting: { datePosted: '2026-10-01T12:00:00.000Z', employmentType: 'FULL_TIME', location: { addressLocality: 'Toronto', addressCountry: 'CA' } } }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'pages', data: { id: expiredApplicationJobID, title: 'Synthetic Expired Role', summary: 'An expired synthetic role which must not accept applications.', slug: 'synthetic-expired-role', sectionId: careersSection.id, template: 'job', blocks: [], jobPosting: { datePosted: '2026-10-01T12:00:00.000Z', employmentType: 'FULL_TIME', location: { addressLocality: 'Toronto', addressCountry: 'CA' }, validThrough: '2026-10-02T00:00:00.000Z' } }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'pages', data: { id: metadataPillarID, title: 'Metadata service pillar', summary: 'Synthetic pillar for service metadata browser verification.', slug: 'service-pillar', sectionId: metadataSection.id, template: 'pillar', blocks: [] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'pages', data: { id: metadataServiceID, title: 'Metadata service page', summary: 'Synthetic service for type-specific metadata browser verification.', slug: 'service-page', sectionId: metadataSection.id, parentId: metadataPillarID, template: 'service', blocks: [] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'pages', data: { id: metadataArticleID, title: 'Metadata article page', summary: 'Synthetic article for type-specific metadata browser verification.', slug: 'article-page', sectionId: metadataSection.id, template: 'article', blocks: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbba4', type: 'richText', body: 'Synthetic article body.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'pages', data: { id: metadataJobID, title: 'Metadata job page', summary: 'Synthetic job for type-specific metadata browser verification.', slug: 'job-page', sectionId: metadataSection.id, template: 'job', blocks: [] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.update({ collection: 'sections', id: metadataSection.id, data: { pageIds: [metadataPillarID, metadataServiceID, metadataArticleID, metadataJobID] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'change-sets', data: { id: metadataSetID, name: 'Browser metadata draft', state: 'open', actor: metadataEditorOwner.id, revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(approverEditorSessionToken), user: pageEditorApprover.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  await payload.create({ collection: 'pages', data: { id: approverEditorPageID, title: 'Approver page editor target', summary: 'Synthetic published page for the Approver whole-page editing flow.', slug: 'approver-page-editor', sectionId: directSection.id, template: 'standard', blocks: [{ id: approverEditorBlockID, type: 'hero', heading: 'Approver original heading', body: 'Approver original body.', hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'change-sets', data: { id: approverEditorSetID, name: 'Approver browser page draft', state: 'open', actor: pageEditorApprover.id, revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(operationsSessionToken), user: operationsOwner.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(galleryOwnerSessionToken), user: galleryOwner.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(siteOwnerSessionToken), user: siteOwner.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(usersOwnerSessionToken), user: usersOwner.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(usersOwnerOtherSessionToken), user: usersOwner.id, authenticatedAt: sessionNow, lastSeenAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: sessionExpiry }, overrideAccess: true })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken('synthetic-users-target-session-token'), user: usersTarget.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  await payload.create({ collection: 'pages', data: { id: galleryPageID, title: 'Gallery recipe target', summary: 'Synthetic standard page for the active-theme gallery browser workflow.', slug: 'gallery-recipe-target', sectionId: directSection.id, template: 'standard', blocks: [] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'change-sets', data: { id: gallerySetID, name: 'Gallery browser recipe', state: 'open', actor: galleryOwner.id, revision: 0, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  for (const role of ['owner', 'editor', 'approver'] as const) {
    await payload.create({
      collection: 'auth-sessions',
      data: { tokenHash: hashOpaqueToken(shellSessionTokens[role]), user: shellUsers[role].id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry },
      overrideAccess: true,
    })
  }
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(themeOwnerSessionToken), user: themeOwner.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(mediaOwnerSessionToken), user: mediaOwner.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  for (const [role, user] of Object.entries({ owner: leadOwner, editor: leadEditor }) as Array<[keyof typeof leadSessionTokens, { id: string }]>) await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(leadSessionTokens[role]), user: user.id, authenticatedAt: sessionNow, lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
  const mediaRaster = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#155e75' } }).png().toBuffer()
  const mediaAssets = []
  for (let index = 0; index < 26; index += 1) {
    mediaAssets.push(await payload.create({
      collection: 'assets',
      data: { alt: `Synthetic media fixture ${String(index).padStart(2, '0')}`, caption: index === 1 ? 'Searchable lighthouse caption' : undefined },
      file: { data: mediaRaster, mimetype: 'image/png', name: `media-fixture-${String(index).padStart(2, '0')}.png`, size: mediaRaster.length },
      user: mediaOwner,
      overrideAccess: false,
    }))
  }
  // Payload correctly refuses invalid uploads. Corrupt one otherwise-real row
  // directly so the browser can prove that attaching legacy invalid media to a
  // page is rejected by the canonical page-save boundary as well.
  await (payload.db as unknown as { client: { execute: (query: { sql: string; args: unknown[] }) => Promise<unknown> } }).client.execute({
    sql: 'UPDATE assets SET alt = NULL, decorative = 0 WHERE id = ?',
    args: [mediaAssets[25]!.id],
  })
  const mediaSection = await payload.create({ collection: 'sections', data: { name: 'Media browser fixtures', summary: 'Synthetic section for media workspace browser verification.', slug: 'media-browser-fixtures', allowedTemplates: ['standard'] }, user: mediaOwner, overrideAccess: false })
  await payload.create({ collection: 'pages', data: { title: 'Media usage fixture page', summary: 'Synthetic page that keeps one media fixture in use.', slug: 'media-usage-fixture', sectionId: mediaSection.id, template: 'standard', blocks: [{ id: 'a1000000-0000-4000-8000-000000000001', type: 'media', mediaId: mediaAssets[0]!.id, hidden: false, appearance: { background: 'default', width: 'content', spacing: 'default', motionIntent: 'none', logoTone: 'default' } }] }, user: mediaOwner, overrideAccess: false })
  const binnedAsset = await payload.create({ collection: 'assets', data: { alt: 'Synthetic restorable media fixture' }, file: { data: mediaRaster, mimetype: 'image/png', name: 'media-restorable.png', size: mediaRaster.length }, user: mediaOwner, overrideAccess: false })
  const binnedAt = new Date().toISOString()
  await payload.update({ collection: 'assets', id: binnedAsset.id, data: { deletedAt: binnedAt, deleteAfter: new Date(Date.now() + 30 * 86_400_000).toISOString() }, overrideAccess: true, user: mediaOwner, context: { mediaLifecycle: 'bin' } })
  const publishedBaseline = structuredClone(initialBaseline)
  publishedBaseline.pages = publishedBaseline.pages.filter(page => page.status === 'published')
  const publishedPageIDs = new Set(publishedBaseline.pages.map(page => page.id))
  for (const section of publishedBaseline.settings.sections) {
    section.pageIds = section.pageIds.filter(id => publishedPageIDs.has(id))
    if (section.landingPageId && !publishedPageIDs.has(section.landingPageId)) delete section.landingPageId
  }
  const baselineChangeSet = await payload.create({ collection: 'change-sets', data: { id: applicationChangeSetID, name: 'Synthetic published application baseline', state: 'published', revision: 1, changes: [], quality: { checks: [{ name: 'synthetic-baseline', status: 'passed' }] } }, overrideAccess: true, context: { editorialInternal: true } })
  const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: canonicalHash(publishedBaseline), changeSet: baselineChangeSet.id, reviewRevision: 1, changeHash: 'synthetic-application-baseline', manifest: publishedBaseline, themeVersion: process.env.PREVIEW_THEME_VERSION!, engineVersion: process.env.PREVIEW_ENGINE_VERSION!, contractVersion: process.env.PREVIEW_CONTRACT_VERSION!, approvedBy: localOwner.id, baselineSequence: 0 }, overrideAccess: true, context: { editorialInternal: true } })
  const outbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: 'synthetic-application-baseline', sequence: 1, snapshot: snapshot.id, changeSet: baselineChangeSet.id, reviewRevision: 1, changeHash: 'synthetic-application-baseline', includedChangeKeys: [], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'published-releases', data: { outbox: outbox.id, sequence: 1, snapshot: snapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: 'a'.repeat(64), sourceContentHash: snapshot.contentHash, themeVersion: process.env.PREVIEW_THEME_VERSION!, engineVersion: process.env.PREVIEW_ENGINE_VERSION!, contractVersion: process.env.PREVIEW_CONTRACT_VERSION!, checks: [{ name: 'synthetic-baseline', status: 'passed' }] } }, overrideAccess: true, context: { editorialInternal: true } })

  const currentOperationsManifest = structuredClone(publishedBaseline)
  const operationsPageBefore = structuredClone(currentOperationsManifest.pages[0]!)
  currentOperationsManifest.pages[0]!.summary = 'A current published summary that the reviewed rollback browser flow restores.'
  const operationsPublishedSet = await payload.create({ collection: 'change-sets', data: { name: 'Change log current release', actor: operationsOwner.id, state: 'published', revision: 1, changes: [{ collection: 'pages', id: currentOperationsManifest.pages[0]!.id, before: operationsPageBefore, after: currentOperationsManifest.pages[0]!, beforeHash: canonicalHash(operationsPageBefore), afterHash: canonicalHash(currentOperationsManifest.pages[0]!) }] }, overrideAccess: true, context: { editorialInternal: true } })
  const operationsSnapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: canonicalHash(currentOperationsManifest), changeSet: operationsPublishedSet.id, reviewRevision: 1, changeHash: canonicalHash(operationsPublishedSet.changes), manifest: currentOperationsManifest, themeVersion: process.env.PREVIEW_THEME_VERSION!, engineVersion: process.env.PREVIEW_ENGINE_VERSION!, contractVersion: process.env.PREVIEW_CONTRACT_VERSION!, approvedBy: operationsOwner.id, baselineSequence: 1 }, overrideAccess: true, context: { editorialInternal: true } })
  const operationsOutbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: 'synthetic-change-log-current-release', sequence: 56, snapshot: operationsSnapshot.id, changeSet: operationsPublishedSet.id, reviewRevision: 1, changeHash: canonicalHash(operationsPublishedSet.changes), includedChangeKeys: [`pages:${currentOperationsManifest.pages[0]!.id}`], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'published-releases', data: { outbox: operationsOutbox.id, sequence: 56, snapshot: operationsSnapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: 'b'.repeat(64), sourceContentHash: operationsSnapshot.contentHash, themeVersion: process.env.PREVIEW_THEME_VERSION!, engineVersion: process.env.PREVIEW_ENGINE_VERSION!, contractVersion: process.env.PREVIEW_CONTRACT_VERSION!, checks: [{ name: 'synthetic-baseline', status: 'passed' }] } }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.change_set_approved', actor: operationsOwner.id, detail: { changeSet: operationsPublishedSet.id, snapshot: operationsSnapshot.id } }, overrideAccess: true })

  const submitted = await payload.create({ collection: 'change-sets', data: { name: 'Synthetic pending operational review', state: 'submitted', revision: 1, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'inquiries', data: { email: 'new-lead.synthetic@example.test', message: 'A synthetic new lead.', topic: 'general', sourcePage: '/synthetic', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: 'synthetic-operations-new', stage: 'new', urgent: false }, overrideAccess: true })
  await payload.create({ collection: 'inquiries', data: { email: 'urgent-lead.synthetic@example.test', message: 'A synthetic urgent lead.', topic: 'active-incident', sourcePage: '/synthetic', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: 'synthetic-operations-urgent', stage: 'qualified', urgent: true }, overrideAccess: true })
  await payload.create({ collection: 'inquiries', data: { email: 'notes-a.synthetic@example.test', name: 'First editable lead', message: '<img src=x onerror=alert(1)> remains visible text.', topic: 'project', sourcePage: '/services/a', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-leads-notes-a', stage: 'contacted', urgent: false, notes: 'First lead notes', nextAction: 'Call first lead' }, overrideAccess: true })
  await payload.create({ collection: 'inquiries', data: { email: 'notes-b.synthetic@example.test', name: 'Second editable lead', message: 'A separate lead for controlled form state.', topic: 'partnership', sourcePage: '/services/b', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-leads-notes-b', stage: 'contacted', urgent: false, notes: 'Second lead notes', nextAction: 'Email second lead' }, overrideAccess: true })
  const archivedLead = await payload.create({ collection: 'inquiries', data: { email: 'archived-lead.synthetic@example.test', name: 'Archived lead', message: 'A lead outside the default received range.', topic: 'general', sourcePage: '/archive', consentedAt: '2025-01-01T00:00:00.000Z', consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-leads-archived', stage: 'new', urgent: false }, overrideAccess: true })
  await payload.update({ collection: 'inquiries', id: archivedLead.id, data: { createdAt: '2025-01-01T00:00:00.000Z' }, overrideAccess: true })
  for (let index = 0; index < 51; index += 1) await payload.create({ collection: 'inquiries', data: { email: `proposal-${index}@synthetic.example.test`, message: `Synthetic proposal lead ${index}.`, topic: 'project', sourcePage: '/proposal-fixture', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: `synthetic-leads-proposal-${index}`, stage: 'proposal', urgent: false }, overrideAccess: true })
  await payload.create({ collection: 'applications', data: { name: 'Synthetic candidate', email: 'candidate.synthetic@example.test', coverLetter: 'Synthetic application for role-scoped badge verification.', consent: true, jobId: 'synthetic-role', resumeKey: `${randomUUID()}-${'a'.repeat(64)}`, idempotencyKey: 'synthetic-application-new', status: 'new' }, overrideAccess: true })
  await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: 'synthetic-operations-pending', sequence: 2, snapshot: snapshot.id, changeSet: submitted.id, reviewRevision: 1, changeHash: 'synthetic-operations-pending', includedChangeKeys: [], status: 'pending', attempts: 0, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: 'synthetic-operations-processing', sequence: 3, snapshot: snapshot.id, changeSet: submitted.id, reviewRevision: 1, changeHash: 'synthetic-operations-processing', includedChangeKeys: [], status: 'processing', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: 'synthetic-operations-failed', sequence: 4, snapshot: snapshot.id, changeSet: submitted.id, reviewRevision: 1, changeHash: 'synthetic-operations-failed', includedChangeKeys: [], status: 'failed', attempts: 2, errorCode: 'synthetic_publish_failure', lastError: 'Synthetic failure detail.', correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  for (let sequence = 5; sequence <= 55; sequence += 1) await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `synthetic-operations-pending-${sequence}`, sequence, snapshot: snapshot.id, changeSet: submitted.id, reviewRevision: 1, changeHash: `synthetic-operations-pending-${sequence}`, includedChangeKeys: [], status: 'pending', attempts: 0, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  for (let index = 0; index < 26; index += 1) await payload.create({ collection: 'audit-events', data: { event: 'operations.fixture.page', actor: operationsOwner.id, detail: { index } }, overrideAccess: true })
  await payload.create({ collection: 'audit-events', data: { event: 'inquiry.created', actor: operationsOwner.id, detail: { email: 'never-expose@example.test', message: 'Never expose this lead text.', resumeKey: 'private-resume-key' } }, overrideAccess: true })
}

function forwardCMS(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === 'GET' && request.url === '/__e2e/axe.js') {
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
    response.end(readFileSync(axeSourcePath))
    return
  }
  if (request.method === 'GET' && /^\/preview\/changes\/[0-9a-f-]+\/(live|proposed)(?:\/[^?]*)?(?:\?.*)?$/i.test(request.url ?? '')) {
    void previewSession(new Request(`${cmsOrigin}/api/auth/preview/review-session`, { headers: { cookie: String(request.headers.cookie ?? ''), 'x-original-uri': request.url ?? '/' } })).then((guard) => {
      if (guard.status !== 204) { response.writeHead(guard.status); response.end(); return }
      const jobID = (request.url ?? '').split('/')[3]!
      const variant = (request.url ?? '').split('/')[4]!
      const relativePath = (request.url ?? '').split('/').slice(5).join('/') || 'index.html'
      const artifact = join(previewArtifacts, jobID, variant, relativePath)
      if (!artifact.startsWith(join(previewArtifacts, jobID, variant))) { response.writeHead(403); response.end(); return }
      return readFile(artifact)
        .catch(() => readFile(join(artifact, 'index.html')))
        .then((bytes) => {
          const contentType = artifact.endsWith('.html') || !relativePath.includes('.') ? 'text/html; charset=utf-8' : previewContentType(artifact)
          response.writeHead(200, { 'content-type': contentType })
          response.end(bytes)
        })
        .catch(() => { response.writeHead(404); response.end() })
    }).catch(() => { response.writeHead(403); response.end() })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/direct-preview-worker') {
    void (async () => {
      const job = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req))
      if (!job) throw new Error('No claimable preview job.')
      const api = async (action: string, body: Record<string, unknown> = {}) => {
        if (action === 'claim') {
          return {
            job: { id: job.id, leaseToken: job.leaseToken, leaseExpiresAt: job.leaseExpiresAt },
            live: job.liveManifest,
            proposed: job.proposedManifest,
            basePaths: { live: 'live', proposed: 'proposed' },
            versionPins: job.versionPins,
          }
        }
        if (action === 'renew') return { ok: true }
        if (action === 'complete') {
          return withPayloadTransaction(payload, inner => completePreviewRenderJob(payload, inner, String(body.id), String(body.leaseToken), {
            liveManifestHash: String(body.liveManifestHash),
            proposedManifestHash: String(body.proposedManifestHash),
            artifactDigest: String(body.artifactDigest),
          }))
        }
        throw new Error('Unsupported preview worker action.')
      }
      const pins = job.versionPins as { engineVersion: string; themeVersion: string; contractVersion: string }
      await runPreviewOnce({ api, artifactRoot: previewArtifacts, publicOrigin: cmsOrigin, versionPins: pins, registry: new Map(), heartbeatMs: 60_000, signal: undefined })
      return payload.findByID({ collection: 'preview-render-jobs', id: job.id, depth: 0, overrideAccess: true })
    })().then((job) => json(response, { id: job.id, status: job.status })).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to complete preview.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/second-page-review') {
    void (async () => {
      const source = await payload.findByID({ collection: 'change-sets', id: onPageReviewSetID, depth: 0, overrideAccess: true })
      const sourceChange = structuredClone((source.changes as Array<Record<string, unknown>>)[0]!)
      const after = structuredClone(sourceChange.after) as Record<string, unknown>
      after.blocks = (structuredClone(after.blocks) as Array<Record<string, unknown>>).map((block) => String(block.id) === onPageReviewBlockID ? { ...block, heading: 'Second proposed review heading', body: 'This is the second proposed rendered review body.' } : block)
      const created = await payload.create({ collection: 'change-sets', data: { id: secondOnPageReviewSetID, name: 'Second pending page review', actor: source.actor, state: 'submitted', revision: 1, submittedAt: new Date().toISOString(), changes: [{ ...sourceChange, after, afterHash: null }], quality: source.quality, preview: { status: 'pending' } }, overrideAccess: true, context: { editorialInternal: true } })
      return { id: String(created.id) }
    })().then((created) => json(response, created)).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to seed second page review.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/owner/disable') {
    void payload.find({ collection: 'users', where: { providerSubject: { equals: identities.owner.subject } }, limit: 1, overrideAccess: true })
      .then(({ docs }) => docs[0] ? payload.update({ collection: 'users', id: docs[0].id, data: { disabled: true }, overrideAccess: true }) : Promise.reject(new Error('Owner missing')))
      .then(() => { response.writeHead(204); response.end() })
      .catch(() => { response.writeHead(500); response.end('Unable to disable owner.') })
    return
  }
  if (request.method === 'POST' && /^\/__e2e\/applications\/[^/]+\/expired-link$/.test(request.url ?? '')) {
    const id = request.url!.split('/')[3]!
    const userID = applicationOwnerID
    if (!userID) { response.writeHead(500); response.end('Owner missing.'); return }
    json(response, { url: `/api/applications/${id}/resume?token=${encodeURIComponent(mintResumeLink(id, userID, applicationSessionTokens.owner, Date.now() - 301_000))}` })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/audit-noise') {
    void (async () => { for (let index = 0; index < 201; index += 1) await payload.create({ collection: 'audit-events', data: { event: 'e2e.unrelated', detail: { index } }, overrideAccess: true }) })()
      .then(() => { response.writeHead(204); response.end() })
      .catch(() => { response.writeHead(500); response.end('Unable to create audit noise.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/schedule-page') {
    void Promise.all([
      payload.find({ collection: 'publish-snapshots', limit: 1, depth: 0, overrideAccess: true }),
      payload.find({ collection: 'change-sets', limit: 1, depth: 0, overrideAccess: true }),
    ]).then(async ([snapshots, sets]) => {
      if (!snapshots.docs[0] || !sets.docs[0]) throw new Error('Schedule fixture dependencies are missing.')
      const source = snapshots.docs[0] as { manifest: Record<string, unknown>; themeVersion: string; engineVersion: string; contractVersion: string; approvedBy: string; baselineSnapshot?: string; baselineSequence?: number }
      for (let index = 0; index < 26; index += 1) {
        const snapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: createHash('sha256').update(`e2e-page-${index}`).digest('hex'), changeSet: sets.docs[0].id, reviewRevision: 1, changeHash: `e2e-page-${index}`, manifest: source.manifest, themeVersion: source.themeVersion, engineVersion: source.engineVersion, contractVersion: source.contractVersion, approvedBy: source.approvedBy, baselineSnapshot: source.baselineSnapshot, baselineSequence: source.baselineSequence ?? 0 }, overrideAccess: true, context: { editorialInternal: true } })
        await payload.create({ collection: 'scheduled-publications', data: { idempotencyKey: `e2e-page-${index}`, snapshot: snapshot.id, changeSet: sets.docs[0].id, scheduledFor: `2099-01-01T00:${String(index).padStart(2, '0')}:00.000Z`, state: 'scheduled', proof: {} }, overrideAccess: true, context: { editorialInternal: true } })
      }
      json(response, { seeded: 26 })
    }).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to seed schedules.') })
    return
  }
  // The public contact artifact is served under the same synthetic TLS origin
  // as CMS, just as the production edge routes public pages and /api together.
  // This makes the browser exercise the real Astro form, not a CMS preview.
  const pathname = new URL(request.url || '/', cmsOrigin).pathname
  const staticPath = pathname === '/general/gallery' || pathname === '/general/gallery/'
    ? join(process.cwd(), '..', 'site', 'dist', 'general', 'gallery', 'index.html')
    : pathname === '/careers/synthetic-application-engineer' || pathname === '/careers/synthetic-application-engineer/'
      ? join(process.cwd(), '..', 'site', 'dist', 'careers', 'synthetic-application-engineer', 'index.html')
      : pathname === '/on-page-review/review-target' || pathname === '/on-page-review/review-target/'
        ? join(process.cwd(), '..', 'site', 'dist', 'on-page-review', 'review-target', 'index.html')
      : pathname === '/application-form.js' ? join(process.cwd(), '..', 'site', 'dist', 'application-form.js')
    : pathname.startsWith('/_astro/') ? join(process.cwd(), '..', 'site', 'dist', pathname) : undefined
  if (request.method === 'GET' && staticPath && existsSync(staticPath)) {
    if (staticPath.endsWith('.html') && (pathname === '/on-page-review/review-target' || pathname === '/on-page-review/review-target/')) {
      void pageReviewEntry(new Request(`${cmsOrigin}/api/editorial/page-review-entry`, { headers: { cookie: String(request.headers.cookie ?? ''), 'x-original-uri': request.url ?? pathname } })).then((guard) => {
        const setID = guard.headers.get('x-page-review-set')
        const source = readFileSync(staticPath, 'utf8')
        const body = guard.status === 200 && setID ? source.replace('</body>', `<script defer src="/api/editorial/page-review-bootstrap" data-page-review-set="${setID}"></script></body>`) : source
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': guard.status === 200 ? 'private, no-store' : 'no-cache',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'",
        })
        response.end(body)
      }).catch(() => { response.writeHead(502, { 'cache-control': 'no-store' }); response.end() })
      return
    }
    response.writeHead(200, { 'content-type': staticPath.endsWith('.html') ? 'text/html; charset=utf-8' : staticPath.endsWith('.css') ? 'text/css' : 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
    response.end(readFileSync(staticPath))
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/local-owner/disable') {
    void payload.update({ collection: 'users', id: localOwnerID!, data: { disabled: true }, overrideAccess: true })
      .then(() => { response.writeHead(204); response.end() })
      .catch(() => { response.writeHead(500); response.end('Unable to disable local owner.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/application-owner/disable') {
    void payload.update({ collection: 'users', id: applicationOwnerID!, data: { disabled: true }, overrideAccess: true })
      .then(() => { response.writeHead(204); response.end() })
      .catch(() => { response.writeHead(500); response.end('Unable to disable application owner.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/review-owner/disable') {
    void payload.update({ collection: 'users', id: reviewOwnerID!, data: { disabled: true }, overrideAccess: true })
      .then(() => { response.writeHead(204); response.end() })
      .catch(() => { response.writeHead(500); response.end('Unable to disable review owner.') })
    return
  }
  if (request.method === 'GET' && request.url === '/__e2e/publish-state') {
    void Promise.all([
      payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 0, overrideAccess: true }),
      payload.count({ collection: 'published-releases', overrideAccess: true }),
    ]).then(([outbox, releases]) => json(response, { outbox: outbox.docs[0] ? { id: outbox.docs[0].id, status: outbox.docs[0].status } : null, releaseCount: releases.totalDocs }))
      .catch(() => { response.writeHead(500); response.end('Unable to read publish state.') })
    return
  }
  const upstream = requestUpstream({
    hostname: '127.0.0.1', port: e2ePort + 2, method: request.method, path: request.url,
    headers: { ...request.headers, host: `127.0.0.1:${e2ePort}`, 'x-forwarded-host': `127.0.0.1:${e2ePort}`, 'x-forwarded-proto': 'https' },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(response)
  })
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('CMS is starting.') })
  request.pipe(upstream)
}

async function stop(code = 0): Promise<void> {
  if (stopping) return
  stopping = true
  next?.kill('SIGTERM')
  issuer?.close()
  cmsProxy?.close()
  readiness?.close()
  await payload?.destroy()
  rmSync(temporaryDirectory, { recursive: true, force: true })
  process.exit(code)
}

function runNext(args: string[], keepRunning = false): Promise<ChildProcess> {
  const child = spawn('corepack', ['pnpm@12.8.1', '--filter', '@site-engine/cms', 'exec', 'next', ...args], { cwd: process.cwd(), env: { ...process.env, NODE_EXTRA_CA_CERTS: caCertificate }, stdio: 'inherit' })
  if (keepRunning) return Promise.resolve(child)
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (status) => status === 0 ? resolve(child) : reject(new Error(`Next command exited with ${status ?? 'no'} status.`)))
  })
}

async function main(): Promise<void> {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  jwk = await exportJWK(pair.publicKey)
  createCertificates()
  issuer = createServer({ key: readFileSync(serverKey), cert: readFileSync(serverCertificate) }, (request, response) => { void provider(request, response).catch(() => html(response, 'Synthetic provider failed.', 500)) })
  issuer.listen(e2ePort + 1, '127.0.0.1')
  await once(issuer, 'listening')
  cmsProxy = createServer({ key: readFileSync(serverKey), cert: readFileSync(serverCertificate) }, forwardCMS)
  cmsProxy.listen(e2ePort, '127.0.0.1')
  await once(cmsProxy, 'listening')
  await seed()
  await runAstroBuild()
  // Production deployments use Webpack. Keep the default fast, but let the
  // browser suite exercise the same standalone artifact before release.
  await runNext(process.env.CMS_E2E_WEBPACK === '1' ? ['build', '--webpack'] : ['build'])
  const appDirectory = process.cwd()
  const standaloneDirectory = join(appDirectory, '.next', 'standalone', 'apps', 'cms')
  // Next's standalone output deliberately omits static/public files; production
  // image assembly copies these too. Do the same here so the browser validates
  // the hydrated Payload admin rather than an empty HTML shell.
  cpSync(join(appDirectory, '.next', 'static'), join(standaloneDirectory, '.next', 'static'), { recursive: true })
  if (existsSync(join(appDirectory, 'public'))) cpSync(join(appDirectory, 'public'), join(standaloneDirectory, 'public'), { recursive: true })
  next = spawn(process.execPath, [join(standaloneDirectory, 'server.js')], {
    cwd: process.cwd(),
    env: { ...process.env, HOSTNAME: '127.0.0.1', NODE_EXTRA_CA_CERTS: caCertificate, PORT: String(e2ePort + 2) },
    stdio: 'inherit',
  })
  next.once('exit', (status) => { if (!stopping) void stop(status ?? 1) })
  await new Promise<void>((resolve, reject) => {
    const retry = () => Date.now() > deadline ? reject(new Error('CMS standalone server did not become ready.')) : setTimeout(check, 100)
    const deadline = Date.now() + 30_000
    const check = () => {
      const probe = requestUpstream({ hostname: '127.0.0.1', port: e2ePort + 2, path: '/api/health' }, (response) => { response.resume(); response.statusCode === 200 ? resolve() : retry() })
      probe.once('error', retry).end()
    }
    check()
  })
  readiness = createHTTPServer((_request, response) => { response.writeHead(200); response.end('ready') })
  readiness.listen(e2ePort + 3, '127.0.0.1')
  await once(readiness, 'listening')
}

function runAstroBuild(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('corepack', ['pnpm@12.8.1', '--filter', '@site-engine/site', 'build'], { cwd: process.cwd(), env: { ...process.env, SITE_PUBLIC_ORIGIN: cmsOrigin, SITE_SNAPSHOT_PATH: initialPreviewBaseline, SITE_PUBLIC_DEMO: 'false' }, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (status) => status === 0 ? resolve() : reject(new Error(`Astro build exited with ${status ?? 'no'} status.`)))
  })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stop() })
void main().catch((error) => { console.error(error instanceof Error ? error.message : 'Unable to start synthetic CMS identity server.'); void stop(1) })
