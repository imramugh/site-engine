import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getPayload } from 'payload'
import config from '../../../../../../../payload.config'
import { serverSessionStrategy } from '../../../../../../../src/identity'

export const dynamic = 'force-dynamic'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const digest = /^[a-f0-9]{64}$/
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const retentionDays = () => { const n = Number(process.env.PREVIEW_EVIDENCE_RETENTION_DAYS ?? 30); return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30 }

export async function GET(request: Request, context: { params: Promise<{ jobID: string; variant: string }> }) {
  const { jobID, variant } = await context.params
  if (!uuid.test(jobID) || !['live', 'proposed'].includes(variant)) return new Response(null, { status: 404, headers })
  const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const user = auth.user as { roles?: string[] } | null
  if (!user) return new Response(null, { status: 401, headers })
  if (!user.roles?.some(role => role === 'owner' || role === 'approver')) return new Response(null, { status: 403, headers })
  try {
    const job = await payload.findByID({ collection: 'preview-render-jobs', id: jobID, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const evidence = job.evidenceManifest as { jobID?: unknown; liveManifestHash?: unknown; proposedManifestHash?: unknown; screenshots?: Record<string, { path?: unknown; bytes?: unknown; sha256?: unknown }> } | undefined
    const completedAt = Date.parse(String(job.completedAt)); const shot = evidence?.screenshots?.[variant]
    if (job.status !== 'completed' || !Number.isFinite(completedAt) || completedAt + retentionDays() * 86_400_000 <= Date.now() || evidence?.jobID !== jobID || evidence.liveManifestHash !== job.liveManifestHash || evidence.proposedManifestHash !== job.proposedManifestHash || !shot || shot.path !== `evidence/${variant}.png` || !Number.isInteger(shot.bytes) || typeof shot.sha256 !== 'string' || !digest.test(shot.sha256)) return new Response(null, { status: 404, headers })
    const root = process.env.PREVIEW_ARTIFACT_ROOT; if (!root?.startsWith('/')) throw Error()
    const base = resolve(root, jobID), evidenceDirectory = resolve(base, 'evidence'), file = resolve(evidenceDirectory, `${variant}.png`)
    if (!file.startsWith(`${evidenceDirectory}/`)) throw Error()
    const [baseInfo, evidenceInfo, fileInfo] = await Promise.all([lstat(base), lstat(evidenceDirectory), lstat(file)])
    if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink() || !evidenceInfo.isDirectory() || evidenceInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== shot.bytes || fileInfo.size > 5 * 1024 * 1024) throw Error()
    const body = await readFile(file)
    if (body.length < pngMagic.length || !body.subarray(0, pngMagic.length).equals(pngMagic) || createHash('sha256').update(body).digest('hex') !== shot.sha256) throw Error()
    return new Response(body, { headers: { ...headers, 'Content-Type': 'image/png', 'Content-Length': String(body.length) } })
  } catch { return new Response(null, { status: 404, headers }) }
}
