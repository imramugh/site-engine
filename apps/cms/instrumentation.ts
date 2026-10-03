export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureSQLiteDirectory } = await import('./src/sqlite')
    ensureSQLiteDirectory()
  }
}
