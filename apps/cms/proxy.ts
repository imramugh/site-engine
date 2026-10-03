import { NextResponse, type NextRequest } from 'next/server'

const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function proxy(request: NextRequest) {
  if (!mutating.has(request.method)) return NextResponse.next()
  // This private bridge is authenticated with its own required shared secret
  // in the route handler. OAuth calls it server-to-server and intentionally
  // has no browser Origin header; no other internal API path bypasses CSRF.
  if (request.nextUrl.pathname === '/api/internal/oauth/session') return NextResponse.next()
  const expected = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  if (!expected || !origin || origin !== new URL(expected).origin) return new NextResponse('CSRF origin check failed.', { status: 403 })
  return NextResponse.next()
}

export const config = { matcher: ['/api/:path*', '/admin/:path*'] }
