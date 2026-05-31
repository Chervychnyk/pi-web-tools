import { formatSize } from '@mariozechner/pi-coding-agent'
import { applyPromptGuidance } from '../config.ts'
import { rmSync } from 'node:fs'
import { StringEnum } from '@mariozechner/pi-ai'
import { Text } from '@mariozechner/pi-tui'
import { Type } from 'typebox'
import { fetchGitHubContent, parseGitHubUrl } from '../github.ts'
import {
  DEFAULT_TIMEOUT,
  createAbortController,
  getCachedValue,
  renderBadges,
  renderToolCallHeader,
  truncateText,
} from '../shared.ts'
import { classifyFetchResponse } from './classify.ts'
import { extensionForFormat } from './content.ts'
import { extractFetchContent } from './extract.ts'
import {
  buildFetchCacheKey,
  parseBatchFetchParams,
  parseFetchParams,
} from './params.ts'
import { emitFetchProgress } from './progress.ts'
import {
  buildFileFetchResult,
  buildImageFetchResult,
  buildTextFetchResult,
  composeFetchTextOutput,
} from './result.ts'
import {
  decodeContentEncoding,
  extractPdfText,
  fetchViaJinaReader,
  fetchWithOptionalCloudflareRetry,
  MAX_HTML_BYTES,
  shouldApplyHtmlGuard,
  shouldUseJinaFallbackForStatus,
} from './network.ts'
import type {
  BatchFetchDetails,
  BatchFetchItemSummary,
  FetchDetails,
  FetchErrorCode,
  FetchErrorPhase,
  FetchOutputFormat,
  FetchToolContent,
} from './types.ts'

const LARGE_RESPONSE_WARNING_BYTES = 1 * 1024 * 1024
const DEFAULT_BATCH_CONCURRENCY = 4

type WebFetchErrorMeta = {
  code: FetchErrorCode
  phase: FetchErrorPhase
  retryable: boolean
  statusCode?: number
  statusText?: string
  url?: string
  finalUrl?: string
}

