import { NextResponse, type NextRequest } from 'next/server'

const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function proxy(request: NextRequest) {
  if (!mutating.has(request.method)) return NextResponse.next()
  const expected = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  if (!expected || !origin || origin !== new URL(expected).origin) return new NextResponse('CSRF origin check failed.', { status: 403 })
  return NextResponse.next()
}

export const config = { matcher: ['/api/:path*', '/admin/:path*'] }
