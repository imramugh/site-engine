import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename } from 'node:path'
import { PUBLIC_IMAGE_MIME_TYPES, validateRasterUpload } from './media'

export const MAX_REMOTE_IMAGE_BYTES = 15 * 1024 * 1024
const TIMEOUT_MS = 10_000

type Address = { address: string; family: number }
export type RemoteImage = { data: Buffer; mimetype: string; name: string; size: number }
export type RemoteImageDependencies = {
  resolve?: (hostname: string) => Promise<Address[]>
  request?: (url: URL, address: Address, timeoutMs: number) => Promise<{ statusCode?: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array> }>
}

const reject = (message: string): never => { throw new Error(message) }
const ipv4Number = (address: string) => address.split('.').reduce((value, part) => value * 256 + Number(part), 0)
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const value = ipv4Number(address)
    const inRange = (base: string, bits: number) => (value >>> (32 - bits)) === (ipv4Number(base) >>> (32 - bits))
    return !['0.0.0.0', '255.255.255.255'].includes(address) && !inRange('10.0.0.0', 8) && !inRange('100.64.0.0', 10) && !inRange('127.0.0.0', 8) && !inRange('169.254.0.0', 16) && !inRange('172.16.0.0', 12) && !inRange('192.0.0.0', 24) && !inRange('192.0.2.0', 24) && !inRange('192.88.99.0', 24) && !inRange('192.168.0.0', 16) && !inRange('198.18.0.0', 15) && !inRange('198.51.100.0', 24) && !inRange('203.0.113.0', 24) && !inRange('224.0.0.0', 4)
  }
  if (family === 6) {
    const normal = address.toLowerCase()
    const mapped = normal.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
    if (mapped) return isPublicAddress(mapped)
    return normal !== '::' && normal !== '::1' && !normal.startsWith('fc') && !normal.startsWith('fd') && !normal.startsWith('fe8') && !normal.startsWith('fe9') && !normal.startsWith('fea') && !normal.startsWith('feb') && !normal.startsWith('ff') && !normal.startsWith('2001:db8:')
  }
  return false
}

function assertURL(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { return reject('invalid_remote_url') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))) reject('unsafe_remote_url')
  if (url.protocol === 'https:' && url.port && url.port !== '443') reject('unsafe_remote_url')
  if (url.protocol === 'http:' && url.port && url.port !== '80') reject('unsafe_remote_url')
  if (isIP(url.hostname) && !isPublicAddress(url.hostname)) reject('unsafe_remote_url')
  return url
}

async function nodeRequest(url: URL, address: Address, timeoutMs: number) {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<{ statusCode?: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array> }>((resolve, rejectRequest) => {
    const req = request(url, { lookup: (_hostname, _options, callback) => callback(null, address.address, address.family), timeout: timeoutMs, headers: { accept: 'image/avif,image/jpeg,image/png,image/webp' } }, (response) => resolve({ statusCode: response.statusCode, headers: response.headers, body: response }))
    req.once('timeout', () => req.destroy(new Error('remote_image_timeout')))
    req.once('error', rejectRequest)
    req.end()
  })
}

function nameFor(url: URL, mime: string) {
  const part = basename(url.pathname).replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 100)
  const extension = ({ 'image/avif': 'avif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[mime]!
  return part && /\.[A-Za-z0-9]{1,8}$/.test(part) ? part : `remote-image.${extension}`
}

export async function importPublicImage(sourceURL: string, dependencies: RemoteImageDependencies = {}): Promise<RemoteImage> {
  const resolve = dependencies.resolve ?? (async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family })))
  const send = dependencies.request ?? nodeRequest
  let url = assertURL(sourceURL)
  for (let redirects = 0; redirects <= 3; redirects++) {
    const addresses = await resolve(url.hostname)
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) reject('unsafe_remote_url')
    const response = await send(url, addresses[0]!, TIMEOUT_MS)
    const location = typeof response.headers.location === 'string' ? response.headers.location : undefined
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      if (!location || redirects === 3) reject('remote_redirect_rejected')
      url = assertURL(new URL(location!, url).toString()); continue
    }
    if (response.statusCode !== 200) reject('remote_fetch_failed')
    const mime = (typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : '').split(';', 1)[0]!.trim().toLowerCase()
    if (!PUBLIC_IMAGE_MIME_TYPES.includes(mime as typeof PUBLIC_IMAGE_MIME_TYPES[number])) reject('invalid_media')
    const declared = response.headers['content-length']; if (typeof declared === 'string' && (!/^\d+$/.test(declared) || Number(declared) > MAX_REMOTE_IMAGE_BYTES)) reject('payload_too_large')
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of response.body) { size += chunk.byteLength; if (size > MAX_REMOTE_IMAGE_BYTES) reject('payload_too_large'); chunks.push(Buffer.from(chunk)) }
    const file = { data: Buffer.concat(chunks), mimetype: mime, name: nameFor(url, mime), size }
    await validateRasterUpload(file)
    return file
  }
  return reject('remote_redirect_rejected')
}
