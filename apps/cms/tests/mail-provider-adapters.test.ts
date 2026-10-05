import { describe, expect, it } from 'vitest'
import { gmailAdapter, gmailIdentity, microsoftAdapter, microsoftIdentity } from '../src/mail-provider-adapters'
describe('mail provider adapters',()=>{it('uses fixed HTTPS provider hosts and never retries sends',async()=>{let calls=0;const graph=microsoftAdapter(async(url)=>{calls++;expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');return new Response(null,{status:202})},'a@test.test');await expect(graph.send('token',{sender:'a@test.test',recipient:'b@test.test',subject:'s',body:'b'})).resolves.toEqual({accepted:true});expect(calls).toBe(1)});it('requires configured exact sender',async()=>{let calls=0;const graph=microsoftAdapter(async()=>{calls++;return new Response(null,{status:202})},'');await expect(graph.send('t',{sender:'a@test.test',recipient:'b@test.test',subject:'s',body:'b'})).rejects.toThrow('sender_not_verified');expect(calls).toBe(0)})})
describe('adapter boundary denials',()=>{it('rejects injected headers and unverified send-as',async()=>{const graph=microsoftAdapter(async()=>new Response(null,{status:202}),'ok@example.test');await expect(graph.send('t',{sender:'bad@example.test',recipient:'x@example.test',subject:'s',body:'b'})).rejects.toThrow('sender_not_verified');const google=gmailAdapter(async()=>new Response('{}'),'a@example.test');await expect(google.send('t',{sender:'different@example.test',recipient:'b@example.test',subject:'s',body:'b'})).rejects.toThrow('sender_not_verified');await expect(google.send('t',{sender:'a@example.test',recipient:'b@example.test',subject:'ok\r\nBcc:x@example.test',body:'b'})).rejects.toThrow('invalid_envelope')});it('bounds and redacts provider reads',async()=>{const graph=microsoftAdapter(async()=>new Response('x'.repeat(262145),{status:200}),'a@example.test');await expect(graph.thread('t','id')).rejects.toThrow('provider_response_too_large');await expect(microsoftAdapter(async()=>new Response('no',{status:403}),'a@example.test').thread('t','id')).rejects.toThrow('provider_forbidden')})})
describe('mailbox identity discovery',()=>{it('keeps only provider verified aliases',async()=>{const google=gmailIdentity(async url=>new Response(JSON.stringify(url.includes('profile')?{emailAddress:'main@example.test'}:{sendAs:[{sendAsEmail:'ok@example.test',verificationStatus:'accepted'},{sendAsEmail:'no@example.test',verificationStatus:'pending'}]})));await expect(google('t')).resolves.toEqual({primaryAddress:'main@example.test',verifiedSenders:['main@example.test','ok@example.test']});const graph=microsoftIdentity(async()=>new Response(JSON.stringify({mail:'main@example.test',proxyAddresses:['SMTP:main@example.test','smtp:alias@example.test']})));await expect(graph('t')).resolves.toMatchObject({verifiedSenders:['alias@example.test','main@example.test']})})})
it('rejects declared oversized provider responses before parsing',async()=>{const graph=microsoftAdapter(async()=>new Response('{}',{headers:{'content-length':'262145'}}),'a@example.test');await expect(graph.thread('t','x')).rejects.toThrow('provider_response_too_large')})

describe('Graph delta provider contracts', () => {
  it('uses only the fixed delta endpoint, preserves a validated cursor, and rejects hostile links', async () => {
    const calls: string[] = []
    const adapter = microsoftAdapter(async (url, init) => {
      calls.push(url); expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal)
      return Response.json({ value: [{ id: 'message-1', conversationId: 'conversation-1', subject: '<b>Hello</b>', body: { content: '<p>Body</p>' }, from: { emailAddress: { address: 'visitor@example.test' } }, toRecipients: [{ emailAddress: { address: 'staff@example.test' } }], receivedDateTime: '2026-10-05T00:00:00Z' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=opaque-token' })
    }, 'staff@example.test')
    await expect(adapter.poll('token')).resolves.toMatchObject({ cursor: 'https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=opaque-token', messages: [{ threadId: 'conversation-1', body: 'Body' }] })
    expect(calls[0]).toContain('/v1.0/me/messages/delta?')
    await expect(adapter.poll('token', 'https://evil.example/v1.0/me/messages/delta?$deltatoken=steal')).rejects.toThrow('invalid_cursor')
    const hostile = microsoftAdapter(async () => Response.json({ value: [], '@odata.nextLink': 'https://evil.example/redirect?$skiptoken=steal' }), 'staff@example.test')
    await expect(hostile.poll('token')).rejects.toThrow('invalid_cursor')
  })

  it('maps authorization failures and malformed delta bodies without retrying', async () => {
    const denied = microsoftAdapter(async () => new Response('no', { status: 401 }), 'staff@example.test')
    await expect(denied.poll('token')).rejects.toThrow('provider_unauthorized')
    const malformed = microsoftAdapter(async () => Response.json({ value: 'not-an-array' }), 'staff@example.test')
    await expect(malformed.poll('token')).rejects.toThrow('provider_malformed_response')
  })
})
