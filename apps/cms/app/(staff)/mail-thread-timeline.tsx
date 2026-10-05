'use client'

import { useEffect, useState } from 'react'
import styles from './mail-thread-timeline.module.css'

type Message = { id: string; direction: string; sender: string; recipient: string; subject: string; body: string; receivedAt: string; attachments: Array<{ name: string; contentType: string; size: number }> }

export function MailThreadTimeline({ target, id }: { target: 'lead' | 'application'; id: string }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [truncated, setTruncated] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [retry, setRetry] = useState(0)
  useEffect(() => { const controller = new AbortController(); setMessages([]); setTruncated(false); setLoading(true); setError(''); void fetch(`/api/mail-threads/${target}/${id}`, { cache: 'no-store', signal: controller.signal }).then(async response => { if (!response.ok) throw new Error('history'); return response.json() as Promise<{ messages: Message[]; truncated?: boolean }> }).then(value => { if (!controller.signal.aborted) { setMessages(value.messages); setTruncated(Boolean(value.truncated)) } }).catch(() => { if (!controller.signal.aborted) setError('Mail history could not be loaded.') }).finally(() => { if (!controller.signal.aborted) setLoading(false) }); return () => controller.abort() }, [target, id, retry])
  return <section className={styles.timeline} aria-label="Mail timeline"><h3>Mail history</h3>{loading ? <p role="status">Loading mail history…</p> : error ? <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></p> : !messages.length ? <p>No matched mail in this conversation yet.</p> : <><ol>{messages.map(message => <li key={message.id}><p><strong>{message.direction === 'outbound' ? 'Sent' : 'Received'}</strong> · <time dateTime={message.receivedAt}>{new Date(message.receivedAt).toLocaleString()}</time></p><p>{message.sender} → {message.recipient}</p><p><strong>{message.subject}</strong></p><p className={styles.body}>{message.body}</p>{message.attachments.length > 0 && <p>{message.attachments.map(attachment => attachment.name || attachment.contentType).filter(Boolean).join(', ')}</p>}</li>)}</ol>{truncated && <p role="status">Showing the 100 most recent messages. Older mail is not loaded.</p>}</>}</section>
}
