import { formatSize } from '@mariozechner/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import * as dns from 'node:dns/promises'
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  inflateSync,
} from 'node:zlib'
import {
  execFileAsync,
  normalizeHostname,
  normalizeWhitespace,
} from '../shared.ts'
import type {
  FetchProgressHandler,
  FetchRequestOptions,
  GuardedFetchResponse,
  GuardedRequester,
} from './types.ts'

const DEFAULT_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
const FETCH_USER_AGENT =
  process.env.PI_WEB_FETCH_USER_AGENT?.trim() || DEFAULT_BROWSER_USER_AGENT
const FETCH_USER_AGENT_FALLBACK =
  process.env.PI_WEB_FETCH_FALLBACK_USER_AGENT?.trim() || 'pi-web-fetch/1.1'
const ACCEPT_ENCODING_HEADER = 'gzip, deflate, br'
const JINA_READER_HOST = 'r.jina.ai'
const PDF_MIME_TYPES = new Set(['application/pdf', 'application/x-pdf'])
const MAX_REDIRECTS = 5
export const MAX_HTML_BYTES = 5 * 1024 * 1024
export const MAX_TEXT_RESPONSE_BYTES = 5 * 1024 * 1024
export const MAX_JSON_RESPONSE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGE_RESPONSE_BYTES = 20 * 1024 * 1024
export const MAX_PDF_RESPONSE_BYTES = 25 * 1024 * 1024
export const MAX_OTHER_RESPONSE_BYTES = 10 * 1024 * 1024
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'host.docker.internal',
  'host.containers.internal',
  'metadata.google.internal',
])

export function isBlockedHostname(hostname: string) {
  const normalized = normalizeHostname(hostname)
  return (
    !normalized ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    BLOCKED_HOSTNAMES.has(normalized)
  )
}

function normalizeIpAddress(address: string) {
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mappedIpv4 ? mappedIpv4[1] : normalized
}

function parseIpv4Octets(address: string) {
  if (net.isIP(address) !== 4) return undefined
  const octets = address.split('.').map((part) => Number.parseInt(part, 10))
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return undefined
  }
  return octets
}

export function isPrivateIpAddress(address: string) {
  const normalized = normalizeIpAddress(address)
  const ipv4 = parseIpv4Octets(normalized)

  if (ipv4) {
    const [first, second] = ipv4
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    )
  }

  if (net.isIP(normalized) !== 6) return false
  if (normalized === '::' || normalized === '::1') return true
  if (/^f[c-d][0-9a-f]{2}:/i.test(normalized)) return true
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true
  if (normalized.startsWith('ff')) return true

  return false
}

