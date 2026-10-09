'use client'

import { type FormEvent, useEffect, useState } from 'react'

export function EmergencyOwnerForm() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [continueTo, setContinueTo] = useState('/admin')

  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get('returnTo') ?? new URLSearchParams(window.location.search).get('resume')
    if (target?.startsWith('/oauth/interaction/')) setContinueTo(target)
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setMessage('')
    try {
      const response = await fetch('/api/auth/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code }),
      })
      setCode('')
      if (response.ok) {
        window.location.assign(continueTo)
        return
      }
      setMessage(response.status === 429 ? 'Sign-in is temporarily locked. Please wait before trying again.' : 'Sign-in was not accepted. Check your email and code, then try again.')
    } catch {
      setCode('')
      setMessage('Sign-in is unavailable. Please try again shortly.')
    } finally {
      setPending(false)
    }
  }

  return <section data-login-form aria-label="Authenticator sign-in">
    <form onSubmit={submit}>
      <p id="emergency-code-help">Enter the code from your authenticator app, or use a recovery code.</p>
      <label htmlFor="emergency-email">Work email</label>
      <input id="emergency-email" data-testid="local-auth-email" name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={pending} />
      <label htmlFor="emergency-code">Authenticator or recovery code</label>
      <input id="emergency-code" data-testid="local-auth-code" name="code" type="password" autoComplete="one-time-code" required maxLength={128} pattern="[A-Za-z0-9_-]{6,128}" aria-describedby="emergency-code-help" value={code} onChange={(event) => setCode(event.target.value)} disabled={pending} />
      <button type="submit" disabled={pending} data-testid="emergency-sign-in" data-local-auth-sign-in style={{ minHeight: 44, minWidth: 44 }}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
    <p aria-live="polite" data-testid="emergency-sign-in-message" data-local-auth-error>{message}</p>
  </section>
}
