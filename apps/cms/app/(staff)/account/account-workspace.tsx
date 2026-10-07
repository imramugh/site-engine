'use client'

import { useCallback, useEffect, useState } from 'react'
import styles from './account-workspace.module.css'

type Session = { id: string; authenticatedAt: string; lastSeenAt: string; expiresAt: string; current: boolean; active: boolean }
type Data = { account: { name?: string; email?: string; roles: string[]; provider: string | null }; sessions: Session[] }
type Kind = 'new-lead' | 'active-incident-lead' | 'new-job-application' | 'change-set-submitted' | 'follow-ups-due' | 'publish-or-integration-failed'

const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto' }).format(new Date(value))
const ordinaryEvents: Array<{ kind: Exclude<Kind, 'active-incident-lead'>; label: string; description: string }> = [
  { kind: 'new-lead', label: 'New leads', description: 'When a visitor sends an inquiry.' },
  { kind: 'new-job-application', label: 'New job applications', description: 'When a candidate submits an application.' },
  { kind: 'change-set-submitted', label: 'Changes ready for review', description: 'When a change set is submitted for approval.' },
  { kind: 'follow-ups-due', label: 'Follow-ups due', description: 'When a lead follow-up needs attention.' },
  { kind: 'publish-or-integration-failed', label: 'Publishing and integration failures', description: 'When publishing or an integration needs attention.' },
]

export function AccountWorkspace() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [mutedKinds, setMutedKinds] = useState<Kind[]>([])
  const [preferencesLoading, setPreferencesLoading] = useState(true)
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const [preferencesSaving, setPreferencesSaving] = useState(false)
  const [preferencesError, setPreferencesError] = useState('')
  const [preferencesMessage, setPreferencesMessage] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const response = await fetch('/api/account/sessions', { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error)
      setData(body)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Account could not be loaded.') }
  }, [])
  const loadPreferences = useCallback(async () => {
    setPreferencesLoading(true)
    setPreferencesError('')
    try {
      const response = await fetch('/api/notification-user-preferences', { cache: 'no-store' })
      const body = await response.json() as { mutedKinds?: Kind[]; error?: string }
      if (!response.ok || !Array.isArray(body.mutedKinds)) throw new Error(body.error ?? 'Notification preferences could not be loaded.')
      setMutedKinds(body.mutedKinds)
      setPreferencesLoaded(true)
    } catch (caught) { setPreferencesError(caught instanceof Error ? caught.message : 'Notification preferences could not be loaded.') }
    finally { setPreferencesLoading(false) }
  }, [])
  useEffect(() => { void load(); void loadPreferences() }, [load, loadPreferences])

  const revoke = async (sessionID?: string, all = false) => {
    if (!window.confirm(all ? 'Sign out every session, including this one?' : 'Sign out this session?')) return
    setBusy(all ? 'all' : sessionID!)
    setError('')
    try {
      const response = await fetch('/api/account/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(all ? { action: 'revoke-all' } : { action: 'revoke', sessionID }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error)
      if (body.signedOut) { window.location.assign('/admin/login'); return }
      await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Session could not be revoked.') }
    finally { setBusy('') }
  }
  const togglePreference = (kind: Exclude<Kind, 'active-incident-lead'>) => { setPreferencesMessage(''); setMutedKinds(current => current.includes(kind) ? current.filter(value => value !== kind) : [...current, kind]) }
  const savePreferences = async () => {
    if (preferencesSaving || !preferencesLoaded) return
    setPreferencesSaving(true)
    setPreferencesError('')
    setPreferencesMessage('')
    try {
      const response = await fetch('/api/notification-user-preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mutedKinds }) })
      const body = await response.json() as { mutedKinds?: Kind[]; error?: string }
      if (!response.ok || !Array.isArray(body.mutedKinds)) throw new Error(body.error ?? 'Notification preferences could not be saved.')
      setMutedKinds(body.mutedKinds)
      setPreferencesMessage('Notification preferences saved.')
    } catch (caught) { setPreferencesError(caught instanceof Error ? caught.message : 'Notification preferences could not be saved.') }
    finally { setPreferencesSaving(false) }
  }

  return <main className={styles.main} data-account-workspace aria-busy={!data && !error}>
    <section className={styles.profile}>
      <h1>Your account</h1>
      {data && <><div className={styles.identity}><span aria-hidden="true">{(data.account.name || data.account.email || 'S').split(/\s+/).slice(0, 2).map(value => value[0]).join('').toUpperCase()}</span><div><strong>{data.account.name}</strong><p>{data.account.email}</p></div></div><dl><div><dt>Roles</dt><dd>{data.account.roles.map(role => role[0].toUpperCase() + role.slice(1)).join(', ')}</dd></div><div><dt>Sign-in</dt><dd>{data.account.provider && data.account.provider !== 'local' ? data.account.provider[0].toUpperCase() + data.account.provider.slice(1) : 'Authenticator app'}</dd></div></dl></>}
    </section>
    <div className={styles.details}>
      <section className={styles.sessions}>
        <header><div><h2>Signed-in sessions</h2><p>Review and end access to your account.</p></div><button className={styles.danger} disabled={Boolean(busy)} onClick={() => void revoke(undefined, true)}>Sign out everywhere</button></header>
        {error && <div role="alert" className={styles.error}>{error} <button onClick={() => void load()}>Try again</button></div>}
        {data?.sessions.map(session => <article key={session.id}><div><strong>{session.current ? 'This session' : 'Other session'}</strong><span className={session.active ? styles.active : styles.inactive}>{session.active ? 'Active' : 'Ended'}</span><p>Signed in {date(session.authenticatedAt)} · Last active {date(session.lastSeenAt)}</p></div>{session.active && <button disabled={Boolean(busy)} onClick={() => void revoke(session.id)}>{session.current ? 'Sign out' : 'Revoke'}</button>}</article>)}
      </section>
      <section className={styles.preferences} aria-labelledby="notification-preferences-title" aria-busy={preferencesLoading || preferencesSaving}>
        <header><div><h2 id="notification-preferences-title">Your notification emails</h2><p>Choose routine updates for event roles that are authorized to notify you.</p></div><button type="button" disabled={!preferencesLoaded || preferencesLoading || preferencesSaving} onClick={() => void savePreferences()}>{preferencesSaving ? 'Saving…' : 'Save preferences'}</button></header>
        {preferencesError && <p className={styles.error} role="alert">{preferencesError} <button type="button" onClick={() => void loadPreferences()}>Try again</button></p>}
        {preferencesMessage && <p className={styles.status} role="status">{preferencesMessage}</p>}
        <fieldset disabled={!preferencesLoaded || preferencesLoading || preferencesSaving} className={styles.preferenceList}>
          <legend className={styles.srOnly}>Routine notification emails</legend>
          {ordinaryEvents.map(event => <label key={event.kind} className={styles.preference}><input type="checkbox" checked={!mutedKinds.includes(event.kind)} onChange={() => togglePreference(event.kind)} /><span><strong>{event.label}</strong><small>{event.description}</small></span></label>)}
          <div className={styles.fixedPreference}><input id="urgent-incident-alerts" type="checkbox" checked disabled /><label htmlFor="urgent-incident-alerts"><strong>Active incident alerts</strong><small>Active incident alerts cannot be muted here. Your role determines which alerts you receive.</small></label></div>
        </fieldset>
      </section>
    </div>
  </main>
}
