import { createHash } from 'node:crypto'
import { getPayload } from 'payload'
import { REST_GET } from '@payloadcms/next/routes'
import config from '../../../payload.config'
import { removeResume, storeResume, validateResume } from '../../../src/applications'

export const dynamic = 'force-dynamic'
export const GET = (request: Request) => REST_GET(config)(request, { params: Promise.resolve({ slug: ['applications'] }) })
const maxRequestBytes = 6 * 1024 * 1024
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function boundedForm(request: Request): Promise<FormData> {
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data') || !request.body) throw new Error('Invalid application.')
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxRequestBytes) throw new RangeError('Application is too large.'); chunks.push(next.value) } } finally { reader.releaseLock() }
  return new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type')! }, body: Buffer.concat(chunks) }).formData()
}

export async function POST(request: Request) {
  const origin = process.env.PAYLOAD_PUBLIC_SERVER_URL
  if (!origin || request.headers.get('origin') !== origin) return Response.json({ error: 'forbidden_origin' }, { status: 403 })
  try {
    const form = await boundedForm(request)
    const name = form.get('name'); const applicantEmail = form.get('email'); const coverLetter = form.get('coverLetter'); const consent = form.get('consent'); const jobId = form.get('jobId'); const resume = form.get('resume'); const key = form.get('idempotencyKey')
    if (typeof name !== 'string' || name.length < 1 || name.length > 160 || typeof applicantEmail !== 'string' || applicantEmail.length > 254 || !email.test(applicantEmail) || typeof coverLetter !== 'string' || coverLetter.length < 1 || coverLetter.length > 10_000 || consent !== 'true' || typeof jobId !== 'string' || !id.test(jobId) || typeof key !== 'string' || !id.test(key) || !(resume instanceof File)) throw new Error('Invalid application.')
    const bytes = Buffer.from(await resume.arrayBuffer()); validateResume({ data: bytes, mimetype: resume.type, size: bytes.length, name: resume.name })
    const payload = await getPayload({ config }); const releases = await payload.find({ collection: 'published-releases', sort: '-sequence', limit: 1, depth: 1, overrideAccess: true }); const manifest = (releases.docs[0]?.snapshot as { manifest?: { pages?: Array<{ id: string; template: string; status: string; jobPosting?: { validThrough?: string } }> } } | undefined)?.manifest; const job = manifest?.pages?.find((page) => page.id === jobId)
    if (!job || job.template !== 'job' || job.status !== 'published' || (job.jobPosting?.validThrough && new Date(job.jobPosting.validThrough).getTime() <= Date.now())) throw new Error('Job is not accepting applications.')
    const digest = createHash('sha256').update(bytes).digest('hex'); const matches = (prior: { name: string; email: string; coverLetter: string; consent: boolean; jobId: string; resumeKey: string }) => prior.name === name && prior.email === applicantEmail && prior.coverLetter === coverLetter && prior.consent && prior.jobId === jobId && prior.resumeKey.endsWith(`-${digest}`)
    const existing = await payload.find({ collection: 'applications', where: { idempotencyKey: { equals: key } }, overrideAccess: true }); if (existing.docs[0]) { if (!matches(existing.docs[0] as never)) throw new Error('Idempotency key collision.'); return Response.json({ id: existing.docs[0].id }, { status: 200 }) }
    const resumeKey = storeResume({ data: bytes, name: resume.name })
    try { const doc = await payload.create({ collection: 'applications', data: { name, email: applicantEmail, coverLetter, consent: true, jobId, resumeKey, idempotencyKey: key }, overrideAccess: true }); return Response.json({ id: doc.id }, { status: 201 }) } catch { removeResume(resumeKey); const collision = await payload.find({ collection: 'applications', where: { idempotencyKey: { equals: key } }, overrideAccess: true }); if (collision.docs[0] && matches(collision.docs[0] as never)) return Response.json({ id: collision.docs[0].id }, { status: 200 }); throw new Error('Application storage failed.') }
  } catch (error) { return Response.json({ error: error instanceof RangeError ? 'application_too_large' : 'invalid_application' }, { status: error instanceof RangeError ? 413 : 400 }) }
}
