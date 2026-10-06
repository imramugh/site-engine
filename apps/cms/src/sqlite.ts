import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { PayloadRequest } from 'payload'

const defaultDatabaseURI = 'file:./data/cms.sqlite'

export const databaseURI = () => process.env.DATABASE_URI || defaultDatabaseURI

export const databasePath = () => {
  const uri = databaseURI()
  if (!uri.startsWith('file:')) throw new Error('DATABASE_URI must be a local file: URI for SQLite')
  return resolve(uri.slice('file:'.length))
}

/** Ensure the persistent SQLite parent directory exists before Payload opens its client. */
export function ensureSQLiteDirectory(): void {
  const path = databasePath()
  mkdirSync(dirname(path), { recursive: true })
}

export function isRetryableSQLiteError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'SQLITE_BUSY') return true
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|database is locked|busy timeout/i.test(message)
}

export const sqliteBackpressureMessage = 'Saving is temporarily busy. Please retry.'

/** Return a stable retry response for a SQLite writer timeout without exposing driver details. */
export function sqliteBackpressureResponse(error: unknown, body: unknown, headers?: HeadersInit): Response | undefined {
  if (!isRetryableSQLiteError(error)) return undefined
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Retry-After', '1')
  return Response.json(body, { status: 503, headers: responseHeaders })
}

/** Payload REST errors are formatted after this hook; set its status and response headers here. */
export function sqliteBackpressurePayloadError(error: unknown, req: Pick<PayloadRequest, 'responseHeaders'>) {
  if (!isRetryableSQLiteError(error)) return undefined
  req.responseHeaders?.set('Retry-After', '1')
  return { status: 503, response: { errors: [{ message: sqliteBackpressureMessage }] } }
}
