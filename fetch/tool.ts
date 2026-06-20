import { StringEnum } from '@mariozechner/pi-ai'
import { formatSize } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from 'typebox'
import { applyPromptGuidance } from '../config.ts'
import type { fetchGitHubContent } from '../github.ts'
import { DEFAULT_TIMEOUT, createAbortController } from '../utils/abort.ts'
import { getCachedValue } from '../utils/cache.ts'
import { truncateText } from '../utils/truncate.ts'
import {
  compactUrl,
  formatDuration,
  renderBadges,
  renderToolCallHeader,
} from '../utils/ui.ts'
import {
  buildWebFetchErrorMessage,
  mapUnknownError,
} from './errors.ts'
import { createGitHubHandler } from './handlers/github.ts'
import { createDefaultHttpHandler } from './handlers/http.ts'
import {
  MAX_HTML_BYTES,
  extractPdfText,
  fetchViaJinaReader,
  fetchWithOptionalCloudflareRetry,
} from './network.ts'
import {
  buildFetchCacheKey,
  parseBatchFetchParams,
  parseFetchParams,
} from './params.ts'
import { createFetchProgress } from './progress.ts'
import type {
  BatchFetchDetails,
  BatchFetchItemSummary,
  FetchDetails,
  FetchToolContent,
} from './types.ts'
import type { FetchResult, UrlHandler } from './url-handler.ts'

const DEFAULT_BATCH_CONCURRENCY = 4

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