function assertSafeFetchUrl(url: URL) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported protocol: ${url.protocol}`)
  }

  if (!url.hostname) {
    throw new Error(`Invalid URL hostname: ${url.toString()}`)
  }

  if (isBlockedHostname(url.hostname)) {
    throw new Error(`Blocked hostname: ${url.hostname}`)
  }

  if (net.isIP(url.hostname) && isPrivateIpAddress(url.hostname)) {
    throw new Error(`Blocked private network address: ${url.hostname}`)
  }
}

async function resolvePublicAddress(hostname: string) {
  const normalized = normalizeHostname(hostname)

  if (isBlockedHostname(normalized)) {
    throw new Error(`Blocked hostname: ${hostname}`)
  }

  if (net.isIP(normalized)) {
    if (isPrivateIpAddress(normalized)) {
      throw new Error(`Blocked private network address: ${hostname}`)
    }
    return {
      address: normalizeIpAddress(normalized),
      family: net.isIP(normalized) as 4 | 6,
      all: [
        {
          address: normalizeIpAddress(normalized),
          family: net.isIP(normalized) as 4 | 6,
        },
      ],
    }
  }

  const resolved = await dns.lookup(normalized, { all: true, verbatim: true })
  if (!resolved.length) {
    throw new Error(`Hostname did not resolve: ${hostname}`)
  }

  const all = resolved.map((entry) => ({
    address: normalizeIpAddress(entry.address),
    family: entry.family as 4 | 6,
  }))

  for (const entry of all) {
    if (isPrivateIpAddress(entry.address)) {
      throw new Error(
        `Blocked private network address for ${hostname}: ${entry.address}`,
      )
    }
  }

  return {
    address: all[0]!.address,
    family: all[0]!.family,
    all,
  }
}

const safeLookup = (hostname: string, options: any, callback: any) => {
  resolvePublicAddress(hostname)
    .then((resolved) => {
      if (options?.all) callback(null, resolved.all)
      else callback(null, resolved.address, resolved.family)
    })
    .catch((error) => callback(error))
}

function pickEnvValue(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

function hostMatchesNoProxyEntry(hostname: string, entry: string) {
  if (!entry) return false
  if (entry === '*') return true

  const target = normalizeHostname(hostname)
  const pattern = normalizeHostname(entry.replace(/^\./, ''))
  if (!pattern) return false

  return target === pattern || target.endsWith(`.${pattern}`)
}

function shouldBypassProxy(hostname: string) {
  const noProxy = pickEnvValue('NO_PROXY', 'no_proxy')
  if (!noProxy) return false

  return noProxy
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => hostMatchesNoProxyEntry(hostname, entry))
}

function resolveConfiguredProxyUrl(url: URL, explicitProxy?: string) {
  if (explicitProxy?.trim()) return explicitProxy.trim()
  if (shouldBypassProxy(url.hostname)) return undefined

  const chain =
    url.protocol === 'https:'
      ? ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
      : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

  return pickEnvValue(...chain)
}

function isLoopbackHostname(hostname: string) {
  const normalized = normalizeHostname(hostname)
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (net.isIP(normalized) === 6) {
    const stripped = normalized.replace(/^\[(.*)\]$/, '$1')
    return stripped === '::1' || stripped === '0:0:0:0:0:0:0:1'
  }
  if (net.isIP(normalized) === 4) {
    return normalized.startsWith('127.')
  }
  return false
}

function resolveValidatedProxyUrl(proxyUrl: string): Promise<URL> {
  let parsedProxyUrl: URL

  try {
    parsedProxyUrl = new URL(proxyUrl)
  } catch {
    throw new Error(`Invalid proxy URL: ${proxyUrl}`)
  }

  if (
    !['http:', 'https:', 'socks:', 'socks4:', 'socks5:', 'socks5h:'].includes(
      parsedProxyUrl.protocol,
    )
  ) {
    throw new Error(
      `Unsupported proxy protocol: ${parsedProxyUrl.protocol}. Use http, https, or socks proxies.`,
    )
  }

  if (!parsedProxyUrl.hostname) {
    throw new Error(`Invalid proxy URL hostname: ${proxyUrl}`)
  }

  // Loopback proxies are intentionally exempt from public-address validation —
  // users routinely run local SOCKS/HTTP proxies (mitmproxy, corp VPN clients).
  if (isLoopbackHostname(parsedProxyUrl.hostname)) {
    return Promise.resolve(parsedProxyUrl)
  }

  return resolvePublicAddress(parsedProxyUrl.hostname).then(
    () => parsedProxyUrl,
  )
}

function isAttachmentDisposition(contentDisposition: string) {
  return /^attachment(?:\s*;|\s*$)/i.test(contentDisposition.trim())
}

function isTextLikeMimeType(mimeType: string) {
  if (!mimeType) return true

  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'text/json' ||
    mimeType.endsWith('+json') ||
    mimeType === 'application/xml' ||
    mimeType === 'text/xml' ||
    mimeType.endsWith('+xml') ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/x-javascript' ||
    mimeType === 'application/ecmascript' ||
    mimeType === 'image/svg+xml'
  )
}

function shouldStreamBinaryResponse(
  contentDisposition: string,
  mimeType: string,
) {
  if (isAttachmentDisposition(contentDisposition)) return true
  if (!mimeType) return false
  if (mimeType.startsWith('image/')) return false
  if (isPdfMimeType(mimeType)) return false
  return !isTextLikeMimeType(mimeType)
}

function resolveStreamedDownloadPath(url: URL, mimeType: string) {
  const baseDir = path.join(tmpdir(), 'pi-web-tools-downloads')
  mkdirSync(baseDir, { recursive: true })

  const extFromUrl = path.extname(url.pathname)
  const ext = extFromUrl || (mimeType === 'application/zip' ? '.zip' : '.bin')
  const filename = `download-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}${ext}`
  return path.join(baseDir, filename)
}

type ProxyAgentLike = new (proxyUrl: string) => http.Agent

let proxyAgentConstructorPromise: Promise<ProxyAgentLike> | undefined

async function loadProxyAgentConstructor(): Promise<ProxyAgentLike> {
  if (!proxyAgentConstructorPromise) {
    proxyAgentConstructorPromise = import('proxy-agent')
      .then((module) => {
        const candidate =
          (module as { ProxyAgent?: unknown }).ProxyAgent ??
          (module as { default?: unknown }).default

        if (typeof candidate !== 'function') {
          throw new Error('proxy-agent module does not export ProxyAgent')
        }

        return candidate as ProxyAgentLike
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Proxy support is unavailable: ${message}`)
      })
  }

  return proxyAgentConstructorPromise
}

