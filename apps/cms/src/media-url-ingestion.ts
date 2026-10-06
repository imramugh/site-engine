import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename } from 'node:path'
import ipaddr from 'ipaddr.js'
import { PUBLIC_IMAGE_MIME_TYPES, validateRasterUpload } from './media'

export const MAX_REMOTE_IMAGE_BYTES = 15 * 1024 * 1024
const TIMEOUT_MS = 10_000

type Address = { address: string; family: number }
type RemoteResponse = { statusCode?: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array>; abort?: () => void }
export type RemoteImage = { data: Buffer; mimetype: string; name: string; size: number }
export type RemoteImageDependencies = {
  resolve?: (hostname: string) => Promise<Address[]>
  request?: (url: URL, address: Address, timeoutMs: number) => Promise<RemoteResponse>
  /** Test-only override; production imports always have a 10 second operation deadline. */
  timeoutMs?: number
}

const reject = (message: string): never => { throw new Error(message) }
const hostnameAddress = (hostname: string) => hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname

/** Accept only addresses ipaddr.js classifies as globally routable unicast. */
export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(hostnameAddress(address))
    return parsed.kind() === 'ipv4'
      ? parsed.range() === 'unicast'
      : !(parsed as ipaddr.IPv6).isIPv4MappedAddress() && parsed.range() === 'unicast'
  } catch { return false }
}

function isPublicResolvedAddress(address: Address) {
  const parsed = hostnameAddress(address.address)
  const family = ipaddr.isValid(parsed) ? ipaddr.parse(parsed).kind() === 'ipv4' ? 4 : 6 : 0
  return family === address.family && isPublicAddress(parsed)
}

function assertURL(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { return reject('invalid_remote_url') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))) reject('unsafe_remote_url')
  if (!url.hostname || (ipaddr.isValid(hostnameAddress(url.hostname)) && !isPublicAddress(url.hostname))) reject('unsafe_remote_url')
  return url
}

function nodeRequest(url: URL, address: Address, timeoutMs: number) {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<RemoteResponse>((resolve, rejectRequest) => {
    const options = {
      // Pin the DNS result. Disabling family selection keeps the lookup callback's
      // single-address result compatible with Node 24's `all` lookup option.
      autoSelectFamily: false,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      timeout: timeoutMs,
      headers: { accept: 'image/avif,image/jpeg,image/png,image/webp' },
    } as import('node:http').RequestOptions & { autoSelectFamily: boolean }
    const req = request(url, options, (incoming) => {
      clearTimeout(operationTimeout)
      resolve({ statusCode: incoming.statusCode, headers: incoming.headers, body: incoming, abort: () => { incoming.destroy(); req.destroy() } })
    })
    // Request#setTimeout is an idle timeout. Keep an independent wall-clock
    // timer until headers arrive so a drip-fed connection cannot outlive this hop.
    const operationTimeout = setTimeout(() => req.destroy(new Error('remote_image_timeout')), timeoutMs)
    operationTimeout.unref?.()
    req.once('timeout', () => req.destroy(new Error('remote_image_timeout')))
    req.once('error', (error) => { clearTimeout(operationTimeout); rejectRequest(error) })
    req.end()
  })
}

function nameFor(url: URL, mime: string) {
  const part = basename(url.pathname).replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 100)
  const extension = ({ 'image/avif': 'avif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[mime]!
  return part && /\.[A-Za-z0-9]{1,8}$/.test(part) ? part : `remote-image.${extension}`
}

export async function importPublicImage(sourceURL: string, dependencies: RemoteImageDependencies = {}): Promise<RemoteImage> {
  const timeoutMs = dependencies.timeoutMs && dependencies.timeoutMs > 0 ? dependencies.timeoutMs : TIMEOUT_MS
  const resolve = dependencies.resolve ?? (async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family })))
  const send = dependencies.request ?? nodeRequest
  let abortActive: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, rejectDeadline) => {
    timeout = setTimeout(() => { abortActive?.(); rejectDeadline(new Error('remote_image_timeout')) }, timeoutMs)
    timeout.unref?.()
  })
  const withinDeadline = <T>(promise: Promise<T>) => Promise.race([promise, deadline])
  const remaining = (startedAt: number) => Math.max(1, timeoutMs - (Date.now() - startedAt))
  const abort = (response: RemoteResponse | undefined) => { response?.abort?.() }
  const startedAt = Date.now()
  try {
    let url = assertURL(sourceURL)
    for (let redirects = 0; redirects <= 3; redirects++) {
      const addresses = await withinDeadline(resolve(url.hostname))
      if (!addresses.length || addresses.some((address) => !isPublicResolvedAddress(address))) reject('unsafe_remote_url')
      const response = await withinDeadline(send(url, addresses[0]!, remaining(startedAt)))
      abortActive = response.abort
      const location = typeof response.headers.location === 'string' ? response.headers.location : undefined
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        abort(response)
        if (!location || redirects === 3) reject('remote_redirect_rejected')
        url = assertURL(new URL(location!, url).toString())
        abortActive = undefined
        continue
      }
      if (response.statusCode !== 200) { abort(response); reject('remote_fetch_failed') }
      const mime = (typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : '').split(';', 1)[0]!.trim().toLowerCase()
      if (!PUBLIC_IMAGE_MIME_TYPES.includes(mime as typeof PUBLIC_IMAGE_MIME_TYPES[number])) { abort(response); reject('invalid_media') }
      const declared = response.headers['content-length']
      if (typeof declared === 'string' && (!/^\d+$/.test(declared) || Number(declared) > MAX_REMOTE_IMAGE_BYTES)) { abort(response); reject('payload_too_large') }
      const chunks: Buffer[] = []; let size = 0
      const iterator = response.body[Symbol.asyncIterator]()
      while (true) {
        const next = await withinDeadline(iterator.next())
        if (next.done) break
        size += next.value.byteLength
        if (size > MAX_REMOTE_IMAGE_BYTES) { abort(response); reject('payload_too_large') }
        chunks.push(Buffer.from(next.value))
      }
      abortActive = undefined
      const file = { data: Buffer.concat(chunks), mimetype: mime, name: nameFor(url, mime), size }
      await validateRasterUpload(file)
      return file
    }
    return reject('remote_redirect_rejected')
  } catch (error) {
    abortActive?.()
    throw error
  } finally { if (timeout) clearTimeout(timeout) }
}
