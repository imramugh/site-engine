import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { gmailAdapter, microsoftAdapter, type Envelope, type VerifiedAttachment } from '../src/mail-provider-adapters'

const bytes = Buffer.from('verified attachment bytes\x00', 'utf8')
const attachment: VerifiedAttachment = Object.freeze({ filename: 'brief.pdf', mimeType: 'application/pdf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
const envelope: Envelope = { sender: 'team@example.test', recipient: 'recipient@example.test', subject: 'Reviewed attachment', body: 'Approved body.' }

test('serializes immutable verified bytes as Graph fileAttachment before sending a new message', async () => {
  const requests: Array<{ url: string; body?: string }> = []
  const adapter = microsoftAdapter(async (url, init) => {
    requests.push({ url, body: init.body ? String(init.body) : undefined })
    if (url.endsWith('/me/messages')) return Response.json({ id: 'draft-id', conversationId: 'conversation-id' })
    if (url.endsWith('/me/messages/draft-id/attachments')) return Response.json({ id: 'attachment-id' }, { status: 201 })
    if (url.endsWith('/me/messages/draft-id/send')) return new Response(null, { status: 202 })
    throw new Error(`unexpected ${url}`)
  }, envelope.sender)
  await expect(adapter.send('token', { ...envelope, attachments: [attachment] })).resolves.toEqual({ accepted: true, id: 'draft-id', threadID: 'conversation-id' })
  expect(requests.map(({ url }) => url)).toEqual([
    'https://graph.microsoft.com/v1.0/me/messages',
    'https://graph.microsoft.com/v1.0/me/messages/draft-id/attachments',
    'https://graph.microsoft.com/v1.0/me/messages/draft-id/send',
  ])
  expect(JSON.parse(requests[1]!.body!)).toEqual({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'brief.pdf', contentType: 'application/pdf', contentBytes: bytes.toString('base64') })
})

test('creates a Graph reply draft, attaches exact bytes, then sends it', async () => {
  const urls: string[] = []
  const adapter = microsoftAdapter(async (url, init) => {
    urls.push(url)
    if (url.endsWith('/me/messages/original-id/createReply')) return Response.json({ id: 'reply-draft' })
    if (url.endsWith('/me/messages/reply-draft/attachments')) return Response.json({ id: 'attached' }, { status: 201 })
    if (url.endsWith('/me/messages/reply-draft/send')) return new Response(null, { status: 202 })
    throw new Error(String(init.body))
  }, envelope.sender)
  await expect(adapter.send('token', { ...envelope, replyMessageID: 'original-id', attachments: [attachment] })).resolves.toEqual({ accepted: true })
  expect(urls).toEqual([
    'https://graph.microsoft.com/v1.0/me/messages/original-id/createReply',
    'https://graph.microsoft.com/v1.0/me/messages/reply-draft/attachments',
    'https://graph.microsoft.com/v1.0/me/messages/reply-draft/send',
  ])
})

test('serializes Gmail attachment MIME with exact bytes and reply threading headers', async () => {
  let sent: Record<string, unknown> | undefined
  const adapter = gmailAdapter(async (url, init) => {
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
    sent = JSON.parse(String(init.body)); return Response.json({ id: 'gmail-id', threadId: 'gmail-thread' })
  }, envelope.sender)
  await expect(adapter.send('token', { ...envelope, threadID: 'gmail-thread', rfcMessageID: '<original@example.test>', rfcReferences: '<earlier@example.test>', attachments: [attachment] })).resolves.toEqual({ accepted: true, id: 'gmail-id', threadID: 'gmail-thread' })
  expect(sent?.threadId).toBe('gmail-thread')
  const raw = Buffer.from(String(sent?.raw), 'base64url').toString('utf8')
  expect(raw).toContain('In-Reply-To: <original@example.test>\r\nReferences: <earlier@example.test> <original@example.test>')
  expect(raw).toContain('Content-Type: application/pdf; name="brief.pdf"')
  expect(raw).toContain('Content-Disposition: attachment; filename="brief.pdf"')
  expect(raw).toContain(bytes.toString('base64'))
})

test('rejects bad attachment envelope before a provider call', async () => {
  let calls = 0
  for (const filename of ['bad\r\nBcc: injected@example.test', 'quoted"name.pdf', `deleted${String.fromCharCode(127)}name.pdf`]) {
    await expect(gmailAdapter(async () => { calls += 1; return Response.json({}) }, envelope.sender).send('token', { ...envelope, attachments: [{ ...attachment, filename }] })).rejects.toThrow('invalid_attachments')
  }
  await expect(microsoftAdapter(async () => { calls += 1; return Response.json({}) }, envelope.sender).send('token', { ...envelope, attachments: [{ ...attachment, size: attachment.size + 1 }] })).rejects.toThrow('invalid_attachments')
  await expect(gmailAdapter(async () => { calls += 1; return Response.json({}) }, envelope.sender).send('token', { ...envelope, attachments: Array.from({ length: 6 }, () => attachment) })).rejects.toThrow('invalid_attachments')
  expect(calls).toBe(0)
})
