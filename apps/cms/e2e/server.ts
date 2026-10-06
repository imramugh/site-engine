import { createServer as createHTTPServer, request as requestUpstream, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { createServer as createSMTPServer } from 'node:net'
import { once } from 'node:events'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { getPayload } from 'payload'
import { createClient, type Client } from '@libsql/client'
import sharp from 'sharp'
import { neutralFixture } from '@site-engine/contract/fixtures'
import { hashOpaqueToken } from '../src/identity.js'
import { withPayloadTransaction } from '../src/auth-transaction.js'
import { claimPreviewRenderJob, completePreviewRenderJob, failPreviewRenderJob } from '../src/review-preview.js'
import { buildCandidate, canonicalHash, claimNextPublishJob, completePublishJob, recordPublishStage, renewPublishLease, retryPublishJob, type VerifiedArtifact } from '../src/publishing.js'
import { runReviewQuality } from '../src/review-quality.js'
import { deriveRoutes } from '@site-engine/engine'
import { parseThemeRegistry } from '@site-engine/engine/theme-registry'
import { runPreviewOnce } from '../../site/scripts/run-preview-worker.mjs'
import { buildSnapshot } from '../../site/scripts/build-snapshot.mjs'
import { encryptSecret, recoveryHash } from '../src/totp.js'
import { mintResumeLink } from '../src/resume-links.js'
import { appendMatchedInbound } from '../src/mail-inbound.js'
import { prepareReply } from '../src/mail-replies.js'
import { mediaFilePath } from '../src/media.js'
import { createRequire } from 'node:module'
import { createPublishWebhookServer } from '../../site/scripts/run-publish-webhook-receiver.mjs'
import { dispatchPublishOnce } from '../../site/scripts/run-publish-dispatcher.mjs'
import { runPublishOnce, validatePublishClaim } from '../../site/scripts/run-publish-worker.mjs'
import { createPublicServer } from '../../site/scripts/public-server.mjs'

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
const reviewOwnerReauthenticationCode = 'synthetic-review-owner-code-10'
const leadOwnerEmail = 'lead-owner.synthetic@example.test'
const leadOwnerRecoveryCode = 'synthetic-lead-owner-code-07'
const leadSessionTokens = { owner: 'synthetic-lead-owner-session-token', editor: 'synthetic-lead-editor-session-token' } as const
const staleLeadOwnerSessionToken = 'synthetic-lead-stale-owner-session-token'
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
const retentionLedger = join(temporaryDirectory, 'deletions.ndjson')
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
const publishArtifacts = join(temporaryDirectory, 'eng010-publish-artifacts')
const publishReleases = join(temporaryDirectory, 'eng010-publish-releases')
const publishSecret = 'synthetic-eng010-webhook-secret-at-least-32-bytes'
const browserThemeManifest = { name: 'browser-theme', version: '2.4.6', contract: '1.4.0', entry: './dist/renderer.js', standardBlocks: ['hero', 'faq', 'contact', 'richText'], settingKeys: ['tone'], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } }
const navigationThemeManifest = { ...browserThemeManifest, name: 'navigation-browser-theme', version: '1.6.0', contract: '1.6.0', settingKeys: [] }
const searchThemeManifest = { ...browserThemeManifest, name: 'search-browser-theme', version: '1.7.0', contract: '1.7.0', settingKeys: [] }
const incompatibleBrowserThemeManifest = { name: 'incomplete-browser-theme', version: '1.0.0', contract: '1.0.0', entry: './dist/renderer.js', standardBlocks: ['hero'], settingKeys: [], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } }
const galleryTheme = process.env.BLOCK_GALLERY_E2E_THEME_ID && process.env.BLOCK_GALLERY_E2E_THEME_VERSION ? { name: process.env.BLOCK_GALLERY_E2E_THEME_ID, version: process.env.BLOCK_GALLERY_E2E_THEME_VERSION, contract: '1.4.0', entry: './dist/renderer.js', standardBlocks: ['hero', 'incidentBar', 'pillarGrid', 'featureGrid', 'splitList', 'chipList', 'testimonials', 'faq', 'callout', 'relatedServices', 'cta', 'richText', 'contact', 'media', 'imageText', 'gallery', 'logoStrip', 'video'], settingKeys: [], extensionBlocks: [], motion: { presets: [], intentFallbacks: {} } } : undefined
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value) ?? 'null'
const themeInstalls = [
  { manifest: browserThemeManifest, installedAt: '2026-10-03T00:00:00.000Z' },
  { manifest: navigationThemeManifest, installedAt: '2026-10-06T00:00:00.000Z' },
  { manifest: searchThemeManifest, installedAt: '2026-10-06T00:00:00.000Z' },
  { manifest: incompatibleBrowserThemeManifest, installedAt: '2026-10-03T00:00:00.000Z' },
  ...(galleryTheme ? [{ manifest: galleryTheme, installedAt: '2026-10-05T00:00:00.000Z' }] : []),
]
writeFileSync(bootstrapPath, 'synthetic-browser-bootstrap-token')
writeFileSync(themeRegistry, JSON.stringify({ themes: themeInstalls }))
const previewThemeRegistry = parseThemeRegistry({ themes: themeInstalls })
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
writeFileSync(retentionLedger, ''); chmodSync(retentionLedger, 0o600)
process.env.RETENTION_TOMBSTONES_FILE = retentionLedger
process.env.PAYLOAD_SECRET = 'synthetic-browser-payload-secret-not-for-production'
process.env.PAYLOAD_PUBLIC_SERVER_URL = cmsOrigin
process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE = bootstrapPath
process.env.SITE_THEME_REGISTRY_JSON = themeRegistry
process.env.OIDC_GOOGLE_ISSUER_URL = issuerOrigin
process.env.OIDC_GOOGLE_CLIENT_ID = clientID
process.env.OIDC_GOOGLE_CLIENT_SECRET = clientSecret
process.env.EMERGENCY_TOTP_ENCRYPTION_KEY = randomBytes(32).toString('base64url')
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64url')
process.env.MAILBOX_GOOGLE_CLIENT_ID = 'synthetic-mailbox-google-client'
process.env.MAILBOX_GOOGLE_CLIENT_SECRET = 'synthetic-mailbox-google-secret'
process.env.INITIAL_PUBLISH_BASELINE_FILE = initialPreviewBaseline
process.env.PREVIEW_THEME_VERSION = galleryTheme?.version ?? '1.0.0'
process.env.PREVIEW_ENGINE_VERSION = '1.0.0'
process.env.PREVIEW_CONTRACT_VERSION = initialBaseline.settings.contractVersion
process.env.PREVIEW_WORKER_TOKEN = 'synthetic-preview-worker-token-long-enough-for-browser-tests'
process.env.MAIL_TEST_SMTP_LOOPBACK = '1'
const { GET: previewSession } = await import('../app/api/auth/preview/review-session/route.js')
const { GET: pageReviewEntry } = await import('../app/api/editorial/page-review-entry/route.js')
const replyRoute = await import('../app/api/mail-replies/[target]/[id]/route.js')
const suggestionRoute = await import('../app/api/mail-suggestions/[target]/[id]/route.js')
const { setReplyDeliveryForTest } = await import('../src/mail-replies.js')
const { sendAreaMail } = await import('../src/mailboxes.js')
const { startMailboxOAuth, completeMailboxOAuth } = await import('../src/mailbox-oauth.js')
const standaloneReplyDeliveryLedger = join(temporaryDirectory, 'standalone-mail-reply-deliveries.ndjson')
const standaloneProviderBridge = join(temporaryDirectory, 'standalone-mail-provider-bridge.cjs')
writeFileSync(standaloneReplyDeliveryLedger, '')
writeFileSync(standaloneProviderBridge, `
const { appendFileSync } = require('node:fs')
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  if (url.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'fixture-refreshed-access' })
  if (url.endsWith('/gmail/v1/users/me/profile')) return Response.json({ emailAddress: 'fixture-reply@example.test' })
  if (url.endsWith('/gmail/v1/users/me/settings/sendAs')) return Response.json({ sendAs: [{ sendAsEmail: 'fixture-reply@example.test', verificationStatus: 'accepted' }] })
  if (url.endsWith('/gmail/v1/users/me/messages/send')) {
    const body = JSON.parse(String(init.body || '{}'))
    appendFileSync(process.env.CMS_E2E_MAIL_DELIVERY_LEDGER, JSON.stringify({ threadID: typeof body.threadId === 'string' ? body.threadId : 'fixture-new-thread', mime: Buffer.from(String(body.raw || ''), 'base64url').toString('utf8'), messageID: 'fixture-provider-send' }) + '\\n')
    return Response.json({ id: 'fixture-provider-send', threadId: body.threadId || 'fixture-new-thread' })
  }
  return originalFetch(input, init)
}
`)
if (process.env.NODE_ENV === 'test') setReplyDeliveryForTest(async (service, area, message) => sendAreaMail(service, area, message, async (url, init) => {
  if (url.includes('/token')) return Response.json({ access_token: 'fixture-refreshed-access' })
  if (url.endsWith('/profile')) return Response.json({ emailAddress: 'fixture-reply@example.test' })
  if (url.endsWith('/settings/sendAs')) return Response.json({ sendAs: [{ sendAsEmail: 'fixture-reply@example.test', verificationStatus: 'accepted' }] })
  if (url.endsWith('/messages/send')) {
    const body = JSON.parse(String(init.body)) as { raw?: string; threadId?: string }
    const mime = Buffer.from(String(body.raw ?? ''), 'base64url').toString('utf8')
    appendFileSync(standaloneReplyDeliveryLedger, JSON.stringify({ threadID: typeof body.threadId === 'string' ? body.threadId : 'fixture-new-thread', mime, messageID: 'fixture-provider-send' }) + '\n')
    return Response.json({ id: 'fixture-provider-send', threadId: body.threadId ?? 'fixture-new-thread' })
  }
  throw new Error('unexpected_fixture_provider_request')
}))

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
let leadOwnerID: string | undefined
let applicationOwnerID: string | undefined
let reviewOwnerID: string | undefined
let sqliteLock: Awaited<ReturnType<Client['transaction']>> | undefined
let sqliteLockClient: Client | undefined
let firstEditableLeadID: string | undefined
let firstEditableApplicationID: string | undefined
const mcpBearer = 'synthetic-e2e-mcp-bearer'
let mcpIdentity: { userId: string; sessionId: string } | undefined

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
  if (url.pathname === '/internal/introspect' && request.method === 'POST') {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { token?: string; resource?: string }
    if (request.headers['x-oauth-introspection-secret'] !== 'synthetic-e2e-mcp-secret' || input.token !== mcpBearer || input.resource !== `${cmsOrigin}/mcp` || !mcpIdentity) return json(response, { active: false })
    return json(response, { active: true, clientId: 'synthetic-e2e-mcp-client', resource: input.resource, scopes: ['mcp:leads:read', 'mcp:leads:reply'], userId: mcpIdentity.userId, sessionId: mcpIdentity.sessionId, expiresAt: Math.floor(Date.now() / 1000) + 300 })
  }
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
  const reviewOwner = await payload.create({ collection: 'users', data: { email: reviewOwnerEmail, name: 'Synthetic Review Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash(reviewOwnerRecoveryCode), recoveryHash(reviewOwnerReauthenticationCode)] }, overrideAccess: true })
  reviewOwnerID = String(reviewOwner.id)
  await payload.create({ collection: 'users', data: { email: 'content-owner.synthetic@example.test', name: 'Synthetic Content Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash('synthetic-content-owner-code-05'), recoveryHash('synthetic-intake-owner-code-06'), recoveryHash('synthetic-identity-owner-code-07')] }, overrideAccess: true })
  const leadOwner = await payload.create({ collection: 'users', data: { email: leadOwnerEmail, name: 'Synthetic Lead Owner', roles: ['owner'], emergencyTotpSecret: encryptSecret('JBSWY3DPEHPK3PXP'), emergencyRecoveryHashes: [recoveryHash(leadOwnerRecoveryCode)] }, overrideAccess: true })
  leadOwnerID = String(leadOwner.id)
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
  await payload.create({ collection: 'auth-sessions', data: { tokenHash: hashOpaqueToken(staleLeadOwnerSessionToken), user: leadOwner.id, authenticatedAt: new Date(Date.now() - 60 * 60_000).toISOString(), lastSeenAt: sessionNow, expiresAt: sessionExpiry }, overrideAccess: true })
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
  const operationsSection = currentOperationsManifest.settings.sections.find(section => section.id === operationsPageBefore.sectionId)
  if (!operationsSection) throw new Error('Change-log browser fixture page has no section.')
  const storedOperationsSection = await payload.findByID({ collection: 'sections', id: operationsSection.id, depth: 0, overrideAccess: true }).catch(() => null)
  if (!storedOperationsSection) await payload.create({ collection: 'sections', data: { id: operationsSection.id, name: operationsSection.name, summary: operationsSection.summary, slug: operationsSection.slug, allowedTemplates: operationsSection.allowedTemplates, ...(operationsSection.landingPageId ? { landingPageId: operationsSection.landingPageId } : {}) }, overrideAccess: true, context: { editorialInternal: true } })
  const storedOperationsPage = await payload.findByID({ collection: 'pages', id: operationsPageBefore.id, depth: 0, overrideAccess: true }).catch(() => null)
  if (!storedOperationsPage) await payload.create({ collection: 'pages', data: { ...operationsPageBefore, status: 'draft' }, overrideAccess: true, context: { editorialInternal: true } })
  currentOperationsManifest.pages[0]!.summary = 'A current published summary that the reviewed rollback browser flow restores.'
  await payload.update({ collection: 'pages', id: operationsPageBefore.id, data: { summary: currentOperationsManifest.pages[0]!.summary }, overrideAccess: true, context: { editorialInternal: true } })
  const operationsPublishedSet = await payload.create({ collection: 'change-sets', data: { name: 'Change log current release', actor: operationsOwner.id, state: 'published', revision: 1, changes: [{ collection: 'pages', id: currentOperationsManifest.pages[0]!.id, before: operationsPageBefore, after: currentOperationsManifest.pages[0]!, beforeHash: canonicalHash(operationsPageBefore), afterHash: canonicalHash(currentOperationsManifest.pages[0]!) }] }, overrideAccess: true, context: { editorialInternal: true } })
  const operationsSnapshot = await payload.create({ collection: 'publish-snapshots', data: { contentHash: canonicalHash(currentOperationsManifest), changeSet: operationsPublishedSet.id, reviewRevision: 1, changeHash: canonicalHash(operationsPublishedSet.changes), manifest: currentOperationsManifest, themeVersion: process.env.PREVIEW_THEME_VERSION!, engineVersion: process.env.PREVIEW_ENGINE_VERSION!, contractVersion: process.env.PREVIEW_CONTRACT_VERSION!, approvedBy: operationsOwner.id, baselineSequence: 1 }, overrideAccess: true, context: { editorialInternal: true } })
  const operationsOutbox = await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: 'synthetic-change-log-current-release', sequence: 56, snapshot: operationsSnapshot.id, changeSet: operationsPublishedSet.id, reviewRevision: 1, changeHash: canonicalHash(operationsPublishedSet.changes), includedChangeKeys: [`pages:${currentOperationsManifest.pages[0]!.id}`], status: 'completed', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'published-releases', data: { outbox: operationsOutbox.id, sequence: 56, snapshot: operationsSnapshot.id, activatedAt: new Date().toISOString(), healthEvidence: { status: 'healthy' }, artifact: { digest: 'b'.repeat(64), sourceContentHash: operationsSnapshot.contentHash, themeVersion: process.env.PREVIEW_THEME_VERSION!, engineVersion: process.env.PREVIEW_ENGINE_VERSION!, contractVersion: process.env.PREVIEW_CONTRACT_VERSION!, checks: [{ name: 'synthetic-baseline', status: 'passed' }] } }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'audit-events', data: { event: 'editorial.change_set_approved', actor: operationsOwner.id, detail: { changeSet: operationsPublishedSet.id, snapshot: operationsSnapshot.id } }, overrideAccess: true })

  const submitted = await payload.create({ collection: 'change-sets', data: { name: 'Synthetic pending operational review', state: 'submitted', revision: 1, changes: [] }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'inquiries', data: { email: 'new-lead.synthetic@example.test', message: 'A synthetic new lead.', topic: 'general', sourcePage: '/synthetic', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: 'synthetic-operations-new', stage: 'new', urgent: false }, overrideAccess: true })
  await payload.create({ collection: 'inquiries', data: { email: 'urgent-lead.synthetic@example.test', message: 'A synthetic urgent lead.', topic: 'active-incident', sourcePage: '/synthetic', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: 'synthetic-operations-urgent', stage: 'qualified', urgent: true }, overrideAccess: true })
  const firstEditableLead = await payload.create({ collection: 'inquiries', data: { email: 'notes-a.synthetic@example.test', name: 'First editable lead', message: '<img src=x onerror=alert(1)> remains visible text.', topic: 'project', sourcePage: '/services/a', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-leads-notes-a', stage: 'contacted', urgent: false, notes: 'First lead notes', nextAction: 'Call first lead' }, overrideAccess: true })
  firstEditableLeadID = firstEditableLead.id
  await payload.create({ collection: 'inquiries', data: { email: 'notes-b.synthetic@example.test', name: 'Second editable lead', message: 'A separate lead for controlled form state.', topic: 'partnership', sourcePage: '/services/b', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-leads-notes-b', stage: 'contacted', urgent: false, notes: 'Second lead notes', nextAction: 'Email second lead' }, overrideAccess: true })
  await payload.create({ collection: 'inquiries', data: { email: 'timeline-switch.synthetic@example.test', name: 'Timeline switch lead', message: 'A dedicated unmatched lead for mail timeline isolation.', topic: 'project', sourcePage: '/services/timeline', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-leads-timeline-switch', stage: 'contacted', urgent: false }, overrideAccess: true })
  const mailFixtureMailbox = await payload.create({ collection: 'mailbox-configurations', data: { name: 'Timeline fixture inbox', provider: 'smtp', primaryAddress: 'team@example.test', aliases: [], verifiedAliases: [], host: 'smtp.example.test', port: 587, security: 'starttls', username: 'timeline', encryptedCredential: 'opaque', credentialRevision: 'fixture', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  await payload.create({ collection: 'mail-threads', data: { lead: firstEditableLead.id, mailbox: mailFixtureMailbox.id, provider: 'microsoft', providerConversationID: 'fixture-matched-conversation' }, overrideAccess: true })
  const matchedInbound = { mailbox: String(mailFixtureMailbox.id), provider: 'microsoft' as const, conversationID: 'fixture-matched-conversation', messageID: 'fixture-matched-message', sender: 'notes-a.synthetic@example.test', recipient: 'team@example.test', subject: 'Persisted matched reply', body: '<script>window.bad = true</script>Persisted inbound timeline body', receivedAt: '2026-10-05T12:00:00.000Z', attachmentMetadata: [{ name: 'cv.pdf', contentType: 'application/pdf', size: 12, providerAttachmentID: 'fixture-attachment' }] }
  const inboundResult = await appendMatchedInbound(payload, matchedInbound)
  if (!inboundResult.matched || inboundResult.duplicate) throw new Error('Failed to seed the matched inbound timeline fixture.')
  const unrelatedResult = await appendMatchedInbound(payload, { ...matchedInbound, conversationID: 'fixture-unrelated-conversation', messageID: 'fixture-unrelated-message' })
  if (unrelatedResult.matched) throw new Error('An unrelated same-address conversation was incorrectly associated.')
  const replyFixtureMailbox = await payload.create({ collection: 'mailbox-configurations', data: { name: 'Reply fixture OAuth mailbox', provider: 'google', primaryAddress: 'reply@example.test', aliases: [], verifiedAliases: [], host: 'oauth', port: 1, security: 'tls', username: 'reply@example.test', encryptedCredential: 'opaque', credentialRevision: 'fixture-reply', health: 'connected' }, overrideAccess: true, context: { mailboxInternal: true } })
  await payload.create({ collection: 'mailbox-area-mappings', data: { area: 'leads', mailbox: replyFixtureMailbox.id, senderAddress: 'reply@example.test' }, overrideAccess: true, context: { mailboxInternal: true } })
  for (const [conversation, subject] of [['fixture-reply-a', 'Fixture reply A'], ['fixture-reply-b', 'Fixture reply B']] as const) {
    const thread = await payload.create({ collection: 'mail-threads', data: { lead: firstEditableLead.id, mailbox: replyFixtureMailbox.id, provider: 'google', providerConversationID: conversation }, overrideAccess: true })
    await payload.create({ collection: 'mail-thread-messages', data: { thread: thread.id, mailbox: replyFixtureMailbox.id, lead: firstEditableLead.id, providerMessageID: `${conversation}-message`, rfcMessageID: `<${conversation}@example.test>`, direction: 'inbound', sender: firstEditableLead.email, recipient: 'reply@example.test', subject, body: 'Fixture provider correspondence.', receivedAt: new Date().toISOString(), attachmentMetadata: [] }, overrideAccess: true })
  }
  const archivedLead = await payload.create({ collection: 'inquiries', data: { email: 'archived-lead.synthetic@example.test', name: 'Archived lead', message: 'A lead outside the default received range.', topic: 'general', sourcePage: '/archive', consentedAt: '2025-01-01T00:00:00.000Z', consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-leads-archived', stage: 'new', urgent: false }, overrideAccess: true })
  await payload.update({ collection: 'inquiries', id: archivedLead.id, data: { createdAt: '2025-01-01T00:00:00.000Z' }, overrideAccess: true })
  await payload.create({ collection: 'inquiries', data: { email: 'restore-spam.synthetic@example.test', name: 'Restore spam fixture', message: 'A persisted spam submission that can be restored.', topic: 'general', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-leads-spam-restore', stage: 'qualified', spam: true, spamMarkedAt: new Date().toISOString(), spamPreviousStage: 'qualified', urgent: false }, overrideAccess: true })
  await payload.create({ collection: 'inquiries', data: { email: 'delete-spam.synthetic@example.test', name: 'Delete spam fixture', message: 'A persisted spam submission that can be permanently deleted.', topic: 'general', sourcePage: '/contact', consentedAt: new Date().toISOString(), consentBasis: 'visitor-confirmed', idempotencyKey: 'synthetic-leads-spam-delete', stage: 'new', spam: true, spamMarkedAt: new Date().toISOString(), spamPreviousStage: 'new', urgent: false }, overrideAccess: true })
  for (let index = 0; index < 51; index += 1) await payload.create({ collection: 'inquiries', data: { email: `proposal-${index}@synthetic.example.test`, message: `Synthetic proposal lead ${index}.`, topic: 'project', sourcePage: '/proposal-fixture', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: `synthetic-leads-proposal-${index}`, stage: 'proposal', urgent: false }, overrideAccess: true })
  const firstEditableApplication = await payload.create({ collection: 'applications', data: { name: 'Synthetic candidate', email: 'candidate.synthetic@example.test', coverLetter: 'Synthetic application for role-scoped badge verification.', consent: true, jobId: 'synthetic-role', resumeKey: `${randomUUID()}-${'a'.repeat(64)}`, idempotencyKey: 'synthetic-application-new', status: 'new' }, overrideAccess: true })
  firstEditableApplicationID = firstEditableApplication.id
  await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: 'synthetic-operations-pending', sequence: 2, snapshot: snapshot.id, changeSet: submitted.id, reviewRevision: 1, changeHash: 'synthetic-operations-pending', includedChangeKeys: [], status: 'pending', attempts: 0, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: 'synthetic-operations-processing', sequence: 3, snapshot: snapshot.id, changeSet: submitted.id, reviewRevision: 1, changeHash: 'synthetic-operations-processing', includedChangeKeys: [], status: 'processing', attempts: 1, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: 'synthetic-operations-failed', sequence: 4, snapshot: snapshot.id, changeSet: submitted.id, reviewRevision: 1, changeHash: 'synthetic-operations-failed', includedChangeKeys: [], status: 'failed', attempts: 2, errorCode: 'synthetic_publish_failure', lastError: 'Synthetic failure detail.', correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  for (let sequence = 5; sequence <= 55; sequence += 1) await payload.create({ collection: 'publish-outbox', data: { idempotencyKey: `synthetic-operations-pending-${sequence}`, sequence, snapshot: snapshot.id, changeSet: submitted.id, reviewRevision: 1, changeHash: `synthetic-operations-pending-${sequence}`, includedChangeKeys: [], status: 'pending', attempts: 0, correlationID: randomUUID() }, overrideAccess: true, context: { editorialInternal: true } })
  for (let index = 0; index < 26; index += 1) await payload.create({ collection: 'audit-events', data: { event: 'operations.fixture.page', actor: operationsOwner.id, detail: { index } }, overrideAccess: true })
  await payload.create({ collection: 'audit-events', data: { event: 'inquiry.created', actor: operationsOwner.id, detail: { email: 'never-expose@example.test', message: 'Never expose this lead text.', resumeKey: 'private-resume-key' } }, overrideAccess: true })
}

function forwardCMS(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === 'GET' && request.url === '/__e2e/mail-reply-deliveries') {
    const deliveries = readFileSync(standaloneReplyDeliveryLedger, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { threadID: string | null; mime: string; messageID: string })
    json(response, { deliveries }); return
  }
  if (request.method === 'POST' && (request.url ?? '').split('?')[0] === '/__e2e/mail-reply-attachment-state') {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { action?: unknown; assetID?: unknown; grantID?: unknown }
      if (body.action === 'mutate-asset' || body.action === 'delete-asset') {
        if (typeof body.assetID !== 'string') throw new Error('missing_asset')
        const asset = await payload.findByID({ collection: 'assets', id: body.assetID, depth: 0, overrideAccess: true }) as { currentFile?: { filename?: unknown }; filename?: unknown }
        if (body.action === 'mutate-asset') writeFileSync(mediaFilePath(String(asset.currentFile?.filename ?? asset.filename)), Buffer.from('mutated after human confirmation'))
        else await payload.update({ collection: 'assets', id: body.assetID, data: { deletedAt: new Date().toISOString(), deleteAfter: new Date(Date.now() + 60_000).toISOString() }, overrideAccess: true, context: { mediaLifecycle: 'bin' } })
      } else if (body.action === 'revoke-role') await payload.update({ collection: 'users', id: leadOwnerID!, data: { roles: ['editor'] }, overrideAccess: true })
      else if (body.action === 'restore-role') await payload.update({ collection: 'users', id: leadOwnerID!, data: { roles: ['owner'] }, overrideAccess: true })
      else if (body.action !== 'grant-state') throw new Error('invalid_attachment_fixture_action')
      const grant = typeof body.grantID === 'string' ? await payload.findByID({ collection: 'mail-authorizations', id: body.grantID, depth: 0, overrideAccess: true }) : undefined
      json(response, { ...(grant ? { grant: { consumedAt: grant.consumedAt, revokedAt: grant.revokedAt } } : {}) })
    })().catch(() => { response.writeHead(500); response.end() })
    return
  }
  if (request.method === 'POST' && (request.url ?? '').split('?')[0] === '/__e2e/mail-reply-fixture') {
    void (async () => {
      const state = new URL(await startMailboxOAuth(payload, 'google', localOwnerID!, leadSessionTokens.owner)).searchParams.get('state')!
      const mailbox = await completeMailboxOAuth(payload, 'google', state, 'fixture-code', localOwnerID!, leadSessionTokens.owner, async (url) => url.includes('/token') ? Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' }) : url.endsWith('/profile') ? Response.json({ emailAddress: 'fixture-reply@example.test' }) : Response.json({ sendAs: [{ sendAsEmail: 'fixture-reply@example.test', verificationStatus: 'accepted' }] }))
      const mapping = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: 'leads' } }, limit: 1, depth: 0, overrideAccess: true })
      if (mapping.docs[0]) await payload.update({ collection: 'mailbox-area-mappings', id: mapping.docs[0].id, data: { mailbox: mailbox.id, senderAddress: 'fixture-reply@example.test' }, overrideAccess: true, context: { mailboxInternal: true } })
      else await payload.create({ collection: 'mailbox-area-mappings', data: { area: 'leads', mailbox: mailbox.id, senderAddress: 'fixture-reply@example.test' }, overrideAccess: true, context: { mailboxInternal: true } })
      for (const [conversationID, messageID, rfcMessageID, subject] of [
        ['fixture-oauth-thread-a', 'fixture-oauth-message-a', '<fixture-oauth-a@example.test>', 'Fixture OAuth reply A'],
        ['fixture-oauth-thread-b', 'fixture-oauth-message-b', '<fixture-oauth-b@example.test>', 'Fixture OAuth reply B'],
      ]) {
        const thread = await payload.create({ collection: 'mail-threads', data: { lead: firstEditableLeadID!, mailbox: mailbox.id, provider: 'google', providerConversationID: conversationID }, overrideAccess: true })
        await payload.create({ collection: 'mail-thread-messages', data: { thread: thread.id, mailbox: mailbox.id, lead: firstEditableLeadID!, providerMessageID: messageID, rfcMessageID, direction: 'inbound', sender: 'notes-a.synthetic@example.test', recipient: 'fixture-reply@example.test', subject, body: 'Fixture OAuth correspondence.', receivedAt: new Date().toISOString(), attachmentMetadata: [] }, overrideAccess: true })
      }
      const applicationThread = await payload.create({ collection: 'mail-threads', data: { application: firstEditableApplicationID!, mailbox: mailbox.id, provider: 'google', providerConversationID: 'fixture-oauth-application-thread' }, overrideAccess: true })
      await payload.create({ collection: 'mail-thread-messages', data: { thread: applicationThread.id, mailbox: mailbox.id, application: firstEditableApplicationID!, providerMessageID: 'fixture-oauth-application-message', rfcMessageID: '<fixture-oauth-application@example.test>', direction: 'inbound', sender: 'candidate.synthetic@example.test', recipient: 'fixture-reply@example.test', subject: 'Fixture hiring reply', body: 'Fixture hiring correspondence.', receivedAt: new Date().toISOString(), attachmentMetadata: [] }, overrideAccess: true })
      const adoptionLead = await payload.create({ collection: 'inquiries', data: { name: `Suggestion adoption ${mailbox.id}`, email: `suggestion-${mailbox.id}@example.test`, message: 'Dedicated suggestion fixture.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: `suggestion-${mailbox.id}`, stage: 'new' }, overrideAccess: true })
      await appendMatchedInbound(payload, { mailbox: String(mailbox.id), provider: 'google', conversationID: `fixture-unmatched-${mailbox.id}`, messageID: `fixture-unmatched-message-${mailbox.id}`, sender: String(adoptionLead.email), recipient: 'fixture-reply@example.test', subject: 'Hidden unmatched subject', body: 'Hidden unmatched body', receivedAt: new Date().toISOString() })
      const careersMapping = await payload.find({ collection: 'mailbox-area-mappings', where: { area: { equals: 'careers' } }, limit: 1, depth: 0, overrideAccess: true })
      if (careersMapping.docs[0]) await payload.update({ collection: 'mailbox-area-mappings', id: careersMapping.docs[0].id, data: { mailbox: mailbox.id, senderAddress: 'fixture-reply@example.test' }, overrideAccess: true, context: { mailboxInternal: true } })
      else await payload.create({ collection: 'mailbox-area-mappings', data: { area: 'careers', mailbox: mailbox.id, senderAddress: 'fixture-reply@example.test' }, overrideAccess: true, context: { mailboxInternal: true } })
      const fixtureURL = new URL(`https://fixture.test${request.url}`)
      const prepared = fixtureURL.searchParams.get('prepared') === '1'
      const deep = fixtureURL.searchParams.get('deep') === '1'
      const withAttachment = fixtureURL.searchParams.get('attachment') === '1'
      const deepLead = deep ? await payload.create({ collection: 'inquiries', data: { name: 'Deep linked assistant lead', email: `deep-link-${mailbox.id}@example.test`, message: 'A direct confirmation target that is outside the first lead page.', topic: 'general', sourcePage: '/', consentedAt: new Date().toISOString(), consentBasis: 'staff-recorded', idempotencyKey: `deep-link-${mailbox.id}`, stage: 'new' }, overrideAccess: true }) : undefined
      if (deepLead) await payload.update({ collection: 'inquiries', id: deepLead.id, data: { createdAt: '2025-01-01T00:00:00.000Z' }, overrideAccess: true })
      const preparedTarget = deepLead?.id ?? firstEditableLeadID!
      const preparedDraft = prepared ? await prepareReply(payload, 'lead', preparedTarget, leadOwnerID!, { sender: 'fixture-reply@example.test', subject: 'Fixture OAuth reply B', body: 'MCP prepared exact body', threadID: 'fixture-oauth-thread-b' }, { clientIDHash: 'a'.repeat(64), actorID: leadOwnerID!, oauthSessionID: 'fixture-assistant-origin-session' }) : undefined
      const attachmentBytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#2563eb' } }).png().toBuffer()
      const attachmentOwner = withAttachment ? await payload.findByID({ collection: 'users', id: leadOwnerID!, depth: 0, overrideAccess: true }) : undefined
      const attachment = withAttachment ? await payload.create({ collection: 'assets', data: { alt: 'Synthetic SDK reply attachment' }, file: { data: attachmentBytes, mimetype: 'image/png', name: 'sdk-reply-attachment.png', size: attachmentBytes.length }, user: attachmentOwner, overrideAccess: false }) : undefined
      const attachmentDescriptor = attachment ? { source: 'asset' as const, sourceID: String(attachment.id), filename: 'sdk-reply-attachment.png', mimeType: 'image/png', size: attachmentBytes.length, sha256: createHash('sha256').update(attachmentBytes).digest('hex') } : undefined
      json(response, { mailbox: mailbox.id, thread: 'fixture-oauth-thread-b', application: firstEditableApplicationID, applicationName: 'Synthetic candidate', adoptionLead: adoptionLead.id, adoptionLeadName: adoptionLead.name, ...(deepLead ? { deepLead: deepLead.id, deepLeadName: deepLead.name } : {}), ...(preparedDraft ? { preparedDraft: preparedDraft.id } : {}), ...(attachmentDescriptor ? { attachment: { ...attachmentDescriptor, bytes: attachmentBytes.toString('base64') } } : {}) })
    })().catch(() => { response.writeHead(500); response.end() })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/mcp-identity') {
    void (async () => { const session = await payload.create({ collection: 'auth-sessions', data: { tokenHash: `mcp-origin-${randomUUID()}`, user: leadOwnerID!, authenticatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() }, overrideAccess: true }); mcpIdentity = { userId: leadOwnerID!, sessionId: String(session.id) }; json(response, { bearer: mcpBearer }) })().catch(() => { response.writeHead(500); response.end() }); return
  }
  const replyMatch = /^\/api\/(mail-replies|mail-suggestions)\/(lead|application)\/([0-9a-f-]{36})$/i.exec((request.url ?? '').split('?')[0]!)
  if (replyMatch && (request.method === 'GET' || request.method === 'POST')) {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const method = request.method!
      const route = replyMatch[1] === 'mail-suggestions' ? suggestionRoute : replyRoute
      const handler = method === 'GET' ? route.GET : route.POST
      const result = await handler(new Request(`${cmsOrigin}${request.url}`, { method, headers: request.headers as HeadersInit, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }), { params: Promise.resolve({ target: replyMatch[2]!, id: replyMatch[3]! }) })
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
      response.end(Buffer.from(await result.arrayBuffer()))
    })().catch(() => { response.writeHead(500); response.end() })
    return
  }
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
      await runPreviewOnce({ api, artifactRoot: previewArtifacts, publicOrigin: cmsOrigin, versionPins: pins, registry: previewThemeRegistry, heartbeatMs: 60_000, signal: undefined })
      return payload.findByID({ collection: 'preview-render-jobs', id: job.id, depth: 0, overrideAccess: true })
    })().then((job) => json(response, { id: job.id, status: job.status })).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to complete preview.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/warning-only-review') {
    void (async () => {
      const releases = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true })
      const release = releases.docs[0] as unknown as { id?: string; sequence?: number; snapshot?: Record<string, unknown> } | undefined
      const snapshot = release?.snapshot
      if (!release || !snapshot || typeof snapshot !== 'object' || typeof snapshot.id !== 'string') throw new Error('Published review baseline is missing.')
      const baseline = structuredClone(snapshot.manifest) as Record<string, unknown>
      const source = await payload.findByID({ collection: 'change-sets', id: onPageReviewSetID, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
      const page = (baseline.pages as Array<Record<string, unknown>>).find((item) => item.id === onPageReviewPageID)
      if (!page) throw new Error('Warning-only review page is missing from the published baseline.')
      const before = structuredClone(page)
      const after = structuredClone(page)
      after.blocks = (after.blocks as Array<Record<string, unknown>>).map((block) => String(block.id) === onPageReviewBlockID ? { ...block, body: 'This warning-only preview uses a forbidden synthetic phrase.' } : block)
      const warningPhrase = 'forbidden synthetic phrase'
      const changes = [
        { collection: 'pages', id: onPageReviewPageID, before, after, beforeHash: canonicalHash(before), afterHash: null },
        { collection: 'style-guides', id: randomUUID(), before: baseline.styleGuide ?? null, after: { ...(baseline.styleGuide as Record<string, unknown> | undefined), bannedPhrases: [warningPhrase] }, beforeHash: baseline.styleGuide ? canonicalHash(baseline.styleGuide) : null, afterHash: null },
      ]
      const includedChangeKeys = changes.map((change) => `${change.collection}:${change.id}`)
      const versionPins = { themeVersion: String(snapshot.themeVersion), engineVersion: String(snapshot.engineVersion), contractVersion: String((baseline.settings as { contractVersion: string }).contractVersion) }
      const proposedManifest = buildCandidate(baseline as never, changes as never, includedChangeKeys, versionPins)
      const id = randomUUID(); const jobID = randomUUID(); const changeHash = canonicalHash(changes)
      await payload.create({ collection: 'change-sets', data: { id, name: 'Warning-only readiness review', actor: String(source.actor), state: 'submitted', revision: 1, submittedAt: new Date().toISOString(), changes, preview: { status: 'pending', jobID, revision: 1, changeHash, baselineSnapshotID: snapshot.id, baselineSequence: Number(release.sequence), includedChangeKeys, versionPins } }, overrideAccess: true, context: { editorialInternal: true } })
      await payload.create({ collection: 'preview-render-jobs', data: { id: jobID, changeSet: id, reviewRevision: 1, changeHash, includedChangeKeys, baselineSnapshot: snapshot.id, baselineSequence: Number(release.sequence), liveSnapshot: snapshot.id, liveSequence: Number(release.sequence), liveManifest: baseline, proposedManifest, liveManifestHash: canonicalHash(baseline), proposedManifestHash: canonicalHash(proposedManifest), versionPins, status: 'pending', attempts: 0 }, overrideAccess: true, context: { editorialInternal: true } })
      const job = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req))
      if (!job || String(job.id) !== jobID) throw new Error('Unable to claim warning-only review job.')
      const api = async (action: string, body: Record<string, unknown> = {}) => {
        if (action === 'claim') return { job: { id: job.id, leaseToken: job.leaseToken, leaseExpiresAt: job.leaseExpiresAt }, live: job.liveManifest, proposed: job.proposedManifest, basePaths: { live: 'live', proposed: 'proposed' }, versionPins: job.versionPins }
        if (action === 'renew') return { ok: true }
        if (action === 'complete') return withPayloadTransaction(payload, inner => completePreviewRenderJob(payload, inner, String(body.id), String(body.leaseToken), { liveManifestHash: String(body.liveManifestHash), proposedManifestHash: String(body.proposedManifestHash), artifactDigest: String(body.artifactDigest) }))
        throw new Error('Unsupported warning-only worker action.')
      }
      await runPreviewOnce({ api, artifactRoot: previewArtifacts, publicOrigin: cmsOrigin, versionPins, registry: previewThemeRegistry, heartbeatMs: 60_000, signal: undefined })
      await withPayloadTransaction(payload, req => runReviewQuality({ payload, req, id }))
      return { id }
    })().then((value) => json(response, value)).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to seed warning-only review.') })
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
  const staleFailedPreview = request.method === 'POST' ? /^\/__e2e\/failed-preview-review\/stale-baseline\/([0-9a-f-]{36})$/i.exec(request.url ?? '') : undefined
  if (staleFailedPreview) {
    void (async () => {
      const set = await payload.findByID({ collection: 'change-sets', id: staleFailedPreview[1]!, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
      const preview = set.preview as Record<string, unknown> | undefined
      if (!preview) throw new Error('Failed preview is missing.')
      await payload.update({ collection: 'change-sets', id: String(set.id), data: { preview: { ...preview, baselineSequence: Number(preview.baselineSequence) + 1 } }, overrideAccess: true, context: { editorialInternal: true } })
    })().then(() => { response.writeHead(204); response.end() }).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to stale failed preview.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/failed-preview-review') {
    void (async () => {
      const source = await payload.findByID({ collection: 'change-sets', id: onPageReviewSetID, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
      const releases = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true })
      const release = releases.docs[0] as unknown as { sequence?: number; snapshot?: Record<string, unknown> } | undefined
      const snapshot = release?.snapshot
      if (!release || !snapshot || typeof snapshot.id !== 'string') throw new Error('Published diagnostic baseline is missing.')
      const manifest = structuredClone(snapshot.manifest) as typeof initialBaseline
      const id = randomUUID(); const jobID = randomUUID(); const changes = source.changes as Array<Record<string, unknown>>; const changeHash = canonicalHash(changes)
      const includedChangeKeys = changes.map((change) => `${change.collection}:${change.id}`)
      const versionPins = { themeVersion: String(snapshot.themeVersion), engineVersion: String(snapshot.engineVersion), contractVersion: manifest.settings.contractVersion }
      const manifestHash = canonicalHash(manifest)
      await payload.create({ collection: 'change-sets', data: { id, name: 'Structured data diagnostic review', actor: String(source.actor), state: 'submitted', revision: 1, changes, preview: { status: 'pending', jobID, revision: 1, changeHash, baselineSnapshotID: snapshot.id, baselineSequence: Number(release.sequence), includedChangeKeys, liveManifestHash: manifestHash, proposedManifestHash: manifestHash, versionPins } }, overrideAccess: true, context: { editorialInternal: true } })
      await payload.create({ collection: 'preview-render-jobs', data: { id: jobID, changeSet: id, reviewRevision: 1, changeHash, includedChangeKeys, baselineSnapshot: snapshot.id, baselineSequence: Number(release.sequence), liveSnapshot: snapshot.id, liveSequence: Number(release.sequence), liveManifest: manifest, proposedManifest: manifest, liveManifestHash: manifestHash, proposedManifestHash: manifestHash, versionPins, status: 'pending', attempts: 2 }, overrideAccess: true, context: { editorialInternal: true } })
      const job = await withPayloadTransaction(payload, req => claimPreviewRenderJob(payload, req))
      if (!job || String(job.id) !== jobID) throw new Error('Unable to claim structured-data diagnostic job.')
      const api = async (action: string, body: Record<string, unknown> = {}) => {
        if (action === 'claim') return { job: { id: job.id, leaseToken: job.leaseToken, leaseExpiresAt: job.leaseExpiresAt }, live: job.liveManifest, proposed: job.proposedManifest, basePaths: { live: 'live', proposed: 'proposed' }, versionPins: job.versionPins }
        if (action === 'renew') return { ok: true }
        if (action === 'fail') return withPayloadTransaction(payload, inner => failPreviewRenderJob(payload, inner, String(body.id), String(body.leaseToken), String(body.errorCode), undefined, body.diagnostics))
        throw new Error('Unsupported failed-preview worker action.')
      }
      const components = mkdtempSync(join(temporaryDirectory, 'malformed-structured-data-theme-'))
      try {
        const starterLayout = createRequire(import.meta.url).resolve('@site-engine/theme-starter/components/Layout.astro')
        cpSync(dirname(starterLayout), components, { recursive: true })
        const layout = join(components, 'Layout.astro')
        const source = readFileSync(layout, 'utf8')
        writeFileSync(layout, source.replace("set:html={JSON.stringify(schema).replaceAll('<', '\\\\u003c')}", "set:html={'{'}"))
        const render = (input: Record<string, unknown>) => buildSnapshot({ ...input, themeComponentsRoot: components } as Parameters<typeof buildSnapshot>[0])
        try { await runPreviewOnce({ api, artifactRoot: previewArtifacts, publicOrigin: cmsOrigin, versionPins, registry: previewThemeRegistry, render, heartbeatMs: 60_000, signal: undefined }) }
        catch (error) { if (!(error instanceof Error) || error.message !== 'BUILD_FAILED') throw error }
      } finally {
        rmSync(components, { recursive: true, force: true })
      }
      const failed = await payload.findByID({ collection: 'preview-render-jobs', id: jobID, depth: 0, overrideAccess: true })
      if (failed.status !== 'failed') throw new Error('Structured-data diagnostic job did not fail.')
      return { id, status: failed.status }
    })().then((value) => json(response, value)).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to seed failed preview.') })
    return
  }
  // E2E-only external SQLite fault: the production direct-edit request still
  // performs its normal page update and capture hook, while this trigger aborts
  // the capture's change-set write. It proves transaction rollback without a
  // product-only request header or code path.
  if (request.method === 'POST' && request.url === '/__e2e/fail-change-capture') {
    void (async () => {
      const client = createClient({ url: `file:${databasePath}` })
      try { await client.execute("CREATE TRIGGER e2e_fail_change_capture BEFORE UPDATE ON change_sets BEGIN SELECT RAISE(ABORT, 'e2e capture failure'); END") }
      finally { client.close() }
    })().then(() => { response.writeHead(204); response.end() }).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to install capture fault.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/fail-change-capture/release') {
    void (async () => {
      const client = createClient({ url: `file:${databasePath}` })
      try { await client.execute('DROP TRIGGER IF EXISTS e2e_fail_change_capture') }
      finally { client.close() }
    })().then(() => { response.writeHead(204); response.end() }).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to clear capture fault.') })
    return
  }
  if (request.method === 'GET' && request.url === '/__e2e/direct-edit-state') {
    void Promise.all([
      payload.findByID({ collection: 'pages', id: directEditPageID, draft: true, depth: 0, overrideAccess: true }),
      payload.count({ collection: 'audit-events', overrideAccess: true }),
      payload.count({ collection: 'publish-outbox', overrideAccess: true }),
    ]).then(([page, audit, outbox]) => json(response, { heading: (page.blocks as Array<{ id: string; heading?: string }>).find((block) => block.id === directEditBlockID)?.heading ?? null, audit: audit.totalDocs, outbox: outbox.totalDocs }))
      .catch(() => { response.writeHead(500); response.end('Unable to read direct-edit state.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/sqlite-lock') {
    void (async () => {
      if (sqliteLock) throw new Error('SQLite lock is already held.')
      sqliteLockClient = createClient({ url: `file:${databasePath}` })
      sqliteLock = await sqliteLockClient.transaction('write')
      await sqliteLock.execute({ sql: 'UPDATE pages SET updated_at = updated_at WHERE id = ?', args: [directEditPageID] })
    })().then(() => { response.writeHead(204); response.end() }).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to acquire SQLite lock.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/sqlite-lock/release') {
    void (async () => {
      if (!sqliteLock || !sqliteLockClient) throw new Error('SQLite lock is not held.')
      await sqliteLock.rollback(); sqliteLock = undefined; sqliteLockClient.close(); sqliteLockClient = undefined
    })().then(() => { response.writeHead(204); response.end() }).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to release SQLite lock.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/session/stale') {
    const sessionCookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('site_engine_session=') || part.startsWith('__Host-site_engine_session='))
    const token = sessionCookie?.slice(sessionCookie.indexOf('=') + 1)
    if (!token) { response.writeHead(401); response.end('Session missing.'); return }
    void payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(token) } }, limit: 1, overrideAccess: true })
      .then(({ docs }) => docs[0] ? payload.update({ collection: 'auth-sessions', id: docs[0].id, data: { authenticatedAt: new Date(Date.now() - 16 * 60_000).toISOString() }, overrideAccess: true }) : Promise.reject(new Error('Session missing')))
      .then(() => { response.writeHead(204); response.end() })
      .catch(() => { response.writeHead(500); response.end('Unable to age session.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/session/age-last-seen') {
    const sessionCookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('site_engine_session=') || part.startsWith('__Host-site_engine_session='))
    const token = sessionCookie?.slice(sessionCookie.indexOf('=') + 1)
    if (!token) { response.writeHead(401); response.end('Session missing.'); return }
    void payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(token) } }, limit: 1, overrideAccess: true })
      .then(({ docs }) => docs[0] ? payload.update({ collection: 'auth-sessions', id: docs[0].id, data: { lastSeenAt: new Date(Date.now() - 61_000).toISOString() }, overrideAccess: true }) : Promise.reject(new Error('Session missing')))
      .then(() => { response.writeHead(204); response.end() })
      .catch(() => { response.writeHead(500); response.end('Unable to age session.'); })
    return
  }
  if (request.method === 'GET' && request.url === '/__e2e/session/state') {
    const sessionCookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('site_engine_session=') || part.startsWith('__Host-site_engine_session='))
    const token = sessionCookie?.slice(sessionCookie.indexOf('=') + 1)
    if (!token) { response.writeHead(401); response.end('Session missing.'); return }
    void payload.find({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(token) } }, limit: 1, overrideAccess: true })
      .then(({ docs }) => docs[0] ? json(response, { lastSeenAt: docs[0].lastSeenAt }) : Promise.reject(new Error('Session missing')))
      .catch(() => { response.writeHead(500); response.end('Unable to inspect session.'); })
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
  if (request.method === 'POST' && /^\/__e2e\/eng010-publish\/(success|fail)$/.test(new URL(request.url ?? '/', cmsOrigin).pathname)) {
    void (async () => {
      const fixtureURL = new URL(request.url ?? '/', cmsOrigin)
      const outcome = fixtureURL.pathname.endsWith('/success') ? 'success' : 'fail'; let clock = Date.now()
      const cleanupJobID = fixtureURL.searchParams.get('cleanup')
      const changeSetID = fixtureURL.searchParams.get('changeSet')
      if (!changeSetID) throw new Error('ENG-010 fixture requires the approved change set.')
      const target = await payload.find({ collection: 'publish-outbox', where: { changeSet: { equals: changeSetID } }, sort: '-sequence', limit: 1, depth: 0, overrideAccess: true })
      if (!target.docs[0]) throw new Error('ENG-010 fixture could not find the approved outbox job.')
      const suspended = await payload.find({ collection: 'publish-outbox', where: { and: [{ status: { in: ['pending', 'processing'] } }, { id: { not_equals: target.docs[0].id } }] }, pagination: false, limit: 100, depth: 0, overrideAccess: true })
      await Promise.all(suspended.docs.map(job => payload.update({ collection: 'publish-outbox', id: job.id, data: { status: 'completed', leaseToken: null, leaseExpiresAt: null }, overrideAccess: true, context: { editorialInternal: true } })))
      const api = async (action: string, body: Record<string, unknown> = {}) => withPayloadTransaction(payload, async req => {
        if (action === 'claim') {
          const job = await claimNextPublishJob(payload, req, new Date(clock))
          if (!job) return { job: null }
          const full = await payload.findByID({ collection: 'publish-outbox', id: job.id, depth: 1, overrideAccess: true, req }) as any
          const snapshot = full.snapshot
          return { job: { id: full.id, leaseToken: full.leaseToken, leaseExpiresAt: full.leaseExpiresAt, sequence: full.sequence }, snapshot: snapshot.manifest, contentHash: snapshot.contentHash, versionPins: { themeVersion: snapshot.themeVersion, engineVersion: snapshot.engineVersion, contractVersion: snapshot.contractVersion }, immutableContext: { changeSetID: String(full.changeSet?.id ?? full.changeSet), approvedRevision: full.reviewRevision, includedChangeKeys: full.includedChangeKeys, snapshotID: String(snapshot.id), approvedBy: String(snapshot.approvedBy?.id ?? snapshot.approvedBy), approvedAt: String(snapshot.createdAt) } }
        }
        if (action === 'renew') return { job: await renewPublishLease(payload, req, String(body.id), String(body.leaseToken)) }
        if (action === 'complete') return { job: await completePublishJob(payload, req, String(body.id), String(body.leaseToken), body.artifact as VerifiedArtifact) }
        if (action === 'fail') { clock += 10_000; return { job: await retryPublishJob(payload, req, String(body.id), String(body.leaseToken), String(body.errorCode), new Date(clock)) } }
        if (action === 'log') return { job: await recordPublishStage(payload, req, String(body.id), String(body.leaseToken), String(body.stage)) }
        throw new Error('Unknown ENG-010 fixture action.')
      })
      const claimProbe = await api('claim')
      if (!claimProbe.job || claimProbe.job.id !== target.docs[0].id) throw new Error('ENG-010 fixture did not claim the approved outbox job.')
      if (!claimProbe.versionPins || !claimProbe.immutableContext) throw new Error('ENG-010 fixture claim is incomplete.')
      const claim = claimProbe as { job: { id: string }; contentHash: string; versionPins: { engineVersion: string; contractVersion: string }; immutableContext: { approvedBy: string } }
      const pins = { engineVersion: claim.versionPins.engineVersion, contractVersion: claim.versionPins.contractVersion }
      try { validatePublishClaim(claimProbe, pins) } catch (error) { throw new Error(`ENG010_CLAIM_DIAGNOSTIC ${JSON.stringify({ error: error instanceof Error ? error.message : 'unknown', job: claimProbe.job, contentHash: claimProbe.contentHash, versionPins: claimProbe.versionPins, immutableContext: claimProbe.immutableContext })}`) }
      // Return the probe to the dispatcher once; the real dispatch still signs
      // its HTTP request and the receiver validates the same immutable claim.
      let probed = false; const dispatchAPI = async (action: string, body: Record<string, unknown> = {}) => action === 'claim' && !probed ? (probed = true, claimProbe) : api(action, body)
      const publicServer = createPublicServer({ releasesRoot: publishReleases })
      await new Promise<void>(done => publicServer.listen(0, '127.0.0.1', done)); const publicAddress = publicServer.address() as { port: number }; const publicOrigin = `http://127.0.0.1:${publicAddress.port}`
      const render = outcome === 'fail' ? async () => { throw Object.assign(new Error('synthetic build failure'), { code: 'BUILD_FAILED' }) } : buildSnapshot
      const receiver = createPublishWebhookServer({ secret: publishSecret, run: (claimed: any, signal: AbortSignal) => runPublishOnce({ api, claimed, buildRoot: publishArtifacts, releasesRoot: publishReleases, publicOrigin, versionPins: pins, registry: previewThemeRegistry, render: render as any, indexNowPublisher: async () => ({ sent: false, reason: 'test' }), signal } as any) })
      await new Promise<void>(done => receiver.listen(0, '127.0.0.1', done)); const address = receiver.address() as { port: number }
      try {
        if (outcome === 'success') await dispatchPublishOnce({ api: dispatchAPI, webhookURL: `http://127.0.0.1:${address.port}`, secret: publishSecret, versionPins: pins, timeoutMs: 10_000, signal: undefined })
        else for (let attempt = 0; attempt < 3; attempt += 1) try { await dispatchPublishOnce({ api: attempt ? api : dispatchAPI, webhookURL: `http://127.0.0.1:${address.port}`, secret: publishSecret, versionPins: pins, timeoutMs: 10_000, signal: undefined }) } catch { /* terminal retry is asserted below */ }
        const jobs = await payload.find({ collection: 'publish-outbox', sort: '-sequence', limit: 1, depth: 0, overrideAccess: true }); const releases = await payload.count({ collection: 'published-releases', overrideAccess: true })
        const stages = await payload.find({ collection: 'audit-events', where: { event: { equals: 'editorial.publish_stage' } }, pagination: false, limit: 20, depth: 0, overrideAccess: true })
        const publishStages = stages.docs.filter(item => (item.detail as { publishJob?: string }).publishJob === claim.job.id).map(item => (item.detail as { stage: string }).stage)
        const health = await fetch(`${publicOrigin}/healthz`).then(item => item.json()) as { contentHash?: string; jobID?: string }
        const served = await fetch(`${publicOrigin}/on-page-review/review-target`).then(item => item.text())
        let smtp: string | undefined
        if (outcome === 'fail') {
          const messages: string[] = []
          const server = createSMTPServer(socket => { let buffer = ''; let data = false; socket.write('220 eng010 ESMTP\r\n'); socket.on('data', chunk => { buffer += chunk.toString('utf8'); while (true) { if (data) { const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return; messages.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false; socket.write('250 queued\r\n'); continue } const end = buffer.indexOf('\r\n'); if (end < 0) return; const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (/^EHLO /i.test(line)) socket.write('250-eng010\r\n250 AUTH PLAIN\r\n'); else if (/^AUTH PLAIN /i.test(line)) socket.write('235 authenticated\r\n'); else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 accepted\r\n'); else if (/^DATA$/i.test(line)) { data = true; socket.write('354 continue\r\n') } else if (/^QUIT$/i.test(line)) { socket.write('221 bye\r\n'); socket.end() } else socket.write('250 ok\r\n') } }) })
          await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
          try {
            const { configureSMTPMailbox, testSMTPMailbox, setMailboxArea } = await import('../src/mailboxes.js'); const { dispatchOneNotification } = await import('../src/notification-dispatch.js')
            const actor = claim.immutableContext.approvedBy; const mailbox = await configureSMTPMailbox(payload, { name: 'ENG-010 SMTP', primaryAddress: 'notices@example.test', aliases: [], host: '127.0.0.1', port: (server.address() as { port: number }).port, security: 'starttls', username: 'eng010', password: 'eng010-password' }, actor)
            await testSMTPMailbox(payload, mailbox.id, actor); await setMailboxArea(payload, { area: 'notifications', mailbox: mailbox.id, senderAddress: 'notices@example.test' }, actor)
            // nodemailer encodes the URL's equals sign as quoted-printable. Decode
            // the captured wire body before matching the exact publish job.
            const decoded = () => messages.map(message => message.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))))
            for (let index = 0; index < 40 && !decoded().some(message => message.includes(`publish=${claim.job.id}`)); index += 1) await dispatchOneNotification(payload, new Date(Date.now() + 10_000 + index))
            smtp = decoded().find(message => message.includes(`publish=${claim.job.id}`))
          } finally { await new Promise<void>(done => server.close(() => done())) }
        }
        const notification = await payload.find({ collection: 'notification-outbox', where: { and: [{ sourceType: { equals: 'publish-job' } }, { sourceID: { equals: claim.job.id } }] }, limit: 1, depth: 0, overrideAccess: true })
        json(response, { claim: { id: claim.job.id, changeSetID, contentHash: claim.contentHash }, job: jobs.docs[0] ? { id: jobs.docs[0].id, status: jobs.docs[0].status } : null, releases: releases.totalDocs, stages: publishStages, health, served, notification: notification.docs[0] ? { sourceID: notification.docs[0].sourceID, state: notification.docs[0].state } : null, smtp: smtp ?? null })
      } finally {
        await Promise.all([new Promise<void>((done, reject) => receiver.close(error => error ? reject(error) : done())), new Promise<void>((done, reject) => publicServer.close(error => error ? reject(error) : done()))])
        await Promise.all(suspended.docs.map(job => payload.update({ collection: 'publish-outbox', id: job.id, data: { status: job.status, leaseToken: job.leaseToken, leaseExpiresAt: job.leaseExpiresAt, nextAttemptAt: job.nextAttemptAt }, overrideAccess: true, context: { editorialInternal: true } })))
        if (outcome === 'fail') { for (const jobID of [claim.job.id, cleanupJobID].filter((id): id is string => Boolean(id))) { const job = await payload.findByID({ collection: 'publish-outbox', id: jobID, depth: 0, overrideAccess: true }).catch(() => null) as any; if (!job) continue; await payload.delete({ collection: 'published-releases', where: { outbox: { equals: jobID } }, overrideAccess: true }); await payload.delete({ collection: 'notification-deliveries', where: { outbox: { equals: jobID } }, overrideAccess: true }).catch(() => undefined); await payload.delete({ collection: 'notification-outbox', where: { sourceID: { equals: jobID } }, overrideAccess: true }).catch(() => undefined); await payload.delete({ collection: 'publish-outbox', id: jobID, overrideAccess: true }); await payload.delete({ collection: 'publish-snapshots', id: String(job.snapshot), overrideAccess: true }).catch(() => undefined); await payload.delete({ collection: 'change-sets', id: String(job.changeSet), overrideAccess: true }).catch(() => undefined) } rmSync(publishArtifacts, { recursive: true, force: true }); rmSync(publishReleases, { recursive: true, force: true }) }
      }
    })().catch(error => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'ENG-010 fixture failed.') })
    return
  }
  if (request.method === 'POST' && request.url === '/__e2e/publish-callback-history') {
    void (async () => {
      const baseline = await payload.find({ collection: 'publish-outbox', where: { sequence: { equals: 1 } }, limit: 1, depth: 0, overrideAccess: true })
      const prior = baseline.docs[0]
      if (!prior) throw new Error('Duplicate callback baseline is missing.')
      const releaseRows = await payload.find({ collection: 'published-releases', where: { outbox: { equals: prior.id } }, limit: 1, depth: 0, overrideAccess: true })
      const release = releaseRows.docs[0]
      if (!release || !release.artifact || typeof release.artifact !== 'object') throw new Error('Duplicate callback release is missing.')
      const duplicate = await withPayloadTransaction(payload, req => completePublishJob(payload, req, String(prior.id), 'duplicate-callback-token', release.artifact as VerifiedArtifact))
      const claimed = await withPayloadTransaction(payload, req => claimNextPublishJob(payload, req, new Date()))
      if (!claimed || Number(claimed.sequence) !== 2) throw new Error('Older callback fixture is not the publish queue head.')
      const snapshotID = typeof claimed.snapshot === 'string' ? claimed.snapshot : String(claimed.snapshot.id)
      const snapshot = await payload.findByID({ collection: 'publish-snapshots', id: snapshotID, depth: 0, overrideAccess: true })
      const artifact: VerifiedArtifact = { digest: 'c'.repeat(64), sourceContentHash: String(snapshot.contentHash), themeVersion: String(snapshot.themeVersion), engineVersion: String(snapshot.engineVersion), contractVersion: String(snapshot.contractVersion), checks: [{ name: 'artifact-integrity', status: 'passed' }, { name: 'public-health', status: 'passed' }] }
      let outOfOrder = ''
      const retried = await withPayloadTransaction(payload, async req => {
        try { await completePublishJob(payload, req, String(claimed.id), String(claimed.leaseToken), artifact) }
        catch (error) { outOfOrder = error instanceof Error ? error.message : 'Publish callback failed.' }
        if (outOfOrder !== 'An out-of-order publish job cannot activate an older release.') throw new Error(outOfOrder)
        return retryPublishJob(payload, req, String(claimed.id), String(claimed.leaseToken), 'STALE_CALLBACK')
      })
      return { duplicateReleaseID: duplicate.id, outOfOrder, retry: { id: retried.id, status: retried.status, attempts: retried.attempts, retryReason: retried.errorCode, correlationID: retried.correlationID } }
    })().then(value => json(response, value)).catch((error) => { response.writeHead(500); response.end(error instanceof Error ? error.message : 'Unable to exercise publish callback history.') })
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
  process.env.OAUTH_INTERNAL_ORIGIN = issuerOrigin
  process.env.OAUTH_INTROSPECTION_SECRET = 'synthetic-e2e-mcp-secret'
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
    env: { ...process.env, HOSTNAME: '127.0.0.1', NODE_EXTRA_CA_CERTS: caCertificate, NODE_OPTIONS: `--require=${standaloneProviderBridge}`, CMS_E2E_MAIL_DELIVERY_LEDGER: standaloneReplyDeliveryLedger, PORT: String(e2ePort + 2) },
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
