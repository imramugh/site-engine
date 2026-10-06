'use client'

import { useEffect, useId, useState } from 'react'
import styles from './mail-reply-composer.module.css'

type Envelope = { id: string; sender: string; recipient: string; subject: string; body: string }
type Options = { senders: Array<{ address: string; label: string }>; threads: Array<{ id: string; subject: string }>; canAuthorize: boolean }
type ReplyResponse = { error?: string; draft?: Envelope; authorization?: { id: string } }

export function MailReplyComposer({ target, id, recipient }: { target: 'lead' | 'application'; id: string; recipient: string }) {
  const formID = useId()
  const endpoint = `/api/mail-replies/${target}/${id}`
  const [options, setOptions] = useState<Options | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [sender, setSender] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [threadID, setThreadID] = useState('')
  const [draft, setDraft] = useState<Envelope | null>(null)
  const [grant, setGrant] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [terminal, setTerminal] = useState<'sent' | 'unknown' | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoadError('')
    void fetch(endpoint, { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Reply addresses could not be loaded.')
      const value = await response.json() as Options
      setOptions(value)
      setSender(value.senders[0]?.address ?? '')
      const threads = value.threads ?? []
      setThreadID(threads[0]?.id ?? '')
      if (!subject && threads[0]?.subject) setSubject(threads[0].subject)
    }).catch((error: unknown) => { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'Reply addresses could not be loaded.') })
    return () => controller.abort()
  }, [endpoint, reload])

  async function call(action: string, key?: string): Promise<ReplyResponse> {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action === 'prepare' ? { action, sender, subject, body, ...(threadID ? { threadID } : {}) } : { action, grantID: key }),
    })
    const value = await response.json() as ReplyResponse
    if (!response.ok) throw new Error(value.error || 'The reply could not be processed.')
    return value
  }

  async function action(kind: 'prepare' | 'authorize' | 'edit' | 'send') {
    if (busy || terminal) return
    setBusy(true)
    setStatus('')
    try {
      if (kind === 'prepare') {
        const value = await call('prepare')
        if (!value.draft) throw new Error('The prepared reply was not returned.')
        setDraft(value.draft)
        setStatus('Review the exact reply before confirming.')
      } else if (kind === 'authorize') {
        const value = await call('authorize', draft?.id)
        if (!value.authorization) throw new Error('Confirmation was not returned.')
        setGrant(value.authorization.id)
        setStatus('Confirmed for this message only. Send within 10 minutes.')
      } else if (kind === 'edit') {
        if (grant) await call('cancel', grant)
        setGrant('')
        setDraft(null)
        setStatus('Any changes require a new confirmation.')
      } else {
        // Do not offer a retry when a request may have reached the provider.
        setTerminal('unknown')
        await call('send', grant)
        setTerminal('sent')
        setStatus('Reply sent.')
      }
    } catch (error) {
      setStatus(kind === 'send' ? 'Delivery could not be confirmed. Check the mailbox before preparing another reply; this confirmation cannot be reused.' : error instanceof Error ? error.message : 'The reply could not be processed.')
    } finally { setBusy(false) }
  }

  return <section className={styles.composer} data-mail-reply-composer aria-labelledby={`${formID}-heading`}>
    <h3 id={`${formID}-heading`}>Reply</h3>
    <p className={styles.recipient}>To {recipient}</p>
    {loadError ? <><p role="alert">{loadError}</p><button type="button" onClick={() => setReload(value => value + 1)}>Retry loading addresses</button></> : !options ? <p role="status">Loading reply addresses…</p> : !options.senders.length ? <p className={styles.notice}>An Owner needs to connect and assign a verified {target === 'lead' ? 'Leads' : 'Careers'} address in Integrations → Email before replies can be sent.</p> : <>
      {!draft ? <form onSubmit={event => { event.preventDefault(); void action('prepare') }}>
        <label htmlFor={`${formID}-sender`}>Reply from</label>
        <select id={`${formID}-sender`} aria-label="Reply sender" value={sender} onChange={event => setSender(event.target.value)} disabled={busy} required>
          {options.senders.map(item => <option key={item.address} value={item.address}>{item.label} · {item.address}</option>)}
        </select>
        {(options.threads ?? []).length > 0 && <><label htmlFor={`${formID}-thread`}>Existing conversation</label><select id={`${formID}-thread`} aria-label="Existing conversation" value={threadID} onChange={event => { const selected = (options.threads ?? []).find(item => item.id === event.target.value); setThreadID(event.target.value); if (selected) setSubject(selected.subject) }} disabled={busy}><option value="">Start a new message</option>{(options.threads ?? []).map(item => <option key={item.id} value={item.id}>{item.subject}</option>)}</select></>}
        <label htmlFor={`${formID}-subject`}>Subject</label>
        <input id={`${formID}-subject`} aria-label="Reply subject" value={subject} onChange={event => setSubject(event.target.value)} disabled={busy} maxLength={200} required />
        <label htmlFor={`${formID}-body`}>Message</label>
        <textarea id={`${formID}-body`} aria-label="Reply message" rows={4} placeholder="Write a reply…" value={body} onChange={event => setBody(event.target.value)} disabled={busy} maxLength={10_000} required />
        <div className={styles.actions}><button className={styles.primary} type="submit" disabled={busy}>{busy ? 'Preparing…' : 'Prepare reply'}</button></div>
      </form> : <>
        <section className={styles.review} aria-label="Exact reply review">
          <h4>Review reply</h4>
          <dl><dt>From</dt><dd>{draft.sender}</dd><dt>To</dt><dd>{draft.recipient}</dd><dt>Subject</dt><dd>{draft.subject}</dd></dl>
          <p className={styles.body}>{draft.body}</p>
        </section>
        {!terminal && <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={() => void action('edit')}>{grant ? 'Cancel confirmation and edit' : 'Edit reply'}</button>
          {options.canAuthorize && <button className={styles.primary} type="button" disabled={busy} onClick={() => void action(grant ? 'send' : 'authorize')}>{busy ? 'Working…' : grant ? 'Send confirmed reply' : 'Confirm exact reply'}</button>}
        </div>}
        {!options.canAuthorize && <p className={styles.notice}>An Owner must confirm this reply before it can be sent.</p>}
      </>}
    </>}
    {status && <p className={styles.notice} role="status">{status}</p>}
  </section>
}
