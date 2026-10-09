import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getPayload } from 'payload'
import config from '../../../../../../../payload.config'
import { serverSessionStrategy } from '../../../../../../../src/identity'
import { previewEvidenceExpiresAt, validatePreviewEvidence } from '../../../../../../../src/preview-evidence'

export const dynamic = 'force-dynamic'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])


export async function GET(request: Request, context: { params: Promise<{ jobID: string; variant: string }> }) {
  const { jobID, variant } = await context.params
  if (!uuid.test(jobID) || !['live', 'proposed'].includes(variant)) return new Response(null, { status: 404, headers })
  const payload = await getPayload({ config }); const auth = await serverSessionStrategy.authenticate({ headers: request.headers, payload }); const user = auth.user as { roles?: string[] } | null
  if (!user) return new Response(null, { status: 401, headers })
  if (!user.roles?.some(role => role === 'owner' || role === 'approver')) return new Response(null, { status: 403, headers })
  try {
    const job = await payload.findByID({ collection: 'preview-render-jobs', id: jobID, depth: 0, overrideAccess: true }) as unknown as Record<string, unknown>
    const expiry = previewEvidenceExpiresAt(job.completedAt)
    if (job.status !== 'completed' || !Number.isFinite(expiry) || expiry <= Date.now()) return new Response(null, { status: 404, headers })
    const evidence = validatePreviewEvidence(job.evidenceManifest, { id: jobID, liveManifestHash: job.liveManifestHash, proposedManifestHash: job.proposedManifestHash })
    if (evidence.state !== 'available') return new Response(null, { status: 404, headers })
    const shot = evidence.screenshots[variant as 'live' | 'proposed']
    const root = process.env.PREVIEW_ARTIFACT_ROOT; if (!root?.startsWith('/')) throw Error()
    const base = resolve(root, jobID), evidenceDirectory = resolve(base, 'evidence'), file = resolve(evidenceDirectory, `${variant}.png`)
    if (!file.startsWith(`${evidenceDirectory}/`)) throw Error()
    const [rootInfo, baseInfo, evidenceInfo, fileInfo] = await Promise.all([lstat(root), lstat(base), lstat(evidenceDirectory), lstat(file)])
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !baseInfo.isDirectory() || baseInfo.isSymbolicLink() || !evidenceInfo.isDirectory() || evidenceInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== shot.bytes || fileInfo.size > 5 * 1024 * 1024) throw Error()
    const body = await readFile(file)
    if (body.length < pngMagic.length || !body.subarray(0, pngMagic.length).equals(pngMagic) || createHash('sha256').update(body).digest('hex') !== shot.sha256) throw Error()
    return new Response(body, { headers: { ...headers, 'Content-Type': 'image/png', 'Content-Length': String(body.length) } })
  } catch { return new Response(null, { status: 404, headers }) }
}