async function requestWithDnsGuard(
  url: URL,
  signal: AbortSignal,
  userAgent: string,
  options: FetchRequestOptions = {},
): Promise<GuardedFetchResponse> {
  assertSafeFetchUrl(url)

  const client = url.protocol === 'https:' ? https : http
  const acceptHeader =
    'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,image/*;q=0.9,*/*;q=0.8'
  const requestHeaders = {
    'User-Agent': userAgent,
    Accept: acceptHeader,
    'Accept-Encoding': ACCEPT_ENCODING_HEADER,
    ...options.headers,
  }
  const proxyUrl = resolveConfiguredProxyUrl(url, options.proxy)
  const parsedProxyUrl = proxyUrl
    ? await resolveValidatedProxyUrl(proxyUrl)
    : undefined

  const requestOptions: http.RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    headers: requestHeaders,
    signal,
  }

  if (parsedProxyUrl) {
    const ProxyAgent = await loadProxyAgentConstructor()
    requestOptions.agent = new ProxyAgent(parsedProxyUrl.toString())
  } else {
    requestOptions.lookup = safeLookup
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const resolveOnce = (value: GuardedFetchResponse) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const request = client.request(requestOptions, (response) => {
      const meta = readResponseMeta(response)

      if (meta.contentLength !== undefined && meta.contentLength > meta.maxBytes) {
        const error = createResponseTooLargeError(
          url,
          meta.contentLength,
          meta.maxBytes,
          meta.mimeType,
        )
        response.destroy(error)
        request.destroy(error)
        rejectOnce(error)
        return
      }

      const handlerContext: ResponseHandlerContext = {
        url,
        response,
        request,
        meta,
        isSettled: () => settled,
        resolveOnce,
        rejectOnce,
      }

      if (shouldStreamBinaryResponse(meta.contentDisposition, meta.mimeType)) {
        handleStreamingResponse(handlerContext)
      } else {
        handleBufferedResponse(handlerContext)
      }
    })

    request.on('error', rejectOnce)
    request.end()
  })
}

type ResponseMeta = {
  mimeType: string
  contentDisposition: string
  contentLength: number | undefined
  maxBytes: number
}

type ResponseHandlerContext = {
  url: URL
  response: http.IncomingMessage
  request: http.ClientRequest
  meta: ResponseMeta
  isSettled: () => boolean
  resolveOnce: (value: GuardedFetchResponse) => void
  rejectOnce: (error: unknown) => void
}

function pickHeader(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] || ''
  return value || ''
}

