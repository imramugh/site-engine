'use client'

import { type FormEvent, useEffect, useState } from 'react'
import { toDataURL } from 'qrcode'
import { useRouter } from 'next/navigation'
import styles from './enrollment-form.module.css'

type PreparedEnrollment = { email: string; roles: string[]; otpauthURI: string }

const roleName = (role: string) => role.charAt(0).toUpperCase() + role.slice(1)
const manualKey = (otpauthURI: string) => { try { return new URL(otpauthURI).searchParams.get('secret') ?? '' } catch { return '' } }

export function EnrollmentForm() {
  const router = useRouter()
  const [token, setToken] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<PreparedEnrollment | null>(null)
  const [qr, setQR] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const match = /^#invite=([^&]+)$/.exec(window.location.hash)
    if (!match) { setError('This invitation link is invalid or incomplete.'); return }
    let value: string
    try { value = decodeURIComponent(match[1]) } catch { setError('This invitation link is invalid or incomplete.'); return }
    if (!value || value.length > 512) { setError('This invitation link is invalid or incomplete.'); return }
    window.history.replaceState(null, '', window.location.pathname)
    setToken(value)
  }, [])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      setPending(true); setError('')
      try {
        const response = await fetch('/api/auth/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'prepare', token }) })
        const body = await response.json() as Partial<PreparedEnrollment> & { error?: string }
        if (!response.ok || typeof body.email !== 'string' || !Array.isArray(body.roles) || typeof body.otpauthURI !== 'string') throw new Error(body.error ?? 'This invitation is invalid or has expired.')
        const image = await toDataURL(body.otpauthURI, { errorCorrectionLevel: 'M', margin: 1, width: 240 })
        if (!cancelled) { setPrepared({ email: body.email, roles: body.roles, otpauthURI: body.otpauthURI }); setQR(image) }
      } catch (caught) { if (!cancelled) setError(caught instanceof Error ? caught.message : 'This invitation is invalid or has expired.') }
      finally { if (!cancelled) setPending(false) }
    })()
    return () => { cancelled = true }
  }, [token])

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token || pending) return
    setPending(true); setError('')
    try {
      const response = await fetch('/api/auth/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'confirm', token, name: name.trim(), code }) })
      const body = await response.json() as { recoveryCodes?: unknown; error?: string }
      setCode('')
      if (!response.ok || !Array.isArray(body.recoveryCodes) || !body.recoveryCodes.every((item): item is string => typeof item === 'string')) throw new Error(body.error ?? 'The authenticator code was not accepted. Try again.')
      setPrepared(null); setQR(''); setToken(null)
      setRecoveryCodes(body.recoveryCodes)
    } catch (caught) { setCode(''); setError(caught instanceof Error ? caught.message : 'Enrollment is unavailable. Please try again shortly.') }
    finally { setPending(false) }
  }

  if (recoveryCodes) return <section className={styles.card} aria-labelledby="recovery-title"><h1 id="recovery-title">Save your recovery codes</h1><p>Each code works once if you cannot use your authenticator app. Store them somewhere secure. They will not be shown again.</p><ul className={styles.recoveryCodes} data-testid="recovery-codes" aria-label="Recovery codes">{recoveryCodes.map((item) => <li key={item} data-testid="recovery-code">{item}</li>)}</ul><label className={styles.acknowledgment}><input data-testid="recovery-acknowledge" type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I have saved these recovery codes.</label><button data-testid="finish-enrollment" type="button" disabled={!acknowledged} onClick={() => router.replace('/admin')}>Continue to admin</button></section>

  return <section className={styles.card} aria-labelledby="enrollment-title" aria-busy={pending}>
    <h1 id="enrollment-title">Set up your authenticator app</h1>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {!error && pending && !prepared ? <p role="status">Preparing your invitation…</p> : null}
    {prepared ? <><p>This invitation is for <strong>{prepared.email}</strong>. Your roles: {prepared.roles.map(roleName).join(', ')}.</p><ol className={styles.steps}><li>Open your authenticator app and scan this QR code.</li><li>Enter the current six-digit code below to finish setup.</li></ol><img className={styles.qr} data-testid="enrollment-qr" src={qr} alt="QR code for your authenticator app" /><details><summary>Set up manually instead</summary><p>Enter the account name <strong>{prepared.email}</strong>, choose a time-based code with six digits and a 30-second period, then enter this setup key.</p><code className={styles.manualURI} data-testid="enrollment-manual-key">{manualKey(prepared.otpauthURI)}</code></details><form onSubmit={confirm}><label htmlFor="enrollment-name">Your name<input id="enrollment-name" data-testid="enrollment-name" name="name" required maxLength={160} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} disabled={pending} /></label><label htmlFor="enrollment-code">Authenticator code<input id="enrollment-code" data-testid="enrollment-code" name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} disabled={pending} /></label><button data-testid="enrollment-confirm" type="submit" disabled={pending}>{pending ? 'Confirming…' : 'Confirm setup'}</button></form></> : null}
  </section>
}
