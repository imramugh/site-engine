import { describe, expect, it } from 'vitest'
import { gmailAdapter, gmailIdentity, gmailThreadReader, microsoftAdapter, microsoftIdentity } from '../src/mail-provider-adapters'
describe('mail provider adapters',()=>{it('creates then sends a Graph draft once to preserve its provider thread binding',async()=>{const calls:string[]=[];const graph=microsoftAdapter(async(url)=>{calls.push(url);if(url.endsWith('/me/messages'))return Response.json({id:'draft-id',conversationId:'conversation-id'});if(url.endsWith('/me/messages/draft-id/send'))return new Response(null,{status:202});throw new Error('unexpected')},'a@test.test');await expect(graph.send('token',{sender:'a@test.test',recipient:'b@test.test',subject:'s',body:'b'})).resolves.toEqual({accepted:true,id:'draft-id',threadID:'conversation-id'});expect(calls).toEqual(['https://graph.microsoft.com/v1.0/me/messages','https://graph.microsoft.com/v1.0/me/messages/draft-id/send'])});it('requires configured exact sender',async()=>{let calls=0;const graph=microsoftAdapter(async()=>{calls++;return new Response(null,{status:202})},'');await expect(graph.send('t',{sender:'a@test.test',recipient:'b@test.test',subject:'s',body:'b'})).rejects.toThrow('sender_not_verified');expect(calls).toBe(0)})})
describe('adapter boundary denials',()=>{it('rejects injected headers and unverified send-as',async()=>{const graph=microsoftAdapter(async()=>new Response(null,{status:202}),'ok@example.test');await expect(graph.send('t',{sender:'bad@example.test',recipient:'x@example.test',subject:'s',body:'b'})).rejects.toThrow('sender_not_verified');const google=gmailAdapter(async()=>new Response('{}'),'a@example.test');await expect(google.send('t',{sender:'different@example.test',recipient:'b@example.test',subject:'s',body:'b'})).rejects.toThrow('sender_not_verified');await expect(google.send('t',{sender:'a@example.test',recipient:'b@example.test',subject:'ok\r\nBcc:x@example.test',body:'b'})).rejects.toThrow('invalid_envelope')});it('bounds and redacts provider reads',async()=>{const graph=microsoftAdapter(async()=>new Response('x'.repeat(262145),{status:200}),'a@example.test');await expect(graph.thread('t','id')).rejects.toThrow('provider_response_too_large');await expect(microsoftAdapter(async()=>new Response('no',{status:403}),'a@example.test').thread('t','id')).rejects.toThrow('provider_forbidden')})})
describe('mailbox identity discovery',()=>{it('keeps only provider verified aliases',async()=>{const google=gmailIdentity(async url=>new Response(JSON.stringify(url.includes('profile')?{emailAddress:'main@example.test'}:{sendAs:[{sendAsEmail:'ok@example.test',verificationStatus:'accepted'},{sendAsEmail:'no@example.test',verificationStatus:'pending'}]})));await expect(google('t')).resolves.toEqual({primaryAddress:'main@example.test',verifiedSenders:['main@example.test','ok@example.test']});const graph=microsoftIdentity(async()=>new Response(JSON.stringify({mail:'main@example.test',proxyAddresses:['SMTP:main@example.test','smtp:alias@example.test']})));await expect(graph('t')).resolves.toMatchObject({verifiedSenders:['main@example.test']})})})
it('rejects declared oversized provider responses before parsing',async()=>{const graph=microsoftAdapter(async()=>new Response('{}',{headers:{'content-length':'262145'}}),'a@example.test');await expect(graph.thread('t','x')).rejects.toThrow('provider_response_too_large')})
it('rejects injected RFC reference headers before Gmail delivery', async () => {
  let calls = 0
  const gmail = gmailAdapter(async () => { calls += 1; return Response.json({ id: 'sent', threadId: 'thread' }) }, 'staff@example.test')
  await expect(gmail.send('token', { sender: 'staff@example.test', recipient: 'visitor@example.test', subject: 'Subject', body: 'Body', threadID: 'thread', rfcMessageID: '<original@example.test>', rfcReferences: '<root@example.test>\r\nBcc: injected@example.test' })).rejects.toThrow('invalid_envelope')
  expect(calls).toBe(0)
})

