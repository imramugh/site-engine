'use client'

import { useEffect, useState } from 'react'

type Message = { id: string; direction: string; sender: string; recipient: string; subject: string; body: string; receivedAt: string; attachments: Array<{ name: string; contentType: string; size: number }> }

export function MailThreadTimeline({ target, id }: { target: 'lead' | 'application'; id: string }) {
  const [messages, setMessages] = useState<Message[]>([])
  useEffect(() => { const controller = new AbortController(); void fetch(`/api/mail-threads/${target}/${id}`, { cache: 'no-store', signal: controller.signal }).then(async response => response.ok ? response.json() as Promise<{ messages: Message[] }> : { messages: [] }).then(value => setMessages(value.messages)).catch(() => undefined); return () => controller.abort() }, [target, id])
  if (!messages.length) return null
  return <section aria-label="Mail timeline"><h3>Mail history</h3><ol>{messages.map(message => <li key={message.id}><p><strong>{message.direction === 'outbound' ? 'Sent' : 'Received'}</strong> · <time dateTime={message.receivedAt}>{new Date(message.receivedAt).toLocaleString()}</time></p><p>{message.sender} → {message.recipient}</p><p><strong>{message.subject}</strong></p><p style={{ whiteSpace: 'pre-wrap' }}>{message.body}</p>{message.attachments.length > 0 && <p>{message.attachments.map(attachment => attachment.name || attachment.contentType).filter(Boolean).join(', ')}</p>}</li>)}</ol></section>
}