function readResponseMeta(response: http.IncomingMessage): ResponseMeta {
  const contentType = pickHeader(response.headers['content-type'])
  const contentDisposition = pickHeader(response.headers['content-disposition'])
  const mimeType = contentType.split(';')[0]?.trim().toLowerCase() || ''
  const maxBytes = getResponseByteLimit(mimeType)
  const contentLength = parseContentLength(
    pickHeader(response.headers['content-length']) || null,
  )
  return { mimeType, contentDisposition, contentLength, maxBytes }
}

function buildResponseHeaders(response: http.IncomingMessage) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '))
    else if (value !== undefined) headers.set(key, String(value))
  }
  return headers
}

function handleStreamingResponse(ctx: ResponseHandlerContext) {
  const { url, response, request, meta } = ctx
  const downloadedFilePath = resolveStreamedDownloadPath(url, meta.mimeType)
  const output = createWriteStream(downloadedFilePath, {
    flags: 'wx',
    mode: 0o600,
  })

  const cleanupPartial = () => {
    rmSync(downloadedFilePath, { force: true })
  }

  let totalBytes = 0

  response.on('data', (chunk) => {
    if (ctx.isSettled()) return

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > meta.maxBytes) {
      const error = createResponseTooLargeError(
        url,
        totalBytes,
        meta.maxBytes,
        meta.mimeType,
      )
      response.destroy(error)
      request.destroy(error)
      output.destroy(error)
      cleanupPartial()
      ctx.rejectOnce(error)
    }
  })

  response.on('error', (error) => {
    cleanupPartial()
    ctx.rejectOnce(error)
  })
  output.on('error', (error) => {
    cleanupPartial()
    ctx.rejectOnce(error)
  })
  output.on('finish', () => {
    const status = response.statusCode ?? 0
    ctx.resolveOnce({
      url: url.toString(),
      status,
      statusText: response.statusMessage ?? '',
      headers: buildResponseHeaders(response),
      ok: status >= 200 && status < 300,
      bodyBuffer: Buffer.alloc(0),
      downloadedFilePath,
      downloadedFileSize: totalBytes,
    })
  })

  response.pipe(output)
}

function handleBufferedResponse(ctx: ResponseHandlerContext) {
  const { url, response, request, meta } = ctx
  const chunks: Buffer[] = []
  let totalBytes = 0

  response.on('data', (chunk) => {
    if (ctx.isSettled()) return

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > meta.maxBytes) {
      const error = createResponseTooLargeError(
        url,
        totalBytes,
        meta.maxBytes,
        meta.mimeType,
      )
      response.destroy(error)
      request.destroy(error)
      ctx.rejectOnce(error)
      return
    }

    chunks.push(buffer)
  })
  response.on('error', ctx.rejectOnce)
  response.on('end', () => {
    const headers = buildResponseHeaders(response)

    try {
      let bodyBuffer = Buffer.concat(chunks)
      bodyBuffer = decodeContentEncoding(
        bodyBuffer,
        headers.get('content-encoding'),
        {
          url: url.toString(),
          maxBytes: meta.maxBytes,
          mimeType: meta.mimeType,
        },
      )

      if (headers.has('content-encoding')) {
        headers.delete('content-encoding')
        headers.delete('content-length')
      }

      const status = response.statusCode ?? 0
      ctx.resolveOnce({
        url: url.toString(),
        status,
        statusText: response.statusMessage ?? '',
        headers,
        ok: status >= 200 && status < 300,
        bodyBuffer,
      })
    } catch (error) {
      ctx.rejectOnce(error)
    }
  })
}

function isRedirectStatus(status: number) {
  return [301, 302, 303, 307, 308].includes(status)
}

export async function fetchWithRedirects(
  initialUrl: URL,
  signal: AbortSignal,
  userAgent: string,
  requester: GuardedRequester = requestWithDnsGuard,
  options?: FetchRequestOptions,
): Promise<GuardedFetchResponse> {
  let currentUrl = new URL(initialUrl.toString())

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    const response = await requester(currentUrl, signal, userAgent, options)
    if (!isRedirectStatus(response.status)) return response

    const location = response.headers.get('location')
    if (!location) return response
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(
        `Too many redirects while fetching ${initialUrl.toString()}`,
      )
    }

    currentUrl = new URL(location, currentUrl)
    assertSafeFetchUrl(currentUrl)
  }

  throw new Error(`Too many redirects while fetching ${initialUrl.toString()}`)
}

