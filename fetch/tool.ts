import { formatSize } from '@mariozechner/pi-coding-agent'
import { StringEnum } from '@mariozechner/pi-ai'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'
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
import { buildFetchCacheKey, parseFetchParams } from './params.ts'
import { emitFetchProgress } from './progress.ts'
import {
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
  FetchDetails,
  FetchOutputFormat,
  FetchToolContent,
} from './types.ts'

const LARGE_RESPONSE_WARNING_BYTES = 1 * 1024 * 1024

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

  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch content from a URL and convert it to markdown, text, html, json, or image. Supports selector-based extraction.',
    promptSnippet:
      'Fetch a web page, image, or API endpoint and extract readable markdown, text, html, json, or image output',
    promptGuidelines: [
      'Use markdown for readable article content, text for plain extraction, html for raw markup, json for APIs, and image for direct image responses.',
      'GitHub repository URLs are handled specially and return local-clone-backed repository content instead of scraped HTML.',
      'Use the selector parameter when the user wants a specific part of the page, such as article or #content.',
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
        )

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
            )
            const jinaFormat = parsed.requestedFormat ?? 'markdown'
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

          throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
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
          throw new Error(
            `HTML response too large to process safely: ${formatSize(classification.contentLength!)} (max ${formatSize(MAX_HTML_BYTES)})`,
          )
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
          throw new Error(
            `HTML response too large to process safely: ${formatSize(bodySize)} (max ${formatSize(MAX_HTML_BYTES)})`,
          )
        }

        if (classification.isImage || classification.format === 'image') {
          if (!classification.isImage) {
            throw new Error(
              `Requested image output but received non-image content type: ${classification.mimeType || 'unknown'}`,
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
        rethrowIfAbort(error, 'Fetch request')
      } finally {
        cleanup()
      }
    },
    renderCall(args, theme) {
      const parts: string[] = []
      if (args.format) parts.push(`format=${args.format}`)
      if (args.selector) parts.push(`selector=${args.selector}`)
      if (args.maxChars) parts.push(`maxChars=${args.maxChars}`)
      if (args.timeout) parts.push(`timeout=${args.timeout}ms`)
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
        if (details.tempFile) {
          text += `\n${theme.fg('muted', `Full output: ${details.tempFile}`)}`
        }
      }

      return new Text(text, 0, 0)
    },
  }
}
