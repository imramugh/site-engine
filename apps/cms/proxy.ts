import { NextResponse, type NextRequest } from 'next/server'

const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const staffDocumentRoots = new Set([
  'account', 'ai-jobs', 'applications', 'block-gallery', 'content-editor', 'content-tree',
  'direct-edit', 'editorial', 'integrations', 'review', 'leads', 'media', 'operations', 'site', 'themes', 'users',
])

function isStaffDocument(pathname: string): boolean {
  if (pathname === '/' || pathname === '/admin' || pathname.startsWith('/admin/')) return true
  const root = pathname.split('/')[1]
  return root !== undefined && staffDocumentRoots.has(root)
}

function documentResponse(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDevelopment = process.env.NODE_ENV === 'development'
  // Payload's admin shell and the branded staff layouts use inline custom
  // properties. Payload can also insert runtime style tags without a nonce.
  // Keep this narrowly to styles; inline scripts require this response nonce, while external scripts remain same-origin.
  const policy = [
    "default-src 'self'", "base-uri 'none'", "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}'${isDevelopment ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self'", "connect-src 'self'", "frame-src 'self'", "frame-ancestors 'none'", "form-action 'self'", "report-uri /__csp/report",
  ].join('; ')
  const requestHeaders = new Headers(request.headers)
  // Next reads the request CSP to attach the nonce to its hydration scripts.
  requestHeaders.set('Content-Security-Policy', policy)
  requestHeaders.set('x-nonce', nonce)
  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', policy)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  return response
}

export function proxy(request: NextRequest) {
  if (!mutating.has(request.method)) {
    if ((request.method === 'GET' || request.method === 'HEAD') && isStaffDocument(request.nextUrl.pathname)) return documentResponse(request)
    return NextResponse.next()
  }
  // Private service calls use route-specific shared secrets, never browser
  // cookies. All browser mutations retain the exact-origin CSRF check below.
  if (request.method === 'POST' && (
    request.nextUrl.pathname === '/api/internal/oauth/session'
    || request.nextUrl.pathname === '/api/internal/ai-worker/run'
    || request.nextUrl.pathname === '/api/internal/notification-worker/run'
    || request.nextUrl.pathname === '/api/internal/mailbox-worker/run'
    || request.nextUrl.pathname === '/api/internal/publish-jobs/log'
    || /^\/api\/internal\/(preview-jobs|publish-jobs)\/(claim|renew|complete|fail)$/.test(request.nextUrl.pathname)
  )) return NextResponse.next()
  // Provider callbacks authenticate their own signatures/state, without staff cookies.
  if (request.method === 'POST' && (
    request.nextUrl.pathname === '/api/email-workspace/notifications/microsoft'
    || request.nextUrl.pathname === '/api/email-workspace/notifications/google'
  )) return NextResponse.next()
  const expected = process.env.PAYLOAD_PUBLIC_SERVER_URL
  const origin = request.headers.get('origin')
  if (!expected || !origin || origin !== new URL(expected).origin) return new NextResponse('CSRF origin check failed.', { status: 403 })
  return NextResponse.next()
}

export const config = { matcher: [
  '/api/:path*', '/', '/admin/:path*', '/account/:path*', '/ai-jobs/:path*',
  '/applications/:path*', '/block-gallery/:path*', '/content-editor/:path*',
  '/content-tree/:path*', '/direct-edit/:path*', '/editorial/:path*', '/review/:path*',
  '/integrations/:path*', '/leads/:path*', '/media/:path*', '/operations/:path*',
  '/site/:path*', '/themes/:path*', '/users/:path*',
] }
