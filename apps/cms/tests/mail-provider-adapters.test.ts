import { describe, expect, it } from 'vitest'
import { gmailAdapter, gmailIdentity, gmailThreadReader, microsoftAdapter, microsoftIdentity } from '../src/mail-provider-adapters'
describe('mail provider adapters',()=>{it('creates then sends a Graph draft once to preserve its provider thread binding',async()=>{const calls:Array<{url:string;headers:Headers}>=[];const graph=microsoftAdapter(async(url,init)=>{calls.push({url,headers:new Headers(init.headers)});if(url.endsWith('/me/messages'))return Response.json({id:'draft-id',conversationId:'conversation-id'});if(url.endsWith('/me/messages/draft-id/send'))return new Response(null,{status:202});throw new Error('unexpected')},'a@test.test');await expect(graph.send('token',{sender:'a@test.test',recipient:'b@test.test',subject:'s',body:'b'})).resolves.toEqual({accepted:true,id:'draft-id',threadID:'conversation-id'});expect(calls.map(call=>call.url)).toEqual(['https://graph.microsoft.com/v1.0/me/messages','https://graph.microsoft.com/v1.0/me/messages/draft-id/send']);expect(calls.every(call=>call.headers.get('prefer')==='IdType=\"ImmutableId\"')).toBe(true)});it('requires configured exact sender',async()=>{let calls=0;const graph=microsoftAdapter(async()=>{calls++;return new Response(null,{status:202})},'');await expect(graph.send('t',{sender:'a@test.test',recipient:'b@test.test',subject:'s',body:'b'})).rejects.toThrow('sender_not_verified');expect(calls).toBe(0)})})
describe('adapter boundary denials',()=>{it('rejects injected headers and unverified send-as',async()=>{const graph=microsoftAdapter(async()=>new Response(null,{status:202}),'ok@example.test');await expect(graph.send('t',{sender:'bad@example.test',recipient:'x@example.test',subject:'s',body:'b'})).rejects.toThrow('sender_not_verified');const google=gmailAdapter(async()=>new Response('{}'),'a@example.test');await expect(google.send('t',{sender:'different@example.test',recipient:'b@example.test',subject:'s',body:'b'})).rejects.toThrow('sender_not_verified');await expect(google.send('t',{sender:'a@example.test',recipient:'b@example.test',subject:'ok\r\nBcc:x@example.test',body:'b'})).rejects.toThrow('invalid_envelope')});it('bounds and redacts provider reads',async()=>{const graph=microsoftAdapter(async()=>new Response('x'.repeat(262145),{status:200}),'a@example.test');await expect(graph.thread('t','id')).rejects.toThrow('provider_response_too_large');await expect(microsoftAdapter(async()=>new Response('no',{status:403}),'a@example.test').thread('t','id')).rejects.toThrow('provider_forbidden')})})

it('uses authenticated Graph session creation then bearer-free Outlook chunks before send', async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024); const digest = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'); const calls: Array<{ url: string, init: RequestInit }> = []
  const uploadURL = "https://outlook.office.com/api/v2.0/Users('a%40test.test')/Messages('draft')/AttachmentSessions('opaque')?authtoken=opaque"
  const adapter = microsoftAdapter(async (url, init) => { calls.push({ url, init }); if (url.endsWith('/me/messages')) return Response.json({ id: 'draft', conversationId: 'thread' }); if (url.endsWith('/createUploadSession')) return Response.json({ uploadUrl: uploadURL }, { status: 201 }); if (url === uploadURL) { const range = new Headers(init.headers).get('content-range')!; return range.endsWith(`${bytes.length - 1}/${bytes.length}`) ? Response.json({ id: 'done' }, { status: 201 }) : Response.json({ nextExpectedRanges: [`${Number(range.match(/-(\d+)\//)?.[1]) + 1}-`] }, { status: 200 }) } if (url.endsWith('/send')) return new Response(null, { status: 202 }); throw new Error(url) }, 'a@test.test')
  await adapter.send('token', { sender: 'a@test.test', recipient: 'b@test.test', subject: 's', body: 'b', attachments: [{ filename: 'large.pdf', mimeType: 'application/pdf', size: bytes.length, sha256: digest, bytes }] })
  expect(calls.find(call => call.url.endsWith('/createUploadSession'))?.init.headers).toMatchObject({ authorization: 'Bearer token' })
  expect(calls.filter(call => call.url.startsWith('https://outlook.office.com/')).every(call => !new Headers(call.init.headers).has('authorization') && call.init.redirect === 'error')).toBe(true)
  expect(calls.at(-1)?.url).toMatch(/\/send$/)
})
describe('mailbox identity discovery',()=>{it('keeps only provider verified aliases',async()=>{const google=gmailIdentity(async url=>new Response(JSON.stringify(url.includes('profile')?{emailAddress:'main@example.test'}:{sendAs:[{sendAsEmail:'ok@example.test',verificationStatus:'accepted'},{sendAsEmail:'no@example.test',verificationStatus:'pending'}]})));await expect(google('t')).resolves.toEqual({primaryAddress:'main@example.test',verifiedSenders:['main@example.test','ok@example.test']});const graph=microsoftIdentity(async()=>new Response(JSON.stringify({mail:'main@example.test',proxyAddresses:['SMTP:main@example.test','smtp:alias@example.test']})));await expect(graph('t')).resolves.toMatchObject({verifiedSenders:['main@example.test']})})})
it('rejects declared oversized provider responses before parsing',async()=>{const graph=microsoftAdapter(async()=>new Response('{}',{headers:{'content-length':'262145'}}),'a@example.test');await expect(graph.thread('t','x')).rejects.toThrow('provider_response_too_large')})
it('rejects injected RFC reference headers before Gmail delivery', async () => {
  let calls = 0
  const gmail = gmailAdapter(async () => { calls += 1; return Response.json({ id: 'sent', threadId: 'thread' }) }, 'staff@example.test')
  await expect(gmail.send('token', { sender: 'staff@example.test', recipient: 'visitor@example.test', subject: 'Subject', body: 'Body', threadID: 'thread', rfcMessageID: '<original@example.test>', rfcReferences: '<root@example.test>\r\nBcc: injected@example.test' })).rejects.toThrow('invalid_envelope')
  expect(calls).toBe(0)
})

