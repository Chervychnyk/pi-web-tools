import { DEFAULT_TIMEOUT, buildCacheKey } from '../shared.ts'
import type { FetchOutputFormat, ParsedFetchParams } from './types.ts'

export function parseFetchParams(params: {
  url: string
  format?: FetchOutputFormat
  selector?: string
  timeout?: number
  maxChars?: number
  refresh?: boolean
}): ParsedFetchParams {
  const url = params.url.trim()
  const requestedFormat = params.format
  const selector = params.selector?.trim() || undefined
  const timeoutMs = params.timeout ?? DEFAULT_TIMEOUT
  const maxChars = params.maxChars
  const refresh = params.refresh ?? false

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
  }
}

export function buildFetchCacheKey(params: ParsedFetchParams) {
  return buildCacheKey({
    tool: 'web_fetch',
    url: params.url,
    format: params.requestedFormat ?? '(auto)',
    selector: params.selector,
    maxChars: params.maxChars,
  })
}