function isCloudflareChallenge(response: GuardedFetchResponse) {
  const server = (response.headers.get('server') || '').toLowerCase()
  return (
    response.status === 403 &&
    (response.headers.get('cf-mitigated') === 'challenge' ||
      server.includes('cloudflare'))
  )
}

export async function fetchWithOptionalCloudflareRetry(
  url: URL,
  signal: AbortSignal,
  onUpdate?: FetchProgressHandler,
  requester: GuardedRequester = requestWithDnsGuard,
  options?: FetchRequestOptions,
) {
  let response = await fetchWithRedirects(
    url,
    signal,
    FETCH_USER_AGENT,
    requester,
    options,
  )
  let cloudflareBypassed = false

  if (isCloudflareChallenge(response)) {
    cloudflareBypassed = true
    onUpdate?.({
      content: [
        {
          type: 'text',
          text: 'Cloudflare challenge detected, retrying with fallback User-Agent...',
        },
      ],
    })
    response = await fetchWithRedirects(
      url,
      signal,
      FETCH_USER_AGENT_FALLBACK,
      requester,
      options,
    )
  }

  return { response, cloudflareBypassed }
}

export function parseContentLength(contentLengthHeader: string | null) {
  if (!contentLengthHeader) return undefined
  const parsed = Number.parseInt(contentLengthHeader, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function normalizeCharsetLabel(charset: string) {
  const normalized = charset
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase()
  const compact = normalized.replace(/_/g, '-')

  const aliases: Record<string, string> = {
    utf8: 'utf-8',
    latin1: 'iso-8859-1',
    'iso8859-1': 'iso-8859-1',
    ascii: 'utf-8',
    'us-ascii': 'utf-8',
  }

  return aliases[compact] || compact
}

export function parseCharsetFromContentType(
  contentTypeHeader: string | null | undefined,
) {
  if (!contentTypeHeader) return undefined

  const match = contentTypeHeader.match(/charset\s*=\s*([^;]+)/i)
  if (!match) return undefined
  return normalizeCharsetLabel(match[1] || '')
}

function detectBomEncoding(bodyBuffer: Buffer) {
  if (bodyBuffer.byteLength >= 3) {
    if (
      bodyBuffer[0] === 0xef &&
      bodyBuffer[1] === 0xbb &&
      bodyBuffer[2] === 0xbf
    ) {
      return 'utf-8'
    }
  }

  if (bodyBuffer.byteLength >= 2) {
    if (bodyBuffer[0] === 0xff && bodyBuffer[1] === 0xfe) return 'utf-16le'
    if (bodyBuffer[0] === 0xfe && bodyBuffer[1] === 0xff) return 'utf-16be'
  }

  return undefined
}

function parseContentEncodingTokens(
  contentEncodingHeader: string | null | undefined,
) {
  if (!contentEncodingHeader) return []

  return contentEncodingHeader
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean)
    .filter((encoding) => encoding !== 'identity')
}

function decodeByContentEncodingStep(bodyBuffer: Buffer, encoding: string) {
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    return gunzipSync(bodyBuffer)
  }

  if (encoding === 'deflate') {
    try {
      return inflateSync(bodyBuffer)
    } catch {
      return inflateRawSync(bodyBuffer)
    }
  }

  if (encoding === 'br') {
    return brotliDecompressSync(bodyBuffer)
  }

  throw new Error(`Unsupported content-encoding: ${encoding}`)
}

