import { expect, test } from 'vitest'
import sharp from 'sharp'
import { importPublicImage, isPublicAddress } from '../src/media-url-ingestion'

const publicDNS = async () => [{ address: '93.184.216.34', family: 4 }]
const body = async function* (bytes: Buffer) { yield bytes }

test('public address policy rejects private, metadata, loopback and encoded-IP targets', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '::1', 'fc00::1']) expect(isPublicAddress(address)).toBe(false)
  expect(isPublicAddress('93.184.216.34')).toBe(true)
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

test('rejects type lies and oversized remote streams before media storage', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } }).png().toBuffer()
  await expect(importPublicImage('https://images.example.test/a.jpg', { resolve: publicDNS, request: async () => ({ statusCode: 200, headers: { 'content-type': 'image/jpeg' }, body: body(png) }) })).rejects.toThrow('declared image type')
  await expect(importPublicImage('https://images.example.test/a.png', { resolve: publicDNS, request: async () => ({ statusCode: 200, headers: { 'content-type': 'image/png', 'content-length': String(16 * 1024 * 1024) }, body: body(png) }) })).rejects.toThrow('payload_too_large')
})
