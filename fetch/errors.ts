import type { FetchErrorCode, FetchErrorPhase } from './types.ts'

export type WebFetchErrorMeta = {
  code: FetchErrorCode
  phase: FetchErrorPhase
  retryable: boolean
  statusCode?: number
  statusText?: string
  url?: string
  finalUrl?: string
}

export class WebFetchError extends Error {
  readonly meta: WebFetchErrorMeta

  constructor(message: string, meta: WebFetchErrorMeta) {
    super(message)
    this.name = 'WebFetchError'
    this.meta = meta
  }
}

function getWebFetchErrorHint(error: WebFetchError) {
  if (error.meta.code === 'timeout') return 'Next: retry with a larger timeout or a narrower URL.'
  if (error.meta.code === 'http_error' && (error.meta.statusCode === 403 || error.meta.statusCode === 429)) {
    return 'Next: retry later, use refresh=true, or use an allowed proxy/header if appropriate.'
  }
  if (error.meta.code === 'response_too_large') return 'Next: use a CSS selector, maxChars, or fetch a more specific page.'
  if (error.meta.code === 'invalid_request' && /selector/i.test(error.message)) {
    return 'Next: retry without selector or inspect the page with format=html.'
  }
  if (error.meta.code === 'fallback_error') return 'Next: retry the original URL directly or fetch a more specific source URL.'
  return undefined
}

export function buildWebFetchErrorMessage(error: WebFetchError) {
  const parts = [
    `[web_fetch_error] code=${error.meta.code}`,
    `phase=${error.meta.phase}`,
    `retryable=${error.meta.retryable}`,
  ]

  if (error.meta.statusCode !== undefined) {
    parts.push(`status=${error.meta.statusCode}`)
  }
  if (error.meta.statusText) {
    parts.push(`statusText=${encodeURIComponent(error.meta.statusText)}`)
  }
  if (error.meta.url) {
    parts.push(`url=${encodeURIComponent(error.meta.url)}`)
  }
  if (error.meta.finalUrl) {
    parts.push(`finalUrl=${encodeURIComponent(error.meta.finalUrl)}`)
  }

  const hint = getWebFetchErrorHint(error)
  return [error.message, hint, parts.join(' ')].filter(Boolean).join('\n')
}

export function createWebFetchError(
  message: string,
  meta: WebFetchErrorMeta,
): WebFetchError {
  return new WebFetchError(message, meta)
}

export function mapUnknownError(
  error: unknown,
  url?: string,
  finalUrl?: string,
): WebFetchError {
  if (error instanceof WebFetchError) return error

  const message = error instanceof Error ? error.message : String(error)

  const structuredMatch = message.match(/\[web_fetch_error\]\s+([^\n]+)/)
  if (structuredMatch) {
    const attrs = Object.fromEntries(
      structuredMatch[1]!
        .split(/\s+/)
        .map((pair) => pair.split('=').slice(0, 2))
        .filter((parts) => parts.length === 2),
    ) as Record<string, string>

    const code = attrs.code as FetchErrorCode | undefined
    const phase = attrs.phase as FetchErrorPhase | undefined
    if (code && phase) {
      const baseMessage = message.split('\n')[0] || message
      const statusCode = attrs.status ? Number.parseInt(attrs.status, 10) : undefined

      return createWebFetchError(baseMessage, {
        code,
        phase,
        retryable: attrs.retryable === 'true',
        statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
        statusText: attrs.statusText
          ? decodeURIComponent(attrs.statusText)
          : undefined,
        url: attrs.url ? decodeURIComponent(attrs.url) : url,
        finalUrl: attrs.finalUrl ? decodeURIComponent(attrs.finalUrl) : finalUrl,
      })
    }
  }

  if (/timed out/i.test(message)) {
    return createWebFetchError(message, {
      code: 'timeout',
      phase: 'network',
      retryable: true,
      url,
      finalUrl,
    })
  }

  if (/^Invalid URL:/.test(message) || /^Unsupported protocol:/.test(message)) {
    return createWebFetchError(message, {
      code: 'invalid_request',
      phase: 'resolve',
      retryable: false,
      url,
      finalUrl,
    })
  }

  if (/Selector is not supported/i.test(message)) {
    return createWebFetchError(message, {
      code: 'invalid_request',
      phase: 'resolve',
      retryable: false,
      url,
      finalUrl,
    })
  }

  if (/Response too large|HTML response too large/i.test(message)) {
    return createWebFetchError(message, {
      code: 'response_too_large',
      phase: 'download',
      retryable: false,
      url,
      finalUrl,
    })
  }

  if (/Jina Reader fetch failed/i.test(message)) {
    return createWebFetchError(message, {
      code: 'fallback_error',
      phase: 'extract',
      retryable: true,
      url,
      finalUrl,
    })
  }

  const httpMatch = message.match(/^Fetch failed: (\d{3})\s*(.*)$/)
  if (httpMatch) {
    const statusCode = Number.parseInt(httpMatch[1] || '0', 10)
    const statusText = (httpMatch[2] || '').trim() || undefined
    return createWebFetchError(message, {
      code: 'http_error',
      phase: 'response',
      retryable: statusCode === 429 || statusCode >= 500,
      statusCode,
      statusText,
      url,
      finalUrl,
    })
  }

  if (/Failed to decode response body|Unsupported content-encoding/i.test(message)) {
    return createWebFetchError(message, {
      code: 'processing_error',
      phase: 'process',
      retryable: false,
      url,
      finalUrl,
    })
  }

  return createWebFetchError(message, {
    code: 'network_error',
    phase: 'unknown',
    retryable: true,
    url,
    finalUrl,
  })
}
