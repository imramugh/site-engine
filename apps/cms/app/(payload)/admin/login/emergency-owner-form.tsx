'use client'

import { type FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'

export function EmergencyOwnerForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setMessage('')
    try {
      const response = await fetch('/api/auth/emergency', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code }),
      })
      setCode('')
      if (response.ok) {
        router.push('/admin')
        router.refresh()
        return
      }
      setMessage(response.status === 429 ? 'Emergency sign-in is temporarily locked. Please wait before trying again.' : 'Emergency sign-in was not accepted. Check your email and code, then try again.')
    } catch {
      setCode('')
      setMessage('Emergency sign-in is unavailable. Please try again shortly.')
    } finally {
      setPending(false)
    }
  }

  return <section aria-labelledby="emergency-owner-heading">
    <h2 id="emergency-owner-heading">Emergency Owner sign-in</h2>
    <p>Use your Owner email and a current TOTP or recovery code.</p>
    <form onSubmit={submit}>
      <label htmlFor="emergency-email">Owner email</label>
      <input id="emergency-email" name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={pending} />
      <label htmlFor="emergency-code">TOTP or recovery code</label>
      <input id="emergency-code" name="code" type="password" autoComplete="one-time-code" required maxLength={128} pattern="[A-Za-z0-9_-]{6,128}" value={code} onChange={(event) => setCode(event.target.value)} disabled={pending} />
      <button type="submit" disabled={pending} data-testid="emergency-sign-in" style={{ minHeight: 44, minWidth: 44 }}>
        {pending ? 'Signing in…' : 'Sign in as Owner'}
      </button>
    </form>
    <p aria-live="polite" data-testid="emergency-sign-in-message">{message}</p>
  </section>
}