describe('Graph delta provider contracts', () => {
  it('uses only the fixed delta endpoint, preserves a validated cursor, and rejects hostile links', async () => {
    const calls: string[] = []
    const adapter = microsoftAdapter(async (url, init) => {
      calls.push(url); expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal)
      return Response.json({ value: [{ id: 'message-1', conversationId: 'conversation-1', subject: '<b>Hello</b>', body: { content: '<p>Body</p>' }, from: { emailAddress: { address: 'visitor@example.test' } }, toRecipients: [{ emailAddress: { address: 'staff@example.test' } }], receivedDateTime: '2026-10-05T00:00:00Z' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=opaque-token' })
    }, 'staff@example.test')
    await expect(adapter.poll('token', 'inbox')).resolves.toMatchObject({ cursor: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=opaque-token', messages: [{ threadId: 'conversation-1', body: 'Body' }] })
    expect(calls[0]).toContain('/v1.0/me/mailFolders/inbox/messages/delta?')
    await expect(adapter.poll('token', 'inbox', 'https://evil.example/v1.0/me/messages/delta?$deltatoken=steal')).rejects.toThrow('invalid_cursor')
    const hostile = microsoftAdapter(async () => Response.json({ value: [], '@odata.nextLink': 'https://evil.example/redirect?$skiptoken=steal' }), 'staff@example.test')
    await expect(hostile.poll('token', 'inbox')).rejects.toThrow('invalid_cursor')
  })

  it('maps authorization failures and malformed delta bodies without retrying', async () => {
    const denied = microsoftAdapter(async () => new Response('no', { status: 401 }), 'staff@example.test')
    await expect(denied.poll('token', 'inbox')).rejects.toThrow('provider_unauthorized')
    const malformed = microsoftAdapter(async () => Response.json({ value: 'not-an-array' }), 'staff@example.test')
    await expect(malformed.poll('token', 'inbox')).rejects.toThrow('provider_malformed_response')
  })

  it('requests bounded pages and refuses oversized Graph or Gmail pages', async () => {
    let headers: HeadersInit | undefined
    const graph = microsoftAdapter(async (_url, init) => { headers = init.headers; return Response.json({ value: Array.from({ length: 501 }, () => ({})) }) }, 'staff@example.test')
    await expect(graph.poll('token', 'inbox')).rejects.toThrow('provider_page_too_large')
    expect(new Headers(headers).get('prefer')).toBe('odata.maxpagesize=100')
    let gmailURL = ''
    const gmail = gmailAdapter(async (url) => { gmailURL = url; return Response.json({ historyId: '22', history: Array.from({ length: 501 }, () => ({})) }) }, 'staff@example.test')
    await expect(gmail.poll('token', '21')).rejects.toThrow('provider_page_too_large')
    expect(gmailURL).toContain('maxResults=100')
  })
})

describe('provider-shaped threaded reads', () => {
  it('uses Graph reply and permits opaque Graph identifiers', async () => {
    let url = ''
    const adapter = microsoftAdapter(async value => { url = value; return new Response(null, { status: 202 }) }, 'staff@example.test')
    await adapter.send('token', { sender: 'staff@example.test', recipient: 'visitor@example.test', subject: 'Re', body: 'Reply', threadID: 'conversation-1', replyMessageID: 'AQMkAD+=/opaque' })
    expect(url).toContain('/messages/AQMkAD%2B%3D%2Fopaque/reply')
  })
  it('normalizes Gmail MIME body, date and attachment metadata', async () => {
    const read = gmailThreadReader(async () => Response.json({ id: 't_1', messages: [{ id: 'm1', threadId: 't_1', internalDate: '1760000000000', payload: { headers: [{ name: 'From', value: 'Visitor <visitor@example.test>' }, { name: 'To', value: 'Staff <staff@example.test>' }, { name: 'Subject', value: 'Hello' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Hello <b>world</b>').toString('base64url') } }, { mimeType: 'application/pdf', filename: 'cv.pdf', body: { attachmentId: 'a1', size: 12 } }] } }] }))
    await expect(read('token', 't_1')).resolves.toMatchObject([{ messageId: 'm1', body: 'Hello world', date: '2025-10-09T08:53:20.000Z', attachments: [{ name: 'cv.pdf', contentType: 'application/pdf', size: 12 }] }])
  })
  it('accepts Gmail no-change history and pages it', async () => {
    const urls: string[] = []; const adapter = gmailAdapter(async url => { urls.push(url); return Response.json({ historyId: '22', nextPageToken: 'next+token' }) }, 'staff@example.test')
    await expect(adapter.poll('token', '21')).resolves.toEqual({ historyID: '22', nextPageToken: 'next+token', entries: [] })
    await adapter.poll('token', '22', 'next+token')
    expect(urls[1]).toContain('pageToken=next%2Btoken')
  })
})
