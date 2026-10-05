import { NextResponse, type NextRequest } from 'next/server'

const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function proxy(request: NextRequest) {
  if (!mutating.has(request.method)) return NextResponse.next()
  // Private service calls use route-specific shared secrets, never browser
  // cookies. All browser mutations retain the exact-origin CSRF check below.
  if (request.method === 'POST' && (
    request.nextUrl.pathname === '/api/internal/oauth/session'
    || request.nextUrl.pathname === '/api/internal/ai-worker/run'
    || request.nextUrl.pathname === '/api/internal/notification-worker/run'
    || /^\/api\/internal\/(preview-jobs|publish-jobs)\/(claim|renew|complete|fail)$/.test(request.nextUrl.pathname)
  )) return NextResponse.next()
  const expected = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  if (!expected || !origin || origin !== new URL(expected).origin) return new NextResponse('CSRF origin check failed.', { status: 403 })
  return NextResponse.next()
}

export const config = { matcher: ['/api/:path*', '/admin/:path*'] }
