import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

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
