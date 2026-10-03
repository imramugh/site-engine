import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { getPayload } from 'payload'
import config from '../payload.config'
import { ensureSQLiteDirectory } from '../src/sqlite'
import { createLocalOwner } from '../src/local-enrollment'

const [email, name] = process.argv.slice(2)
const tokenFile = process.env.BOOTSTRAP_OPERATOR_TOKEN_FILE
const tokenInfo = tokenFile && existsSync(tokenFile) ? lstatSync(tokenFile) : undefined
const token = tokenInfo?.isFile() && !tokenInfo.isSymbolicLink() && (tokenInfo.mode & 0o077) === 0
  ? readFileSync(tokenFile!, 'utf8').trim()
  : ''
const output = process.env.LOCAL_OWNER_CREDENTIALS_FILE

if (process.env.ALLOW_LOCAL_OWNER_BOOTSTRAP !== 'true' || !process.env.PAYLOAD_SECRET ||
  !process.env.EMERGENCY_TOTP_ENCRYPTION_KEY || !output || !email || !name ||
  !/^[A-Za-z0-9_-]{20,}$/.test(token)) {
  throw new Error('Local owner bootstrap requires ALLOW_LOCAL_OWNER_BOOTSTRAP=true, PAYLOAD_SECRET, EMERGENCY_TOTP_ENCRYPTION_KEY, BOOTSTRAP_OPERATOR_TOKEN_FILE, LOCAL_OWNER_CREDENTIALS_FILE, email, and name.')
}

ensureSQLiteDirectory()
const payload = await getPayload({ config })
try {
  await createLocalOwner(payload, { email: email.trim().toLowerCase(), name: name.trim(), credentialsFile: output })
  console.info(`Local owner credentials were written to ${output}.`)
} finally {
  await payload.destroy()
}
