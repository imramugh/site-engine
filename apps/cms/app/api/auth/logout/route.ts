import { NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '../../../../payload.config'
import { cookieName, hashOpaqueToken, readCookie, SESSION_COOKIE } from '../../../../src/identity'

export async function POST(request: Request) {
  const token = readCookie(request.headers, cookieName(SESSION_COOKIE))
  if (token) {
    const payload = await getPayload({ config })
    await payload.update({ collection: 'auth-sessions', where: { tokenHash: { equals: hashOpaqueToken(token) } }, data: { revokedAt: new Date().toISOString() }, overrideAccess: true })
  }
  const response = new NextResponse(null, { status: 204 })
  response.cookies.delete(cookieName(SESSION_COOKIE))
  return response
}