export function decodeContentEncoding(
  bodyBuffer: Buffer,
  contentEncodingHeader: string | null | undefined,
  options: {
    url?: string
    maxBytes?: number
    mimeType?: string
  } = {},
) {
  const encodings = parseContentEncodingTokens(contentEncodingHeader)
  if (!encodings.length) return bodyBuffer

  let decoded = bodyBuffer
  for (const encoding of [...encodings].reverse()) {
    decoded = decodeByContentEncodingStep(decoded, encoding)
  }

  if (options.maxBytes !== undefined && decoded.byteLength > options.maxBytes) {
    if (options.url) {
      const url = new URL(options.url)
      throw createResponseTooLargeError(
        url,
        decoded.byteLength,
        options.maxBytes,
        options.mimeType || '',
      )
    }

    throw new Error(
      `Decoded response too large: ${formatSize(decoded.byteLength)} exceeds ${formatSize(options.maxBytes)}`,
    )
  }

  return decoded
}

export function decodeBodyAsText(
  bodyBuffer: Buffer,
  contentTypeHeader: string | null | undefined,
) {
  const charset =
    detectBomEncoding(bodyBuffer) ||
    parseCharsetFromContentType(contentTypeHeader) ||
    'utf-8'

  try {
    return new TextDecoder(charset).decode(bodyBuffer)
  } catch {
    if (charset === 'utf-8') {
      throw new Error('Failed to decode response body as UTF-8 text')
    }
    return new TextDecoder('utf-8').decode(bodyBuffer)
  }
}

export function getResponseByteLimit(mimeType: string) {
  if (!mimeType) return MAX_OTHER_RESPONSE_BYTES
  if (isPdfMimeType(mimeType)) return MAX_PDF_RESPONSE_BYTES
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') {
    return MAX_HTML_BYTES
  }
  if (mimeType.startsWith('image/')) return MAX_IMAGE_RESPONSE_BYTES
  if (mimeType.includes('json')) return MAX_JSON_RESPONSE_BYTES
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'image/svg+xml' ||
    mimeType.endsWith('+xml') ||
    mimeType.endsWith('/xml')
  ) {
    return MAX_TEXT_RESPONSE_BYTES
  }
  return MAX_OTHER_RESPONSE_BYTES
}

function createResponseTooLargeError(
  url: URL,
  actualBytes: number,
  maxBytes: number,
  mimeType: string,
) {
  const typeSuffix = mimeType ? ` for ${mimeType}` : ''
  return new Error(
    `Response too large to download safely from ${url.toString()}: ${formatSize(actualBytes)} exceeds ${formatSize(maxBytes)}${typeSuffix}`,
  )
}

export function shouldApplyHtmlGuard(
  mimeType: string,
  format: string,
  contentLength?: number,
) {
  const isHtml =
    mimeType === 'text/html' || mimeType === 'application/xhtml+xml'
  if (!isHtml) return false
  if (!['markdown', 'text', 'html'].includes(format)) return false
  return contentLength !== undefined && contentLength > MAX_HTML_BYTES
}

export function buildJinaReaderUrl(url: string) {
  return new URL(
    `https://${JINA_READER_HOST}/http://${url.replace(/^https?:\/\//i, '')}`,
  )
}

export function isPdfMimeType(mimeType: string) {
  return PDF_MIME_TYPES.has(mimeType)
}

export function isPdfUrl(url: string) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf')
  } catch {
    return false
  }
}

const MAX_JS_PDF_EXTRACT_PAGES = 200

function createAbortError(label: string) {
  const error = new Error(`${label} aborted`)
  error.name = 'AbortError'
  return error
}

