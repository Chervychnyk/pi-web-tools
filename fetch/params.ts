import { readWebToolsConfig } from '../config.ts'
import { DEFAULT_TIMEOUT, buildCacheKey } from '../shared.ts'
import type {
  FetchOutputFormat,
  ParsedBatchFetchParams,
  ParsedFetchParams,
} from './types.ts'

const DEFAULT_BATCH_CONCURRENCY = 4
const MAX_BATCH_REQUESTS = 25

function parseHeaders(
  headers: unknown,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('Invalid headers: expected an object of string pairs')
  }

  const entries = Object.entries(headers as Record<string, unknown>)
  const normalized: Record<string, string> = {}

  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim()
    if (!key) {
      throw new Error('Invalid headers: header names cannot be empty')
    }
    if (typeof rawValue !== 'string') {
      throw new Error(`Invalid header value for ${key}: expected string`)
    }
    normalized[key] = rawValue
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function parseProxy(proxy: unknown): string | undefined {
  if (proxy === undefined || proxy === null) return undefined
  if (typeof proxy !== 'string' || proxy.trim() === '') {
    throw new Error('Invalid proxy: expected a non-empty string URL')
  }

  let parsedProxy: URL
  try {
    parsedProxy = new URL(proxy)
  } catch {
    throw new Error(`Invalid proxy URL: ${proxy}`)
  }

  if (
    !['http:', 'https:', 'socks:', 'socks4:', 'socks5:', 'socks5h:'].includes(
      parsedProxy.protocol,
    )
  ) {
    throw new Error(
      `Unsupported proxy protocol: ${parsedProxy.protocol}. Use http, https, or socks proxies.`,
    )
  }

  return parsedProxy.toString()
}

export function parseFetchParams(params: {
  url: string
  format?: FetchOutputFormat
  selector?: string
  timeout?: number
  maxChars?: number
  refresh?: boolean
  headers?: Record<string, string>
  proxy?: string
}): ParsedFetchParams {
  const url = params.url.trim()
  const requestedFormat = params.format
  const selector = params.selector?.trim() || undefined
  const timeoutMs = params.timeout ?? DEFAULT_TIMEOUT
  const maxChars = params.maxChars
  const refresh = params.refresh ?? false
  const headers = parseHeaders(params.headers)
  const config = readWebToolsConfig()
  const proxy = parseProxy(params.proxy ?? config.proxy)

  if (!url) throw new Error('URL cannot be empty')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeout: ${timeoutMs}`)
  }
  if (
    maxChars !== undefined &&
    (!Number.isInteger(maxChars) || maxChars <= 0)
  ) {
    throw new Error(`Invalid maxChars: ${maxChars}`)
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`)
  }

  return {
    url,
    parsedUrl,
    requestedFormat,
    selector,
    timeoutMs,
    maxChars,
    refresh,
    headers,
    proxy,
  }
}

export function parseBatchFetchParams(params: {
  requests?: Array<{
    url: string
    format?: FetchOutputFormat
    selector?: string
    timeout?: number
    maxChars?: number
    refresh?: boolean
    headers?: Record<string, string>
    proxy?: string
  }>
  concurrency?: number
}): ParsedBatchFetchParams {
  const requests = Array.isArray(params.requests) ? params.requests : []
  if (requests.length === 0) {
    throw new Error('requests must contain at least one fetch request')
  }
  if (requests.length > MAX_BATCH_REQUESTS) {
    throw new Error(
      `Too many requests: ${requests.length}. Maximum supported batch size is ${MAX_BATCH_REQUESTS}`,
    )
  }

  const concurrency = params.concurrency ?? DEFAULT_BATCH_CONCURRENCY
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`Invalid concurrency: ${concurrency}`)
  }

  return {
    requests: requests.map((request) => parseFetchParams(request)),
    concurrency,
  }
}

export function buildFetchCacheKey(params: ParsedFetchParams) {
  return buildCacheKey({
    tool: 'web_fetch',
    url: params.url,
    format: params.requestedFormat ?? '(auto)',
    selector: params.selector,
    maxChars: params.maxChars,
    headers: params.headers,
    proxy: params.proxy,
  })
}
