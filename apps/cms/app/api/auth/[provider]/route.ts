import { NextResponse } from 'next/server'

/** Staff SSO has been retired. Stale links cannot begin an external flow. */
export async function GET(): Promise<Response> {
  return new NextResponse('Staff single sign-on has been retired. Use local authenticator sign-in.', { status: 410, headers: { 'Cache-Control': 'no-store' } })
}
