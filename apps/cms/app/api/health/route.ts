import { NextResponse } from 'next/server'
import config from '../../../payload.config'
import { getPayload } from 'payload'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const payload = await getPayload({ config })
    await (payload.db as unknown as { client: { execute: (sql: string) => Promise<unknown> } }).client.execute('SELECT 1')
    return NextResponse.json({ status: 'ok', database: 'sqlite' }, { status: 200 })
  } catch {
    return NextResponse.json({ status: 'unavailable' }, { status: 503 })
  }
}
