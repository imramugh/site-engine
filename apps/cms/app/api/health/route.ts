import { NextResponse } from 'next/server'
import config from '../../../payload.config'
import { getPayload } from 'payload'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const payload = await getPayload({ config })
    // Touch an application table so a missing production migration cannot appear healthy.
    await payload.count({ collection: 'users', overrideAccess: true })
    return NextResponse.json({ status: 'ok', database: 'sqlite' }, { status: 200, headers: { 'cache-control': 'no-store' } })
  } catch {
    return NextResponse.json({ status: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