function buildProgressBar(progress: number, width: number) {
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

type BatchRowTheme = {
  fg(color: string, value: string): string
  bold(value: string): string
}

const BATCH_STATUS_COLORS: Record<BatchFetchItemSummary['status'], string> = {
  done: 'success',
  error: 'warning',
  running: 'accent',
  queued: 'dim',
}

const BATCH_BAR_MIN_WIDTH = 60

function renderBatchRows(
  details: BatchFetchDetails,
  width: number,
  expanded: boolean,
  theme: BatchRowTheme,
) {
  const maxRows = expanded ? details.items.length : 8
  const selected = details.items.slice(0, maxRows)
  const rows: string[] = []

  const available = Math.max(30, width)
  const prefixWidth = 4
  const showBar = available >= BATCH_BAR_MIN_WIDTH
  const barWidth = showBar
    ? Math.min(14, Math.max(8, Math.floor(available * 0.18)))
    : 0
  const statusWidth = 7
  const urlWidth = Math.max(
    12,
    available - prefixWidth - barWidth - statusWidth - (showBar ? 4 : 3),
  )

  for (const item of selected) {
    const color = BATCH_STATUS_COLORS[item.status] ?? 'muted'
    const glyph = theme.fg(color, statusGlyph(item.status))
    const status = theme.fg(color, item.status.padEnd(statusWidth, ' '))
    const url = theme.fg(
      item.status === 'error' ? 'warning' : 'muted',
      truncateMiddle(item.url, urlWidth),
    )
    let row = `${glyph} ${url} ${status}`
    if (showBar) {
      const progress = item.progress ?? statusToProgress(item.status)
      row += ` ${theme.fg('dim', buildProgressBar(progress, barWidth))}`
    }
    rows.push(row)

    if (expanded && item.status === 'error' && item.error) {
      rows.push(`  ${theme.fg('warning', '↳')} ${theme.fg('muted', item.error)}`)
    }
  }

  if (!expanded && details.items.length > maxRows) {
    rows.push(
      theme.fg(
        'dim',
        `… ${details.items.length - maxRows} more items (expand to view all)`,
      ),
    )
  }

  return rows
}

export type WebFetchDependencies = {
  // Custom handlers prepended to the default HTTP handler. The default list
  // is [GitHubHandler]; pass urlHandlers to replace it. The HTTP handler is
  // always appended last and cannot be overridden through this field.
  urlHandlers: UrlHandler[]
  githubFetcher: typeof fetchGitHubContent
  networkFetcher: typeof fetchWithOptionalCloudflareRetry
  jinaFetcher: typeof fetchViaJinaReader
  pdfTextExtractor: typeof extractPdfText
}

export function createWebFetchTool(deps: Partial<WebFetchDependencies> = {}) {
  const prependedHandlers: UrlHandler[] =
    deps.urlHandlers ?? [createGitHubHandler(deps.githubFetcher)]
  const httpHandler = createDefaultHttpHandler({
    networkFetcher: deps.networkFetcher,
    jinaFetcher: deps.jinaFetcher,
    pdfTextExtractor: deps.pdfTextExtractor,
  })
  const handlers: UrlHandler[] = [...prependedHandlers, httpHandler]

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

      const progress = createFetchProgress(onUpdate, { url: parsed.url })

      if (!parsed.refresh) {
        const cached = getCachedValue<{
          content: FetchToolContent
          details: FetchDetails
        }>(cacheKey)
        if (cached) {
          progress.emit('cache', 'hit')
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

      progress.emit('resolve', 'validating')

      const { controller, cleanup, rethrowIfAbort } = createAbortController(
        parsed.timeoutMs,
        signal,
      )

      // Dispatch: first matching handler whose validate passes runs.
      // Returning null from fetch falls through to the next matching handler.
      // The HTTP handler always matches and never returns null, so dispatch
      // is total. depth>1 catches re-dispatch loops; ctx.dispatch excludes
      // the calling handler so "is there a more specific handler?" can't
      // route back to the asker.
      const runHandler = async (
        url: URL,
        depth: number,
        strict: boolean,
        excludeHandler?: UrlHandler,
      ): Promise<FetchResult | null> => {
        if (depth > 1) throw new Error('UrlHandler dispatch loop')
        for (const handler of handlers) {
          if (handler === excludeHandler) continue
          if (!handler.match(url)) continue
          try {
            handler.validate(parsed)
          } catch (error) {
            if (strict) throw error
            // Soft validate: the matched handler refuses this request. Give
            // up — the caller (HTTP) will continue with what it already has.
            return null
          }
          const result = await handler.fetch({
            url,
            parsed,
            signal: controller.signal,
            progress,
            cacheKey,
            dispatch: (next) => runHandler(next, depth + 1, false, handler),
          })
          if (result !== null) return result
        }
        return null
      }

      try {
        const result = await runHandler(parsed.parsedUrl, 0, true)
        if (!result) {
          throw new Error(`No handler produced a result for ${parsed.url}`)
        }
        return result
      } catch (error) {
        try {
          rethrowIfAbort(error, 'Fetch request')
        } catch (normalized) {
          const mapped = mapUnknownError(normalized, parsed.url)
          throw new Error(buildWebFetchErrorMessage(mapped))
        }
        throw error
      } finally {
        cleanup()
      }
    },
    renderCall(args, theme) {
      const parts: string[] = []
      if (args.format) parts.push(`format=${args.format}`)
      if (args.selector) parts.push(`selector=${args.selector}`)
      if (args.maxChars) parts.push(`maxChars=${args.maxChars}`)
      if (args.timeout) parts.push(`timeout=${formatDuration(args.timeout)}`)
      if (args.headers) parts.push('headers')
      if (args.proxy) parts.push('proxy')
      if (args.refresh) parts.push('refresh')
      return renderToolCallHeader('web_fetch', compactUrl(args.url), 84, parts, theme)
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        const partial = (result.details || {}) as FetchDetails
        const sep = theme.fg('dim', ' · ')
        const parts: string[] = []
        if (partial.phase) parts.push(theme.fg('accent', partial.phase))
        if (partial.elapsedMs !== undefined) {
          parts.push(theme.fg('dim', formatDuration(partial.elapsedMs)))
        }
        // Fall back to the raw content text when the partial details aren't
        // populated yet (e.g. external fetcher emissions without a phase).
        if (!parts.length && Array.isArray(result.content)) {
          const latest = result.content.find((c) => c.type === 'text')?.text
          if (latest) parts.push(theme.fg('muted', latest))
        }
        const message = parts.length ? parts.join(sep) : theme.fg('muted', 'fetching')
        return new Text(`${theme.fg('dim', '⋯ ')}${message}`, 0, 0)
      }

      const details = (result.details || {}) as FetchDetails
      const sep = theme.fg('dim', ' · ')
      let text = theme.fg('success', '✓ ')

      if (details.isImage) {
        text += theme.fg('success', 'image')
        if (details.imageMimeType) {
          text += sep + theme.fg('muted', details.imageMimeType)
        }
        if (details.imageSize) {
          text += sep + theme.fg('dim', formatSize(details.imageSize))
        }
      } else if (details.isFile) {
        text += theme.fg('success', 'file')
        if (details.fileName) {
          text += sep + theme.fg('accent', truncateText(details.fileName, 80))
        }
        if (details.fileSize !== undefined) {
          text += sep + theme.fg('dim', formatSize(details.fileSize))
        }
      } else if (details.githubType) {
        text += theme.fg('success', 'github')
        if (details.title) {
          text += sep + theme.fg('accent', truncateText(details.title, 80))
        }
        const ghLabel = details.githubSource
          ? `${details.githubType} via ${details.githubSource}`
          : details.githubType
        text += sep + theme.fg('muted', ghLabel)
      } else {
        text += theme.fg('success', details.format || 'fetched')
        if (details.title) {
          text += sep + theme.fg('accent', truncateText(details.title, 80))
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
        // Identity: who/where
        const identity: string[] = []
        if (details.title) {
          identity.push(theme.fg('accent', details.title))
        }
        if (details.url) {
          identity.push(`  ${theme.fg('dim', compactUrl(details.url))}`)
        }
        if (details.byline) {
          identity.push(`  ${theme.fg('muted', `by ${details.byline}`)}`)
        }
        if (details.siteName) {
          identity.push(`  ${theme.fg('muted', details.siteName)}`)
        }
        if (identity.length) text += `\n${identity.join('\n')}`

        // Response shape: HTTP + type + size + extraction
        const responseLine: string[] = []
        if (details.status) {
          responseLine.push(
            `${details.status}${details.statusText ? ` ${details.statusText}` : ''}`,
          )
        }
        if (details.contentType) responseLine.push(details.contentType)
        if (details.contentLength !== undefined) {
          responseLine.push(formatSize(details.contentLength))
        }
        if (details.extractionMethod) responseLine.push(details.extractionMethod)
        if (responseLine.length) {
          text += `\n${theme.fg('dim', responseLine.join(' · '))}`
        }

        if (details.githubType) {
          const ghLabel = details.githubSource
            ? `${details.githubType} via ${details.githubSource}`
            : details.githubType
          text += `\n${theme.fg('muted', `github: ${ghLabel}`)}`
          if (details.githubLocalPath) {
            text += ` ${theme.fg('dim', `(${details.githubLocalPath})`)}`
          }
        }

        if (details.responseId) {
          text += `\n${theme.fg('muted', `stored: ${details.responseId}`)} `
          text += theme.fg('dim', '· retrieve with get_web_content')
        }
        if (details.cached && details.cacheAgeMs !== undefined) {
          text += `\n${theme.fg('dim', `cached ${formatDuration(details.cacheAgeMs)} ago`)}`
        }

        // Diagnostics: only when non-trivial
        const diagnostics: string[] = []
        if (details.jinaFallbackUsed) diagnostics.push('Jina Reader fallback')
        if (details.cloudflareBypassed) diagnostics.push('Cloudflare retry')
        if (details.pdfExtracted) diagnostics.push('PDF text extracted')
        if (diagnostics.length) {
          text += `\n${theme.fg('muted', diagnostics.join(' · '))}`
        }

        // File payload
        if (details.filePath) {
          text += `\n${theme.fg('muted', `file: ${details.filePath}`)}`
          if (details.fileSize !== undefined) {
            text += ` ${theme.fg('dim', `(${formatSize(details.fileSize)})`)}`
          }
        }
        if (details.tempFile) {
          text += `\n${theme.fg('muted', `full output: ${details.tempFile}`)}`
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
        ? renderBatchRows(details, width, true, theme)
        : renderBatchRows(details, width, false, theme).slice(0, 4)

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
