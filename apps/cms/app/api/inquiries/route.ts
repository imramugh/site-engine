import { getPayload } from 'payload'
import { REST_GET } from '@payloadcms/next/routes'
import config from '../../../payload.config'
import { createAcceptedInquiry, InquiryCapacityError, InquiryIdempotencyCollisionError, InquiryRateLimitedError, validateInquiry } from '../../../src/inquiries'

export const dynamic = 'force-dynamic'

// Preserve the authenticated Payload collection listing alongside public intake.
export const GET = (request: Request) => REST_GET(config)(request, { params: Promise.resolve({ slug: ['inquiries'] }) })
const MAX_BODY_BYTES = 32_768

function sameOrigin(request: Request): boolean {
  const configured = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  return Boolean(configured && origin && origin === new URL(configured).origin)
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: 'CSRF origin check failed.' }, { status: 403 })
  let body: unknown
  try {
    const reader = request.body?.getReader()
    if (!reader) throw new Error('Missing body')
    let bytes = 0; const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BODY_BYTES) return Response.json({ errors: { form: 'The inquiry is too large.' } }, { status: 413 })
      chunks.push(value)
    }
    const joined = new Uint8Array(bytes); let offset = 0
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
    body = JSON.parse(new TextDecoder().decode(joined))
  } catch { return Response.json({ errors: { form: 'Send a valid form request.' } }, { status: 400 }) }
  const { input, errors } = validateInquiry(body)
  if (!input) return Response.json({ errors }, { status: 422 })
  try {
    const result = await createAcceptedInquiry(await getPayload({ config }), input)
    // Spam submissions receive the same success response but never create a lead.
    if ('suppressed' in result) return Response.json({ accepted: true }, { status: 202 })
    return Response.json({ accepted: true, id: result.inquiry.id }, { status: result.duplicate ? 200 : 201 })
  } catch (error) {
    if (error instanceof InquiryRateLimitedError) return Response.json({ errors: { form: error.message } }, { status: 429, headers: { 'Retry-After': '60' } })
    if (error instanceof InquiryCapacityError) return Response.json({ errors: { form: error.message } }, { status: 503, headers: { 'Retry-After': '60' } })
    if (error instanceof InquiryIdempotencyCollisionError) return Response.json({ errors: { form: error.message } }, { status: 409 })
    return Response.json({ errors: { form: 'The inquiry could not be saved. Please try again.' } }, { status: 500 })
  }
}
