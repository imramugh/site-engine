import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { TOTP } from 'otpauth'

const key = () => {
  const source = process.env.EMERGENCY_TOTP_ENCRYPTION_KEY
  if (!source) throw new Error('EMERGENCY_TOTP_ENCRYPTION_KEY is required for emergency owner authentication.')
  const bytes = Buffer.from(source, 'base64url')
  if (bytes.length !== 32) throw new Error('EMERGENCY_TOTP_ENCRYPTION_KEY must be a 32-byte base64url value.')
  return bytes
}

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

export function decryptSecret(value: string): string {
  const data = Buffer.from(value, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key(), data.subarray(0, 12))
  decipher.setAuthTag(data.subarray(12, 28))
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
}

export const recoveryHash = (code: string) => createHash('sha256').update(code).digest('base64url')
export const recoveryMatches = (code: string, hash: string) => {
  const left = Buffer.from(recoveryHash(code)); const right = Buffer.from(hash)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function acceptedTOTPCounter(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const delta = new TOTP({ secret, algorithm: 'SHA1', digits: 6, period: 30 }).validate({ token: code, window: 1, timestamp: now })
  return delta === null ? null : Math.floor(now / 30_000) + delta
}

export function verifyTOTP(secret: string, code: string): boolean {
  return acceptedTOTPCounter(secret, code) !== null
}