class WebFetchError extends Error {
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

function buildWebFetchErrorMessage(error: WebFetchError) {
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

function createWebFetchError(
  message: string,
  meta: WebFetchErrorMeta,
): WebFetchError {
  return new WebFetchError(message, meta)
}

function mapUnknownError(
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

function cleanupDownloadedFile(filePath: string | undefined): void {
  if (!filePath) return
  rmSync(filePath, { force: true })
}

function statusToProgress(status: BatchFetchItemSummary['status']) {
  switch (status) {
    case 'queued':
      return 0
    case 'running':
      return 0.55
    case 'done':
      return 1
    case 'error':
      return 1
    default:
      return 0
  }
}

function truncateMiddle(value: string, width: number) {
  if (width <= 0) return ''
  if (value.length <= width) return value
  if (width <= 1) return '…'

  const left = Math.ceil((width - 1) / 2)
  const right = Math.floor((width - 1) / 2)
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`
}

function buildProgressBar(
  progress: number,
  width: number,
) {
  const bounded = Math.max(0, Math.min(1, progress))
  const cells = Math.max(6, width)
  const filled = Math.max(0, Math.min(cells, Math.round(cells * bounded)))
  return `[${'█'.repeat(filled)}${'░'.repeat(cells - filled)}]`
}

function statusGlyph(status: BatchFetchItemSummary['status']) {
  if (status === 'done') return '✓'
  if (status === 'error') return '✗'
  if (status === 'running') return '⠿'
  return '·'
}

function renderBatchRows(
  details: BatchFetchDetails,
  width: number,
  expanded: boolean,
) {
  const maxRows = expanded ? details.items.length : 8
  const selected = details.items.slice(0, maxRows)
  const rows: string[] = []

  const available = Math.max(30, width)
  const prefixWidth = 4
  const barWidth = Math.min(14, Math.max(8, Math.floor(available * 0.18)))
  const statusWidth = 7
  const urlWidth = Math.max(
    12,
    available - prefixWidth - barWidth - statusWidth - 4,
  )

  for (const item of selected) {
    const status = item.status.padEnd(statusWidth, ' ')
    const url = truncateMiddle(item.url, urlWidth)
    const progress = item.progress ?? statusToProgress(item.status)
    const bar = buildProgressBar(progress, barWidth)
    rows.push(`${statusGlyph(item.status)} ${url} ${status} ${bar}`)

    if (expanded && item.status === 'error' && item.error) {
      rows.push(`  ↳ ${item.error}`)
    }
  }

  if (!expanded && details.items.length > maxRows) {
    rows.push(`… ${details.items.length - maxRows} more items (expand to view all)`)
  }

  return rows
}

export type WebFetchDependencies = {
  githubFetcher: typeof fetchGitHubContent
  networkFetcher: typeof fetchWithOptionalCloudflareRetry
  jinaFetcher: typeof fetchViaJinaReader
  pdfTextExtractor: typeof extractPdfText
}

function canUseTextLikeFetchFormat(format: FetchOutputFormat | undefined) {
  return format === undefined || format === 'markdown' || format === 'text'
}

function buildGitHubFetchResult(options: {
  githubContent: NonNullable<Awaited<ReturnType<typeof fetchGitHubContent>>>
  requestedFormat: FetchOutputFormat | undefined
  maxChars: number | undefined
  cacheKey: string
  requestUrl: string
}) {
  const { githubContent, requestedFormat, maxChars, cacheKey, requestUrl } = options
  const format = requestedFormat ?? 'markdown'

  return buildTextFetchResult(
    githubContent.text,
    '.md',
    maxChars,
    cacheKey,
    requestUrl,
    {
      url: githubContent.finalUrl,
      format,
      githubType: githubContent.githubType,
      githubSource: githubContent.githubSource,
      githubLocalPath: githubContent.githubLocalPath,
      title: githubContent.title,
      contentType: githubContent.contentType,
      cached: false,
      cacheAgeMs: 0,
    },
  )
}

function validateGitHubRequest(
  isGitHubUrl: boolean,
  selector: string | undefined,
  requestedFormat: FetchOutputFormat | undefined,
) {
  if (!isGitHubUrl) return

  if (selector) {
    throw new Error('Selector is not supported for GitHub repository URLs')
  }
  if (!canUseTextLikeFetchFormat(requestedFormat)) {
    throw new Error(
      `GitHub repository URLs only support markdown or text output, received: ${requestedFormat}`,
    )
  }
}

function validateResponseCompatibility(options: {
  selector: string | undefined
  format: FetchOutputFormat
  isHtml: boolean
  isJson: boolean
  isPdf: boolean
  mimeType: string
}) {
  const { selector, format, isHtml, isJson, isPdf, mimeType } = options

  if (isPdf && selector) {
    throw new Error('Selector is not supported for PDF output')
  }
  if (isPdf && !['markdown', 'text'].includes(format)) {
    throw new Error(
      `PDF content only supports markdown or text output, received: ${format}`,
    )
  }
  if (selector && !isHtml) {
    if (isJson || format === 'json') {
      throw new Error('Selector is not supported for json output')
    }

    throw new Error(
      `Selector is only supported for HTML responses, received: ${mimeType || 'unknown'}`,
    )
  }
}

export function createWebFetchTool(deps: Partial<WebFetchDependencies> = {}) {
  const githubFetcher = deps.githubFetcher || fetchGitHubContent
  const networkFetcher = deps.networkFetcher || fetchWithOptionalCloudflareRetry
  const jinaFetcher = deps.jinaFetcher || fetchViaJinaReader
  const pdfTextExtractor = deps.pdfTextExtractor || extractPdfText

  return applyPromptGuidance({
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch content from a URL and convert it to markdown, text, html, json, or image. Binary/attachment responses are saved to a temp file with metadata.',
    promptSnippet:
      'Fetch a web page, image, API endpoint, or attachment and return readable output or downloaded file metadata',
    promptGuidelines: [
      'Use markdown for readable article content, text for plain extraction, html for raw markup, json for APIs, and image for direct image responses.',
      'Attachment or binary responses are downloaded to a temp file and returned with file path/size metadata.',
      'GitHub repository URLs are handled specially and return local-clone-backed repository content instead of scraped HTML.',
      'Use the selector parameter when the user wants a specific part of the page, such as article or #content.',
      'Use headers for authenticated/API requests and proxy for network-restricted environments when needed.',
      'When a responseId is returned, use get_web_content to retrieve stored full content later.',
      `Very large HTML responses over ${formatSize(MAX_HTML_BYTES)} are rejected to avoid expensive parsing.`,
    ],
    parameters: Type.Object({
      url: Type.String({ description: 'URL to fetch' }),
      format: Type.Optional(
        StringEnum(['markdown', 'text', 'html', 'json', 'image'] as const, {
          description:
            'Output format. Defaults to markdown, or image when the response is an image.',
        }),
      ),
      selector: Type.Optional(
        Type.String({
          description:
            'Optional CSS selector to extract a specific part of the page',
        }),
      ),
      headers: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            'Optional custom HTTP headers (e.g. Authorization, Accept-Language).',
        }),
      ),
      proxy: Type.Optional(
        Type.String({
          description:
            'Optional proxy URL (http/https/socks). Example: http://user:pass@proxy.example:8080',
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: `Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT})`,
        }),
      ),
      maxChars: Type.Optional(
        Type.Number({
          description:
            'Optional hard cap for text output characters before normal truncation is applied.',
        }),
      ),
      refresh: Type.Optional(
        Type.Boolean({
          description:
            'Bypass cached fetch results and force a fresh network request.',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const parsed = parseFetchParams(params)
      const cacheKey = buildFetchCacheKey(parsed)

      if (!parsed.refresh) {
        const cached = getCachedValue<{
          content: FetchToolContent
          details: FetchDetails
        }>(cacheKey)
        if (cached) {
          emitFetchProgress(
            onUpdate,
            'cache',
            `Using cached fetch result for ${parsed.url}`,
          )
          return {
            content: cached.value.content,
            details: {
              ...cached.value.details,
              cached: true,
              cacheAgeMs: cached.ageMs,
            } satisfies FetchDetails,
          }
        }
      }

      emitFetchProgress(
        onUpdate,
        'resolve',
        `Validating and fetching ${parsed.url}...`,
      )

      const { controller, cleanup, rethrowIfAbort } = createAbortController(
        parsed.timeoutMs,
        signal,
      )
      let downloadedFilePathForCleanup: string | undefined

      try {
        const githubUrl = parseGitHubUrl(parsed.url)
        validateGitHubRequest(Boolean(githubUrl), parsed.selector, parsed.requestedFormat)

        const githubContent = await githubFetcher(
          parsed.url,
          controller.signal,
          onUpdate,
          parsed.refresh,
        )
        if (githubContent) {
          return buildGitHubFetchResult({
            githubContent,
            requestedFormat: parsed.requestedFormat,
            maxChars: parsed.maxChars,
            cacheKey,
            requestUrl: parsed.url,
          })
        }

        emitFetchProgress(
          onUpdate,
          'network',
          `Requesting ${parsed.parsedUrl.hostname}...`,
        )

        const { response, cloudflareBypassed } = await networkFetcher(
          parsed.parsedUrl,
          controller.signal,
          onUpdate,
          undefined,
          {
            headers: parsed.headers,
            proxy: parsed.proxy,
          },
        )
        downloadedFilePathForCleanup = response.downloadedFilePath

        emitFetchProgress(
          onUpdate,
          'response',
          `Received ${response.status} ${response.statusText || ''}`.trim(),
        )

        if (!response.ok) {
          const nonOkFinalUrl = response.url || parsed.parsedUrl.toString()

          if (
            !parsed.selector &&
            canUseTextLikeFetchFormat(parsed.requestedFormat) &&
            shouldUseJinaFallbackForStatus(response.status)
          ) {
            const jina = await jinaFetcher(
              new URL(nonOkFinalUrl),
              controller.signal,
              onUpdate,
              undefined,
              { proxy: parsed.proxy },
            )
            const jinaFormat = parsed.requestedFormat ?? 'markdown'
            cleanupDownloadedFile(downloadedFilePathForCleanup)
            downloadedFilePathForCleanup = undefined
            return buildTextFetchResult(
              jina.content,
              extensionForFormat(jinaFormat),
              parsed.maxChars,
              cacheKey,
              parsed.url,
              {
                url: nonOkFinalUrl,
                format: jinaFormat,
                status: response.status,
                statusText: response.statusText,
                contentType: 'text/markdown; charset=utf-8',
                jinaFallbackUsed: true,
                cached: false,
                cacheAgeMs: 0,
              },
            )
          }

          throw createWebFetchError(
            `Fetch failed: ${response.status} ${response.statusText}`,
            {
              code: 'http_error',
              phase: 'response',
              retryable: response.status === 429 || response.status >= 500,
              statusCode: response.status,
              statusText: response.statusText,
              url: parsed.url,
              finalUrl: nonOkFinalUrl,
            },
          )
        }

        const classification = classifyFetchResponse(
          response,
          parsed.parsedUrl,
          parsed.requestedFormat,
        )

        const redirectedGithubUrl = !githubUrl
          ? parseGitHubUrl(classification.finalUrl)
          : null
        if (
          redirectedGithubUrl &&
          !parsed.selector &&
          canUseTextLikeFetchFormat(parsed.requestedFormat)
        ) {
          emitFetchProgress(
            onUpdate,
            'github',
            `Redirected to GitHub URL, switching to repository extraction for ${classification.finalUrl}`,
          )

          const redirectedGithubContent = await githubFetcher(
            classification.finalUrl,
            controller.signal,
            onUpdate,
            parsed.refresh,
          )

          if (redirectedGithubContent) {
            return buildGitHubFetchResult({
              githubContent: redirectedGithubContent,
              requestedFormat: parsed.requestedFormat,
              maxChars: parsed.maxChars,
              cacheKey,
              requestUrl: parsed.url,
            })
          }
        }

        validateResponseCompatibility({
          selector: parsed.selector,
          format: classification.format,
          isHtml: classification.isHtml,
          isJson: classification.isJson,
          isPdf: classification.isPdf,
          mimeType: classification.mimeType,
        })

        if (
          classification.contentLength !== undefined &&
          classification.contentLength > LARGE_RESPONSE_WARNING_BYTES
        ) {
          onUpdate?.({
            content: [
              {
                type: 'text',
                text: `Large response detected (${formatSize(classification.contentLength)}).`,
              },
            ],
          })
        }

        if (
          shouldApplyHtmlGuard(
            classification.mimeType,
            classification.format,
            classification.contentLength,
          )
        ) {
          throw createWebFetchError(
            `HTML response too large to process safely: ${formatSize(classification.contentLength!)} (max ${formatSize(MAX_HTML_BYTES)})`,
            {
              code: 'response_too_large',
              phase: 'download',
              retryable: false,
              url: parsed.url,
              finalUrl: classification.finalUrl,
            },
          )
        }

        if (classification.isAttachment || classification.isBinary) {
          const streamedSize =
            response.downloadedFileSize ?? classification.contentLength ?? 0

          emitFetchProgress(
            onUpdate,
            'download',
            `Downloaded ${formatSize(streamedSize)} from ${new URL(classification.finalUrl).hostname}`,
          )

          const fileResult = buildFileFetchResult({
            bodyBuffer: response.downloadedFilePath ? undefined : response.bodyBuffer,
            existingFilePath: response.downloadedFilePath,
            existingFileSize: response.downloadedFileSize,
            finalUrl: classification.finalUrl,
            mimeType: classification.mimeType,
            contentDisposition: classification.contentDisposition,
            details: {
              url: classification.finalUrl,
              format: classification.format,
              title: null,
              status: classification.status,
              statusText: classification.statusText,
              contentType: classification.contentType,
              contentLength: classification.contentLength ?? streamedSize,
              cloudflareBypassed,
              cached: false,
              cacheAgeMs: 0,
              isImage: false,
            },
          })

          downloadedFilePathForCleanup = undefined
          return fileResult
        }

        const bodyBuffer = decodeContentEncoding(
          response.bodyBuffer,
          response.headers.get('content-encoding'),
          {
            url: classification.finalUrl,
            mimeType: classification.mimeType,
          },
        )
        const bodySize = bodyBuffer.byteLength

        emitFetchProgress(
          onUpdate,
          'download',
          `Downloaded ${formatSize(bodySize)} from ${new URL(classification.finalUrl).hostname}`,
        )

        if (
          classification.isHtml &&
          ['markdown', 'text', 'html'].includes(classification.format) &&
          bodySize > MAX_HTML_BYTES
        ) {
          throw createWebFetchError(
            `HTML response too large to process safely: ${formatSize(bodySize)} (max ${formatSize(MAX_HTML_BYTES)})`,
            {
              code: 'response_too_large',
              phase: 'download',
              retryable: false,
              url: parsed.url,
              finalUrl: classification.finalUrl,
            },
          )
        }

        if (classification.isImage || classification.format === 'image') {
          if (!classification.isImage) {
            throw createWebFetchError(
              `Requested image output but received non-image content type: ${classification.mimeType || 'unknown'}`,
              {
                code: 'invalid_request',
                phase: 'response',
                retryable: false,
                url: parsed.url,
                finalUrl: classification.finalUrl,
              },
            )
          }

          return buildImageFetchResult(
            bodyBuffer,
            classification.mimeType,
            classification.finalUrl,
            classification.format,
            bodySize,
            {
              url: classification.finalUrl,
              format: classification.format,
              title: null,
              charLimited: false,
              maxChars: undefined,
              originalChars: 0,
              isImage: true,
              imageMimeType: classification.mimeType,
              imageSize: bodySize,
              status: classification.status,
              statusText: classification.statusText,
              contentType: classification.contentType,
              contentLength: classification.contentLength ?? bodySize,
              cloudflareBypassed,
              cached: false,
              cacheAgeMs: 0,
            },
          )
        }

        const extracted = await extractFetchContent({
          bodyBuffer,
          classification,
          selector: parsed.selector,
          signal: controller.signal,
          onUpdate,
          jinaFetcher,
          pdfTextExtractor,
          requestOptions: { proxy: parsed.proxy },
        })

        return buildTextFetchResult(
          composeFetchTextOutput(
            classification.format,
            extracted.content,
            extracted.article,
          ),
          extensionForFormat(classification.format),
          parsed.maxChars,
          cacheKey,
          parsed.url,
          {
            url: classification.finalUrl,
            format: classification.format,
            title: extracted.article?.title,
            byline: extracted.article?.byline,
            siteName: extracted.article?.siteName,
            excerpt: extracted.article?.excerpt,
            selectedSelector: extracted.article?.selectedSelector,
            extractionMethod: extracted.article?.extractionMethod,
            status: classification.status,
            statusText: classification.statusText,
            contentType: classification.contentType,
            contentLength: classification.contentLength ?? bodySize,
            cloudflareBypassed,
            jinaFallbackUsed: extracted.jinaFallbackUsed,
            pdfExtracted: extracted.pdfExtracted,
            cached: false,
            cacheAgeMs: 0,
          },
        )
      } catch (error) {
        try {
          rethrowIfAbort(error, 'Fetch request')
        } catch (normalized) {
          const mapped = mapUnknownError(normalized, parsed.url)
          throw new Error(buildWebFetchErrorMessage(mapped))
        }
      } finally {
        cleanup()
        cleanupDownloadedFile(downloadedFilePathForCleanup)
      }
    },
    renderCall(args, theme) {
      const parts: string[] = []
      if (args.format) parts.push(`format=${args.format}`)
      if (args.selector) parts.push(`selector=${args.selector}`)
      if (args.maxChars) parts.push(`maxChars=${args.maxChars}`)
      if (args.timeout) parts.push(`timeout=${args.timeout}ms`)
      if (args.headers) parts.push('headers')
      if (args.proxy) parts.push('proxy')
      if (args.refresh) parts.push('refresh=true')
      return renderToolCallHeader('web_fetch', args.url, 84, parts, theme)
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg('warning', 'Fetching...'), 0, 0)

      const details = (result.details || {}) as FetchDetails
      let text = ''

      if (details.isImage) {
        text += theme.fg(
          'success',
          `Image ${details.imageMimeType || ''}`.trim(),
        )
        if (details.imageSize) {
          text += theme.fg('dim', ` (${formatSize(details.imageSize)})`)
        }
      } else if (details.isFile) {
        text += theme.fg('success', 'file downloaded')
        if (details.fileName) {
          text += ` ${theme.fg('accent', truncateText(details.fileName, 80))}`
        }
        if (details.fileSize !== undefined) {
          text += theme.fg('dim', ` (${formatSize(details.fileSize)})`)
        }
      } else {
        text += theme.fg('success', details.format || 'fetched')
        if (details.title) {
          text += ` ${theme.fg('accent', truncateText(details.title, 80))}`
        }
      }

      text += renderBadges(theme, {
        truncated: details.truncated,
        charLimited: details.charLimited,
        selector: details.selectedSelector,
        extractionMethod: details.extractionMethod,
        cloudflareBypassed: details.cloudflareBypassed,
        fallbackUsed: details.jinaFallbackUsed,
        cached: details.cached,
      })

      if (expanded) {
        if (details.responseId) {
          text += `\n${theme.fg('muted', `Stored responseId: ${details.responseId}`)}`
        }
        text += `\n${theme.fg('dim', `URL: ${details.url || 'unknown'}`)}`
        if (details.cached && details.cacheAgeMs !== undefined) {
          text += `\n${theme.fg('dim', `Cache age: ${details.cacheAgeMs}ms`)}`
        }
        if (details.status) {
          text += `\n${theme.fg('dim', `HTTP: ${details.status} ${details.statusText || ''}`.trim())}`
        }
        if (details.contentType) {
          text += `\n${theme.fg('dim', `Content-Type: ${details.contentType}`)}`
        }
        if (details.jinaFallbackUsed) {
          text += `\n${theme.fg('muted', 'Fallback: Jina Reader')}`
        }
        if (details.pdfExtracted) {
          text += `\n${theme.fg('muted', 'PDF: text extracted')}`
        }
        if (details.contentLength !== undefined) {
          text += `\n${theme.fg('dim', `Content-Length: ${formatSize(details.contentLength)}`)}`
        }
        if (details.title) {
          text += `\n${theme.fg('accent', `Title: ${details.title}`)}`
        }
        if (details.githubType) {
          const githubLabel = details.githubSource
            ? `${details.githubType} (${details.githubSource})`
            : details.githubType
          text += `\n${theme.fg('muted', `GitHub: ${githubLabel}`)}`
        }
        if (details.githubLocalPath) {
          text += `\n${theme.fg('muted', `Local path: ${details.githubLocalPath}`)}`
        }
        if (details.byline) {
          text += `\n${theme.fg('muted', `Byline: ${details.byline}`)}`
        }
        if (details.siteName) {
          text += `\n${theme.fg('muted', `Site: ${details.siteName}`)}`
        }
        if (details.extractionMethod) {
          text += `\n${theme.fg('muted', `Extraction: ${details.extractionMethod}`)}`
        }
        if (details.filePath) {
          text += `\n${theme.fg('muted', `Downloaded file: ${details.filePath}`)}`
        }
        if (details.fileName) {
          text += `\n${theme.fg('muted', `File name: ${details.fileName}`)}`
        }
        if (details.fileSize !== undefined) {
          text += `\n${theme.fg('muted', `File size: ${formatSize(details.fileSize)}`)}`
        }
        if (details.tempFile) {
          text += `\n${theme.fg('muted', `Full output: ${details.tempFile}`)}`
        }
      }

      return new Text(text, 0, 0)
    },
  })
}

function buildBatchSummaryText(details: BatchFetchDetails) {
  const lines = [
    `Batch web fetch: ${details.completed}/${details.total} complete · ${details.succeeded} succeeded · ${details.failed} failed · concurrency ${details.concurrency}`,
  ]

  for (const item of details.items) {
    if (item.status === 'done') {
      const responseId = item.responseId ? ` responseId=${item.responseId}` : ''
      const statusCode = item.statusCode ? ` HTTP ${item.statusCode}` : ''
      lines.push(`${item.index + 1}. ✓ ${item.url}${statusCode}${responseId}`)
      continue
    }

    if (item.status === 'error') {
      const errorTag = item.errorCode
        ? ` [${item.errorCode}/${item.errorPhase || 'unknown'}]`
        : ''
      lines.push(
        `${item.index + 1}. ✗ ${item.url}${errorTag} — ${item.error || 'Unknown error'}`,
      )
      continue
    }

    lines.push(`${item.index + 1}. … ${item.url} — ${item.status}`)
  }

  return lines.join('\n')
}

function createResponsiveBatchResultComponent(
  details: BatchFetchDetails,
  expanded: boolean,
  theme: {
    fg(color: string, value: string): string
    bold(value: string): string
  },
) {
  const text = new Text('', 0, 0)

  return {
    render(width: number) {
      const header = [
        theme.fg('toolTitle', theme.bold('batch_web_fetch ')),
        theme.fg(
          details.failed > 0 ? 'warning' : 'success',
          `${details.completed}/${details.total} done · ok ${details.succeeded} · err ${details.failed} · c=${details.concurrency}`,
        ),
      ].join('')

      const rows = expanded
        ? renderBatchRows(details, width, true)
        : renderBatchRows(details, width, false).slice(0, 4)

      text.setText([header, ...rows].join('\n'))
      return text.render(width)
    },
    invalidate() {
      text.invalidate()
    },
  }
}

export function createBatchWebFetchTool(
  deps: Partial<WebFetchDependencies> = {},
) {
  const singleFetchTool = createWebFetchTool(deps)

  return applyPromptGuidance({
    name: 'batch_web_fetch',
    label: 'Batch Web Fetch',
    description:
      'Fetch multiple URLs with bounded concurrency. Each request supports the same parameters as web_fetch.',
    promptSnippet:
      'Fetch multiple URLs concurrently with web_fetch-compatible parameters',
    promptGuidelines: [
      'Use this tool for multiple independent URLs to reduce round-trips.',
      'Each request supports url, format, selector, headers, proxy, timeout, maxChars, and refresh.',
      'Use get_web_content with responseId values from successful items to retrieve full stored content.',
    ],
    parameters: Type.Object({
      requests: Type.Array(
        Type.Object({
          url: Type.String({ description: 'URL to fetch' }),
          format: Type.Optional(
            StringEnum(['markdown', 'text', 'html', 'json', 'image'] as const, {
              description:
                'Output format. Defaults to markdown, or image when the response is an image.',
            }),
          ),
          selector: Type.Optional(
            Type.String({
              description:
                'Optional CSS selector to extract a specific part of the page',
            }),
          ),
          headers: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
              description: 'Optional custom HTTP headers.',
            }),
          ),
          proxy: Type.Optional(
            Type.String({
              description: 'Optional proxy URL (http/https/socks).',
            }),
          ),
          timeout: Type.Optional(
            Type.Number({
              description: `Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT})`,
            }),
          ),
          maxChars: Type.Optional(
            Type.Number({
              description:
                'Optional hard cap for text output characters before normal truncation is applied.',
            }),
          ),
          refresh: Type.Optional(
            Type.Boolean({
              description: 'Bypass cached fetch results and force a fresh request.',
            }),
          ),
        }),
        {
          minItems: 1,
          description: 'Array of web_fetch requests to execute.',
        },
      ),
      concurrency: Type.Optional(
        Type.Number({
          description: `Max concurrent requests (default ${DEFAULT_BATCH_CONCURRENCY}).`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const parsedBatch = parseBatchFetchParams(params)
      const concurrency = Math.min(
        parsedBatch.concurrency,
        parsedBatch.requests.length,
      )

      const items: BatchFetchItemSummary[] = parsedBatch.requests.map(
        (request, index) => ({
          index,
          url: request.url,
          status: 'queued',
          progress: statusToProgress('queued'),
        }),
      )

      let completed = 0
      let succeeded = 0
      let failed = 0

      const emitUpdate = () => {
        const details: BatchFetchDetails = {
          total: items.length,
          completed,
          succeeded,
          failed,
          concurrency,
          items: items.map((item) => ({ ...item })),
        }

        onUpdate?.({
          content: [{ type: 'text', text: buildBatchSummaryText(details) }],
          details,
        })
      }

      emitUpdate()

      let nextIndex = 0
      const worker = async () => {
        while (true) {
          const index = nextIndex
          nextIndex += 1
          if (index >= parsedBatch.requests.length) return

          const request = parsedBatch.requests[index]!
          items[index] = {
            ...items[index]!,
            status: 'running',
            progress: statusToProgress('running'),
          }
          emitUpdate()

          try {
            const result = await singleFetchTool.execute(
              `batch_web_fetch_${index}`,
              {
                url: request.url,
                format: request.requestedFormat,
                selector: request.selector,
                headers: request.headers,
                proxy: request.proxy,
                timeout: request.timeoutMs,
                maxChars: request.maxChars,
                refresh: request.refresh,
              },
              signal,
              undefined,
            )

            const details = (result.details || {}) as FetchDetails
            items[index] = {
              ...items[index]!,
              status: 'done',
              progress: statusToProgress('done'),
              title: details.title,
              format: details.format,
              responseId: details.responseId,
              statusCode: details.status,
            }
            completed += 1
            succeeded += 1
          } catch (error) {
            const mapped = mapUnknownError(error, request.url)
            items[index] = {
              ...items[index]!,
              status: 'error',
              progress: statusToProgress('error'),
              error: mapped.message,
              errorCode: mapped.meta.code,
              errorPhase: mapped.meta.phase,
              retryable: mapped.meta.retryable,
            }
            completed += 1
            failed += 1
          }

          emitUpdate()
        }
      }

      await Promise.all(
        Array.from({ length: concurrency }, async () => worker()),
      )

      const finalDetails: BatchFetchDetails = {
        total: items.length,
        completed,
        succeeded,
        failed,
        concurrency,
        items,
      }

      return {
        content: [{ type: 'text', text: buildBatchSummaryText(finalDetails) }],
        details: finalDetails,
      }
    },
    renderCall(args, theme) {
      const requestCount = Array.isArray(args.requests) ? args.requests.length : 0
      const parts = [`requests=${requestCount}`]
      if (args.concurrency) parts.push(`concurrency=${args.concurrency}`)
      return renderToolCallHeader(
        'batch_web_fetch',
        `${requestCount} requests`,
        84,
        parts,
        theme,
      )
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const details = (result.details || {}) as BatchFetchDetails

      if (!details.total) {
        return new Text(
          theme.fg('warning', isPartial ? 'Fetching batch...' : 'No batch results'),
          0,
          0,
        )
      }

      return createResponsiveBatchResultComponent(details, expanded, theme)
    },
  })
}