describe('Graph delta provider contracts', () => {
  it('records only retrievable Graph file or item attachment references from a fixed endpoint', async () => {
    const urls: string[] = []
    const adapter = microsoftAdapter(async (url) => {
      urls.push(url)
      if (url.includes('/attachments?')) return Response.json({ value: [{ id: 'file-1', name: 'cv.pdf', contentType: 'application/pdf', size: 12, '@odata.type': '#microsoft.graph.fileAttachment' }, { id: 'reference-1', name: 'cloud', '@odata.type': '#microsoft.graph.referenceAttachment' }] })
      return Response.json({ value: [{ id: 'message-1', conversationId: 'conversation-1', hasAttachments: true, subject: 'Hello', body: { content: 'Body' }, from: { emailAddress: { address: 'visitor@example.test' } }, toRecipients: [{ emailAddress: { address: 'staff@example.test' } }], receivedDateTime: '2026-10-05T00:00:00Z' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=opaque-token' })
    }, 'staff@example.test')
    await expect(adapter.poll('token', 'inbox')).resolves.toMatchObject({ messages: [{ attachments: [], attachmentsPending: true }] })
    await expect(adapter.attachments('token', 'message-1')).resolves.toMatchObject([{ name: 'cv.pdf', providerAttachmentID: 'file-1' }])
    expect(urls[1]).toBe('https://graph.microsoft.com/v1.0/me/messages/message-1/attachments?$select=id,name,contentType,size&$top=20')
  })
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
    expect(new Headers(headers).get('prefer')).toBe('odata.maxpagesize=100, IdType="ImmutableId"')
    let gmailURL = ''
    const gmail = gmailAdapter(async (url) => { gmailURL = url; return Response.json({ historyId: '22', history: Array.from({ length: 501 }, () => ({})) }) }, 'staff@example.test')
    await expect(gmail.poll('token', '21')).rejects.toThrow('provider_page_too_large')
    expect(gmailURL).toContain('maxResults=100')
  })
})

describe('provider-shaped threaded reads', () => {
  it('creates and sends a Graph reply draft with a durable provider receipt', async () => {
    const urls: string[] = []
    const adapter = microsoftAdapter(async value => { urls.push(value); return value.endsWith('/createReply') ? Response.json({ id: 'reply-draft' }) : new Response(null, { status: 202 }) }, 'staff@example.test')
    await expect(adapter.send('token', { sender: 'staff@example.test', recipient: 'visitor@example.test', subject: 'Re', body: 'Reply', threadID: 'conversation-1', replyMessageID: 'AQMkAD+=/opaque' })).resolves.toEqual({ accepted: true, id: 'reply-draft' })
    expect(urls).toEqual(['https://graph.microsoft.com/v1.0/me/messages/AQMkAD%2B%3D%2Fopaque/createReply', 'https://graph.microsoft.com/v1.0/me/messages/reply-draft/send'])
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

describe('Graph upload-session URL boundary', () => {
  const bytes = new Uint8Array(3 * 1024 * 1024)
  const bad = ['http://outlook.office.com/api/v2.0/AttachmentSessions(\'x\')?t=1','https://127.0.0.1/api/v2.0/AttachmentSessions(\'x\')?t=1','https://evil.example/api/v2.0/AttachmentSessions(\'x\')?t=1','https://outlook.office.com:444/api/v2.0/AttachmentSessions(\'x\')?t=1','https://u@outlook.office.com/api/v2.0/AttachmentSessions(\'x\')?t=1','https://outlook.office.com/api/v2.0/AttachmentSessions(\'x\')?t=1#x']
  for (const uploadUrl of bad) it(`rejects ${uploadUrl}`, async () => { const calls:string[]=[]; const digest=(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'); const graph=microsoftAdapter(async url=>{calls.push(url); return url.endsWith('/me/messages')?Response.json({id:'draft',conversationId:'thread'}):Response.json({uploadUrl},{status:201})},'a@test.test'); await expect(graph.send('t',{sender:'a@test.test',recipient:'b@test.test',subject:'s',body:'b',attachments:[{filename:'large.pdf',mimeType:'application/pdf',size:bytes.length,sha256:digest,bytes}]})).rejects.toThrow('provider_malformed_response'); expect(calls.some(url=>url.endsWith('/send'))).toBe(false); expect(calls).not.toContain(uploadUrl) })
})

describe('Graph upload-session response boundary', () => {
  const bytes = new Uint8Array(3 * 1024 * 1024)
  const url="https://outlook.office.com/api/v2.0/Users('a')/Messages('draft')/AttachmentSessions('x')?authtoken=x"
  for (const mode of ['offset','intermediate202','final200','429','403','session','network']) it(`rejects ${mode} without send`, async () => { const calls:string[]=[]; const digest=(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'); let n=0; const graph=microsoftAdapter(async target=>{calls.push(target); if(target.endsWith('/me/messages'))return Response.json({id:'draft',conversationId:'thread'}); if(target.endsWith('/createUploadSession'))return mode==='session'?new Response('',{status:403}):Response.json({uploadUrl:url},{status:201}); if(target===url){n++; if(mode==='network')throw Error('offline'); if(mode==='429')return new Response('',{status:429}); if(mode==='403')return new Response('',{status:403}); const final=n===10; if(mode==='final200'&&final)return Response.json({}, {status:200}); if(mode==='intermediate202'&&!final)return Response.json({nextExpectedRanges:['327680-']},{status:202}); return Response.json({nextExpectedRanges:[mode==='offset'?'1-':`${n*327680}-`]},{status:200})} throw Error(target)},'a@test.test'); await expect(graph.send('t',{sender:'a@test.test',recipient:'b@test.test',subject:'s',body:'b',attachments:[{filename:'large.pdf',mimeType:'application/pdf',size:bytes.length,sha256:digest,bytes}]})).rejects.toThrow(); expect(calls.some(x=>x.endsWith('/send'))).toBe(false) })
})

it('uploads varied large reply bytes contiguously before sending', async () => { const bytes=Uint8Array.from({length:3*1024*1024},(_,i)=>i%251); const digest=(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'); const url="https://outlook.office.com/api/v2.0/Users('a')/Messages('reply')/AttachmentSessions('x')?authtoken=x"; const chunks:Uint8Array[]=[]; const ranges:string[]=[]; const calls:string[]=[]; const graph=microsoftAdapter(async (target,init)=>{calls.push(target); if(target.endsWith('/createReply'))return Response.json({id:'reply'}); if(target.endsWith('/createUploadSession'))return Response.json({uploadUrl:url,nextExpectedRanges:['0-']},{status:201}); if(target===url){ranges.push(new Headers(init.headers).get('content-range')!); chunks.push(new Uint8Array(init.body as Uint8Array)); const last=ranges.at(-1)!.endsWith(`${bytes.length-1}/${bytes.length}`); return last?Response.json({id:'done'},{status:201}):Response.json({nextExpectedRanges:[`${chunks.reduce((n,x)=>n+x.length,0)}-`]},{status:200})} if(target.endsWith('/send'))return new Response(null,{status:202}); throw Error(target)},'a@test.test'); await graph.send('t',{sender:'a@test.test',recipient:'b@test.test',subject:'s',body:'b',threadID:'thread',replyMessageID:'original',attachments:[{filename:'large.pdf',mimeType:'application/pdf',size:bytes.length,sha256:digest,bytes}]}); expect(Buffer.concat(chunks.map(x=>Buffer.from(x))).equals(Buffer.from(bytes))).toBe(true); expect(ranges[0]).toBe(`bytes 0-327679/${bytes.length}`); expect(calls.at(-1)).toMatch(/\/send$/) }, 15000)
