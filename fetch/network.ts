import { formatSize } from '@mariozechner/pi-coding-agent'
import * as dns from 'node:dns/promises'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import { execFileAsync, normalizeHostname, normalizeWhitespace } from '../shared.ts'
import type {
  FetchProgressHandler,
  GuardedFetchResponse,
  GuardedRequester,
} from './types.ts'

const FETCH_USER_AGENT = 'pi-web-fetch/1.1'
const FETCH_USER_AGENT_FALLBACK = 'web_fetch/1.1'
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
  const normalized = address.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mappedIpv4 ? mappedIpv4[1] : normalized
}

function parseIpv4Octets(address: string) {
  if (net.isIP(address) !== 4) return undefined
  const octets = address.split('.').map((part) => Number.parseInt(part, 10))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
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
      throw new Error(`Blocked private network address for ${hostname}: ${entry.address}`)
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

async function requestWithDnsGuard(
  url: URL,
  signal: AbortSignal,
  userAgent: string,
): Promise<GuardedFetchResponse> {
  assertSafeFetchUrl(url)

  const client = url.protocol === 'https:' ? https : http
  const acceptHeader =
    'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,image/*;q=0.9,*/*;q=0.8'

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

    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: {
          'User-Agent': userAgent,
          Accept: acceptHeader,
          'Accept-Encoding': ACCEPT_ENCODING_HEADER,
        },
        lookup: safeLookup,
        signal,
      },
      (response) => {
        const rawContentType = response.headers['content-type']
        const contentType = Array.isArray(rawContentType)
          ? rawContentType[0] || ''
          : rawContentType || ''
        const mimeType = contentType.split(';')[0]?.trim().toLowerCase() || ''
        const maxBytes = getResponseByteLimit(mimeType)
        const rawContentLength = response.headers['content-length']
        const contentLength = parseContentLength(
          Array.isArray(rawContentLength)
            ? rawContentLength[0] || null
            : rawContentLength || null,
        )

        if (contentLength !== undefined && contentLength > maxBytes) {
          const error = createResponseTooLargeError(
            url,
            contentLength,
            maxBytes,
            mimeType,
          )
          response.destroy(error)
          request.destroy(error)
          rejectOnce(error)
          return
        }

        const chunks: Buffer[] = []
        let totalBytes = 0

        response.on('data', (chunk) => {
          if (settled) return

          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          totalBytes += buffer.byteLength
          if (totalBytes > maxBytes) {
            const error = createResponseTooLargeError(
              url,
              totalBytes,
              maxBytes,
              mimeType,
            )
            response.destroy(error)
            request.destroy(error)
            rejectOnce(error)
            return
          }

          chunks.push(buffer)
        })
        response.on('error', rejectOnce)
        response.on('end', () => {
          const headers = new Headers()
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) headers.set(key, value.join(', '))
            else if (value !== undefined) headers.set(key, String(value))
          }

          try {
            let bodyBuffer = Buffer.concat(chunks)
            bodyBuffer = decodeContentEncoding(
              bodyBuffer,
              headers.get('content-encoding'),
              {
                url: url.toString(),
                maxBytes,
                mimeType,
              },
            )

            if (headers.has('content-encoding')) {
              headers.delete('content-encoding')
              headers.delete('content-length')
            }

            const status = response.statusCode ?? 0
            resolveOnce({
              url: url.toString(),
              status,
              statusText: response.statusMessage ?? '',
              headers,
              ok: status >= 200 && status < 300,
              bodyBuffer,
            })
          } catch (error) {
            rejectOnce(error)
          }
        })
      },
    )

    request.on('error', rejectOnce)
    request.end()
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
): Promise<GuardedFetchResponse> {
  let currentUrl = new URL(initialUrl.toString())

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await requester(currentUrl, signal, userAgent)
    if (!isRedirectStatus(response.status)) return response

    const location = response.headers.get('location')
    if (!location) return response
    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(`Too many redirects while fetching ${initialUrl.toString()}`)
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
) {
  let response = await fetchWithRedirects(url, signal, FETCH_USER_AGENT, requester)
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
  const normalized = charset.trim().replace(/^['"]|['"]$/g, '').toLowerCase()
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
  const charset = detectBomEncoding(bodyBuffer) || parseCharsetFromContentType(contentTypeHeader) || 'utf-8'

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
  return new URL(`https://${JINA_READER_HOST}/http://${url.replace(/^https?:\/\//i, '')}`)
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
    const { stdout } = await execFileAsync('pdftotext', [inputPath, '-'], signal)
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
  const pageLimit = Math.max(1, Math.min(document.numPages, MAX_JS_PDF_EXTRACT_PAGES))
  const pages: string[] = []

  for (let pageIndex = 1; pageIndex <= pageLimit; pageIndex += 1) {
    if (signal?.aborted) throw createAbortError('PDF extraction')

    const page = await document.getPage(pageIndex)
    const textContent = await page.getTextContent()
    const text = normalizeWhitespace(
      textContent.items
        .map((item) => item.str || '')
        .join(' '),
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

    const primary = pdftotextError instanceof Error
      ? pdftotextError.message
      : String(pdftotextError)
    const fallback = fallbackError instanceof Error
      ? fallbackError.message
      : String(fallbackError)

    throw new Error(
      `PDF extraction failed (pdftotext + JS fallback). pdftotext: ${primary}. js: ${fallback}`,
    )
  }
}

export function shouldUseJinaFallbackForStatus(status: number) {
  return [401, 403, 408, 409, 425, 429, 451, 500, 502, 503, 504].includes(status)
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
  )

  if (!response.ok) {
    throw new Error(`Jina Reader fetch failed: ${response.status} ${response.statusText}`)
  }

  return {
    response,
    content: decodeBodyAsText(
      response.bodyBuffer,
      response.headers.get('content-type'),
    ).trim(),
  }
}