async function extractPdfTextViaPdftotext(
  pdfBuffer: Buffer,
  signal?: AbortSignal,
): Promise<string> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pi-web-tools-pdf-'))
  const inputPath = path.join(tempDir, 'document.pdf')

  try {
    writeFileSync(inputPath, pdfBuffer)
    const { stdout } = await execFileAsync(
      'pdftotext',
      [inputPath, '-'],
      signal,
    )
    const text = stdout.replace(/\f/g, '\n').trim()
    if (!text) throw new Error('pdftotext produced no text')
    return text
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function extractPdfTextViaJs(
  pdfBuffer: Buffer,
  signal?: AbortSignal,
): Promise<string> {
  const unpdfModule = (await import('unpdf')) as {
    getDocumentProxy: (input: Uint8Array) => Promise<{
      numPages: number
      getPage: (page: number) => Promise<{
        getTextContent: () => Promise<{
          items: Array<{ str?: string }>
        }>
      }>
    }>
  }

  const document = await unpdfModule.getDocumentProxy(new Uint8Array(pdfBuffer))
  const pageLimit = Math.max(
    1,
    Math.min(document.numPages, MAX_JS_PDF_EXTRACT_PAGES),
  )
  const pages: string[] = []

  for (let pageIndex = 1; pageIndex <= pageLimit; pageIndex += 1) {
    if (signal?.aborted) throw createAbortError('PDF extraction')

    const page = await document.getPage(pageIndex)
    const textContent = await page.getTextContent()
    const text = normalizeWhitespace(
      textContent.items.map((item) => item.str || '').join(' '),
    )

    if (!text) continue
    pages.push(text)
  }

  let extracted = normalizeWhitespace(pages.join('\n\n'))
  if (!extracted) throw new Error('JS PDF extraction produced no text')

  if (document.numPages > pageLimit) {
    extracted = [
      extracted,
      '',
      `---`,
      `[PDF truncated: extracted first ${pageLimit} of ${document.numPages} pages]`,
    ].join('\n')
  }

  return extracted
}

export async function extractPdfText(
  pdfBuffer: Buffer,
  signal?: AbortSignal,
): Promise<string> {
  let pdftotextError: unknown

  try {
    return await extractPdfTextViaPdftotext(pdfBuffer, signal)
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    pdftotextError = error
  }

  try {
    return await extractPdfTextViaJs(pdfBuffer, signal)
  } catch (fallbackError) {
    if ((fallbackError as Error).name === 'AbortError') throw fallbackError

    const primary =
      pdftotextError instanceof Error
        ? pdftotextError.message
        : String(pdftotextError)
    const fallback =
      fallbackError instanceof Error
        ? fallbackError.message
        : String(fallbackError)

    throw new Error(
      `PDF extraction failed (pdftotext + JS fallback). pdftotext: ${primary}. js: ${fallback}`,
    )
  }
}

export function shouldUseJinaFallbackForStatus(status: number) {
  return [401, 403, 408, 409, 425, 429, 451, 500, 502, 503, 504].includes(
    status,
  )
}

export function looksLikeBlockedOrJunkContent(text: string) {
  const normalized = normalizeWhitespace(text).toLowerCase()
  if (!normalized) return true
  if (normalized.length < 140) return true

  const junkSignals = [
    'enable javascript',
    'please enable javascript',
    'verify you are human',
    'access denied',
    'just a moment',
    'checking your browser',
    'please wait while we verify',
    'accept cookies',
    'cookie preferences',
    'sign in to continue',
    'subscribe to continue',
  ]

  return junkSignals.some((signal) => normalized.includes(signal))
}

export async function fetchViaJinaReader(
  sourceUrl: URL,
  signal: AbortSignal,
  onUpdate?: FetchProgressHandler,
  requester: GuardedRequester = requestWithDnsGuard,
  options?: Pick<FetchRequestOptions, 'proxy'>,
) {
  onUpdate?.({
    content: [
      {
        type: 'text',
        text: `[fallback] Retrying via Jina Reader for ${sourceUrl.hostname}...`,
      },
    ],
  })

  const response = await fetchWithRedirects(
    buildJinaReaderUrl(sourceUrl.toString()),
    signal,
    FETCH_USER_AGENT,
    requester,
    options,
  )

  if (!response.ok) {
    throw new Error(
      `Jina Reader fetch failed: ${response.status} ${response.statusText}`,
    )
  }

  return {
    response,
    content: decodeBodyAsText(
      response.bodyBuffer,
      response.headers.get('content-type'),
    ).trim(),
  }
}
