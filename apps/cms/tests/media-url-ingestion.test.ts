import { expect, test } from 'vitest'
import sharp from 'sharp'
import { importPublicImage, isPublicAddress } from '../src/media-url-ingestion'

const publicDNS = async () => [{ address: '93.184.216.34', family: 4 }]
const body = async function* (bytes: Buffer) { yield bytes }

test('public address policy permits only globally routable unicast addresses', async () => {
  for (const address of [
    '0.1.2.3', '10.1.2.3', '127.0.0.1', '169.254.169.254', '192.168.0.1', '240.0.0.1',
    '0x7f000001', '::ffff:7f00:1', '0:0:0:0:0:0:0:1', '::2', '::127.0.0.1', '[::1]', 'fc00::1', '2001:db8::1',
    '2001:0000::1', '2002:c000:0204::1', '4000::1', '64:ff9b::808:808',
  ]) expect(isPublicAddress(address)).toBe(false)
  expect(isPublicAddress('93.184.216.34')).toBe(true)
  expect(isPublicAddress('2606:4700:4700::1111')).toBe(true)
  await expect(importPublicImage('http://2130706433/image.png', { resolve: publicDNS })).rejects.toThrow('unsafe_remote_url')
  await expect(importPublicImage('https://user:pass@example.test/image.png', { resolve: publicDNS })).rejects.toThrow('unsafe_remote_url')
  await expect(importPublicImage('https://example.test:444/image.png', { resolve: publicDNS })).rejects.toThrow('unsafe_remote_url')
})

test('imports validated public image bytes while pinning the resolved address and revalidating redirects', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } }).png().toBuffer()
  const seen: string[] = []
  const file = await importPublicImage('https://images.example.test/original', {
    resolve: async (hostname) => hostname === 'images.example.test' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '8.8.8.8', family: 4 }],
    request: async (url, address) => { seen.push(`${url.hostname}:${address.address}`); return url.hostname === 'images.example.test' ? { statusCode: 302, headers: { location: 'https://cdn.example.test/ok.png' }, body: body(Buffer.alloc(0)) } : { statusCode: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) }, body: body(png) } },
  })
  expect(file).toMatchObject({ mimetype: 'image/png', size: png.length, name: 'ok.png' })
  expect(seen).toEqual(['images.example.test:93.184.216.34', 'cdn.example.test:8.8.8.8'])
  await expect(importPublicImage('https://images.example.test/redirect', { resolve: async () => [{ address: '93.184.216.34', family: 4 }], request: async () => ({ statusCode: 302, headers: { location: 'http://127.0.0.1/secret' }, body: body(Buffer.alloc(0)) }) })).rejects.toThrow('unsafe_remote_url')
})

test('normalizes bracketed public IPv6 literals before resolution', async () => {
  let resolved = ''
  await expect(importPublicImage('https://[2606:4700:4700::1111]/image.png', {
    resolve: async (hostname) => { resolved = hostname; return [{ address: hostname, family: 6 }] },
    request: async () => ({ statusCode: 500, headers: {}, body: body(Buffer.alloc(0)) }),
  })).rejects.toThrow('remote_fetch_failed')
  expect(resolved).toBe('2606:4700:4700::1111')
})

test('rejects type lies and oversized remote streams before media storage', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } }).png().toBuffer()
  await expect(importPublicImage('https://images.example.test/a.jpg', { resolve: publicDNS, request: async () => ({ statusCode: 200, headers: { 'content-type': 'image/jpeg' }, body: body(png) }) })).rejects.toThrow('declared image type')
  await expect(importPublicImage('https://images.example.test/a.png', { resolve: publicDNS, request: async () => ({ statusCode: 200, headers: { 'content-type': 'image/png', 'content-length': String(16 * 1024 * 1024) }, body: body(png) }) })).rejects.toThrow('payload_too_large')
})

test('aborts unused responses and enforces one deadline across a slow body', async () => {
  let redirectedAborted = false
  await expect(importPublicImage('https://images.example.test/redirect', {
    resolve: publicDNS,
    request: async () => ({ statusCode: 302, headers: {}, body: body(Buffer.alloc(0)), abort: () => { redirectedAborted = true } }),
  })).rejects.toThrow('remote_redirect_rejected')
  expect(redirectedAborted).toBe(true)

  let invalidMimeAborted = false
  await expect(importPublicImage('https://images.example.test/not-an-image', {
    resolve: publicDNS,
    request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body: body(Buffer.alloc(0)), abort: () => { invalidMimeAborted = true } }),
  })).rejects.toThrow('invalid_media')
  expect(invalidMimeAborted).toBe(true)

  let timedOutAborted = false
  const neverEndingBody: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: async () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }) }
  await expect(importPublicImage('https://images.example.test/slow.png', {
    timeoutMs: 20,
    resolve: publicDNS,
    request: async (_url, _address, timeoutMs) => {
      expect(timeoutMs).toBeLessThanOrEqual(20)
      return { statusCode: 200, headers: { 'content-type': 'image/png' }, body: neverEndingBody, abort: () => { timedOutAborted = true } }
    },
  })).rejects.toThrow('remote_image_timeout')
  expect(timedOutAborted).toBe(true)

  await expect(importPublicImage('https://images.example.test/dns.png', {
    timeoutMs: 20,
    resolve: async () => new Promise(() => undefined),
  })).rejects.toThrow('remote_image_timeout')

  let lateHeaderAborted = false
  await expect(importPublicImage('https://images.example.test/late-header.png', {
    timeoutMs: 10,
    resolve: publicDNS,
    request: async () => new Promise((resolve) => setTimeout(() => resolve({ statusCode: 200, headers: { 'content-type': 'image/png' }, body: body(Buffer.alloc(0)), abort: () => { lateHeaderAborted = true } }), 25)),
  })).rejects.toThrow('remote_image_timeout')
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(lateHeaderAborted).toBe(true)
})
