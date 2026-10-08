import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'

export const neutralApplicationFormCopy = { linkedInLabel: 'LinkedIn', noteLabel: 'Note', consentLabel: 'I consent to the handling of this application.', submitLabel: 'Submit application', successMessage: 'Your application has been received.', nameRequired: 'Enter full name.', emailRequired: 'Enter email.', emailInvalid: 'Enter a valid email address.', resumeRequired: 'Choose a resume.', consentRequired: 'Confirm consent.', errorSummarySingular: 'Check your application', errorSummaryPlural: 'Check your application' } as const
export type ApplicationFormCopy = { [K in keyof typeof neutralApplicationFormCopy]: string }
const keys = new Set(['linkedInLabel', 'noteLabel', 'consentLabel', 'submitLabel', 'successMessage', 'nameRequired', 'emailRequired', 'emailInvalid', 'resumeRequired', 'consentRequired', 'errorSummarySingular', 'errorSummaryPlural'])
export function applicationFormCopy(root = process.env.SITE_THEME_COMPONENT_ROOT): ApplicationFormCopy {
  if (!root) return neutralApplicationFormCopy
  const trusted = realpathSync(resolve(root)); const file = join(trusted, 'application-form.json')
  try { lstatSync(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return neutralApplicationFormCopy; throw error }
  if (relative(trusted, resolve(file)).startsWith('..')) throw new Error('application-form.json must remain inside SITE_THEME_COMPONENT_ROOT')
  const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_192) throw new Error('application-form.json must be a regular file no larger than 8 KiB')
  let value: unknown; try { value = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('application-form.json must contain valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('application-form.json must be an object')
  const source = value as Record<string, unknown>; if (source.schemaVersion !== 1) throw new Error('application-form.json schemaVersion must equal 1')
  for (const key of Object.keys(source)) if (key !== 'schemaVersion' && !keys.has(key)) throw new Error(`application-form.json has unsupported key ${key}`)
  const copy: Record<string, string> = { ...neutralApplicationFormCopy }
  for (const key of keys) if (key in source) { const text = source[key]; if (typeof text !== 'string' || !text.trim() || text.length > 1_024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error(`application-form.json ${key} must be plain text up to 1024 characters`); copy[key] = text.trim() }
  return copy as ApplicationFormCopy
}
