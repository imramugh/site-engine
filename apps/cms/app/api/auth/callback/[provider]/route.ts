import { NextResponse } from 'next/server'

export async function GET(): Promise<Response> {
  return new NextResponse('Staff single sign-on has been retired.', { status: 410, headers: { 'Cache-Control': 'no-store' } })
}
