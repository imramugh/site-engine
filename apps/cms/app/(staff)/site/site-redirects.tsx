'use client'

import { useEffect, useRef, useState } from 'react'
import type { Redirect } from './site-types'
import styles from './site-workspace.module.css'

type Draft = { id: string; from: string; to: string; hash: string }
const emptyDraft: Draft = { id: '', from: '', to: '', hash: '' }

export function SiteRedirects({ redirects, busy, canSave, onSave }: {
  redirects: Redirect[]
  busy: boolean
  canSave: boolean
  onSave: (value: { from: string; to: string }, extra: { id?: string; expectedHash?: string }) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const oldAddress = useRef<HTMLInputElement>(null)
  useEffect(() => { if (draft) requestAnimationFrame(() => oldAddress.current?.focus()) }, [draft?.id])
  const close = () => setDraft(null)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!draft) return
    if (await onSave({ from: draft.from, to: draft.to }, { ...(draft.id ? { id: draft.id } : {}), ...(draft.hash ? { expectedHash: draft.hash } : {}) })) close()
  }
  return <section className={styles.redirects} data-site-panel="redirects">
    <header><h2>Redirects</h2><p>Send an old public address to its current destination through the reviewed release.</p></header>
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Current redirects" data-redirects-table>
      <table><caption className={styles.srOnly}>Current redirects</caption><thead><tr><th>Old address</th><th>Goes to</th><th>Created by</th><th>Hits</th><th><span className={styles.srOnly}>Actions</span></th></tr></thead>
        <tbody>{redirects.length ? redirects.map(item => <tr key={item.id} data-redirect-row><td><code>{item.from}</code></td><td><code>{item.to}</code></td><td>{item.createdBy ?? 'Not recorded'}</td><td>{item.hitCount}</td><td><button type="button" data-redirect-action="edit" onClick={() => setDraft({ id: item.id, from: item.from, to: item.to, hash: item.hash })}>Edit</button></td></tr>) : <tr><td colSpan={5} className={styles.empty}>No redirects have been added.</td></tr>}</tbody>
      </table>
    </div>
    {!draft ? <button className={styles.addRedirect} type="button" data-redirect-action="add" onClick={() => setDraft(emptyDraft)}>+ Add redirect</button> :
      <form className={styles.redirectForm} data-redirect-form data-redirect-form-mode={draft.id ? 'edit' : 'add'} onSubmit={event => void submit(event)}>
        <fieldset disabled={busy}><legend>{draft.id ? 'Edit redirect' : 'Add redirect'}</legend><label>Old address<input ref={oldAddress} required pattern="/.*" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} placeholder="/old-page" /></label><label>Goes to<input required pattern="/.*" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} placeholder="/new-page" /></label><div><button type="submit" data-redirect-action="save" disabled={!canSave}>{draft.id ? 'Save redirect' : 'Add redirect'}</button><button type="button" data-redirect-action="cancel" onClick={close}>Cancel</button></div></fieldset>
      </form>}
  </section>
}
