import { formatSize } from '@mariozechner/pi-coding-agent'
import { StringEnum } from '@mariozechner/pi-ai'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'
import { fetchGitHubContent, parseGitHubUrl } from '../github.ts'
import {
  DEFAULT_TIMEOUT,
  appendStoredResponseNote,
  buildCacheKey,
  createAbortController,
  getCachedValue,
  normalizeWhitespace,
  renderBadges,
  renderToolCallHeader,
  setCachedValue,
  truncateForModel,
  truncateText,
} from '../shared.ts'
import { tryStoreWebResponse } from '../storage.ts'
import {
  cleanupMarkdown,
  getTurndownService,
  extensionForFormat,
  extractBestHtmlContent,
  selectFragment,
} from './content.ts'
import {
  decodeBodyAsText,
  extractPdfText,
  fetchViaJinaReader,
  fetchWithOptionalCloudflareRetry,
  isPdfMimeType,
  isPdfUrl,
  looksLikeBlockedOrJunkContent,
  MAX_HTML_BYTES,
  parseContentLength,
  shouldApplyHtmlGuard,
  shouldUseJinaFallbackForStatus,
} from './network.ts'
import type {
  FetchDetails,
  FetchProgressHandler,
  FetchToolContent,
} from './types.ts'

const DEFAULT_IMAGE_FORMAT = 'image'
const FETCH_CACHE_TTL_MS = 10 * 60 * 1000
const LARGE_RESPONSE_WARNING_BYTES = 1 * 1024 * 1024

function emitFetchProgress(
  onUpdate: FetchProgressHandler | undefined,
  stage: string,
  message: string,
) {
  onUpdate?.({
    content: [{ type: 'text', text: `[${stage}] ${message}` }],
  })
}

export type WebFetchDependencies = {
  githubFetcher: typeof fetchGitHubContent
  networkFetcher: typeof fetchWithOptionalCloudflareRetry
  jinaFetcher: typeof fetchViaJinaReader
  pdfTextExtractor: typeof extractPdfText
}

function buildFetchResult(
  text: string,
  extension: string,
  maxChars: number | undefined,
  cacheKey: string,
  requestUrl: string,
  detailOverrides: Omit<FetchDetails, 'truncated' | 'tempFile' | 'charLimited' | 'maxChars' | 'originalChars'>,
) {
  const stored = tryStoreWebResponse({
    kind: 'fetch',
    requestUrl,
    finalUrl: detailOverrides.url,
    format: detailOverrides.format,
    title: detailOverrides.title,
    contentType: detailOverrides.contentType,
    messageText: text,
    ...(detailOverrides.selectedSelector
      ? { selectedSelector: detailOverrides.selectedSelector }
      : {}),
  })
  const output = truncateForModel(text, extension, maxChars)
  const result = {
    content: [
      {
        type: 'text' as const,
        text: appendStoredResponseNote(output.text, stored?.responseId),
      },
    ],
    details: {
      ...detailOverrides,
      responseId: stored?.responseId,
      truncated: output.truncated,
      tempFile: output.tempFile,
      charLimited: output.charLimited,
      maxChars: output.maxChars,
      originalChars: output.originalChars,
    } satisfies FetchDetails,
  }
  setCachedValue(cacheKey, result, FETCH_CACHE_TTL_MS)
  return result
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

      const cacheKey = buildCacheKey({
        tool: 'web_fetch',
        url,
        format: requestedFormat ?? '(auto)',
        selector,
        maxChars,
      })

      if (!refresh) {
        const cached = getCachedValue<{
          content: FetchToolContent
          details: FetchDetails
        }>(cacheKey)
        if (cached) {
          emitFetchProgress(
            onUpdate,
            'cache',
            `Using cached fetch result for ${url}`,
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
        `Validating and fetching ${url}...`,
      )

      const { controller, cleanup, rethrowIfAbort } = createAbortController(
        timeoutMs,
        signal,
      )

      try {
        const githubUrl = parseGitHubUrl(url)
        const githubRequestedFormat = requestedFormat ?? 'markdown'

        const makeGitHubResult = (
          githubContent: NonNullable<Awaited<ReturnType<typeof githubFetcher>>>,
          format: 'markdown' | 'text',
        ) =>
          buildFetchResult(githubContent.text, '.md', maxChars, cacheKey, url, {
            url: githubContent.finalUrl,
            format,
            githubType: githubContent.githubType,
            githubSource: githubContent.githubSource,
            githubLocalPath: githubContent.githubLocalPath,
            title: githubContent.title,
            contentType: githubContent.contentType,
            cached: false,
            cacheAgeMs: 0,
          })

        if (githubUrl && selector) {
          throw new Error(
            'Selector is not supported for GitHub repository URLs',
          )
        }
        if (
          githubUrl &&
          !['markdown', 'text'].includes(githubRequestedFormat)
        ) {
          throw new Error(
            `GitHub repository URLs only support markdown or text output, received: ${githubRequestedFormat}`,
          )
        }

        const githubContent = await githubFetcher(
          url,
          controller.signal,
          onUpdate,
          refresh,
        )
        if (githubContent) {
          return makeGitHubResult(githubContent, githubRequestedFormat)
        }

        emitFetchProgress(
          onUpdate,
          'network',
          `Requesting ${parsedUrl.hostname}...`,
        )

        const { response, cloudflareBypassed } = await networkFetcher(
          parsedUrl,
          controller.signal,
          onUpdate,
        )

        emitFetchProgress(
          onUpdate,
          'response',
          `Received ${response.status} ${response.statusText || ''}`.trim(),
        )

        if (!response.ok) {
          const nonOkFinalUrl = response.url || parsedUrl.toString()

          if (
            !selector &&
            (requestedFormat === undefined ||
              requestedFormat === 'markdown' ||
              requestedFormat === 'text') &&
            shouldUseJinaFallbackForStatus(response.status)
          ) {
            const jina = await jinaFetcher(
              new URL(nonOkFinalUrl),
              controller.signal,
              onUpdate,
            )
            const jinaFormat = requestedFormat ?? 'markdown'
            return buildFetchResult(
              jina.content,
              extensionForFormat(jinaFormat),
              maxChars,
              cacheKey,
              url,
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

          throw new Error(
            `Fetch failed: ${response.status} ${response.statusText}`,
          )
        }

        const finalUrl = response.url || parsedUrl.toString()
        const status = response.status
        const statusText = response.statusText
        const contentType = (
          response.headers.get('content-type') || ''
        ).toLowerCase()
        const contentLength = parseContentLength(
          response.headers.get('content-length'),
        )
        const mimeType = contentType.split(';')[0]?.trim() || ''
        const isHtml =
          mimeType === 'text/html' || mimeType === 'application/xhtml+xml'
        const isJson = mimeType.includes('json')
        const isPdf = isPdfMimeType(mimeType) || isPdfUrl(finalUrl)
        const isText = isHtml || mimeType.startsWith('text/') || !mimeType
        const isImage =
          mimeType.startsWith('image/') && mimeType !== 'image/svg+xml'
        const format =
          requestedFormat ?? (isImage ? DEFAULT_IMAGE_FORMAT : 'markdown')

        const redirectedGithubUrl = !githubUrl ? parseGitHubUrl(finalUrl) : null
        const canUseGithubAfterRedirect =
          !selector &&
          (requestedFormat === undefined ||
            requestedFormat === 'markdown' ||
            requestedFormat === 'text')

        if (redirectedGithubUrl && canUseGithubAfterRedirect) {
          emitFetchProgress(
            onUpdate,
            'github',
            `Redirected to GitHub URL, switching to repository extraction for ${finalUrl}`,
          )

          const redirectedGithubContent = await githubFetcher(
            finalUrl,
            controller.signal,
            onUpdate,
            refresh,
          )

          if (redirectedGithubContent) {
            return makeGitHubResult(
              redirectedGithubContent,
              (requestedFormat ?? 'markdown') as 'markdown' | 'text',
            )
          }
        }

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

        if (
          contentLength !== undefined &&
          contentLength > LARGE_RESPONSE_WARNING_BYTES
        ) {
          onUpdate?.({
            content: [
              {
                type: 'text',
                text: `Large response detected (${formatSize(contentLength)}).`,
              },
            ],
          })
        }

        if (shouldApplyHtmlGuard(mimeType, format, contentLength)) {
          throw new Error(
            `HTML response too large to process safely: ${formatSize(contentLength!)} (max ${formatSize(MAX_HTML_BYTES)})`,
          )
        }

        const bodyBuffer = response.bodyBuffer
        const bodySize = bodyBuffer.byteLength

        emitFetchProgress(
          onUpdate,
          'download',
          `Downloaded ${formatSize(bodySize)} from ${new URL(finalUrl).hostname}`,
        )

        if (
          isHtml &&
          ['markdown', 'text', 'html'].includes(format) &&
          bodySize > MAX_HTML_BYTES
        ) {
          throw new Error(
            `HTML response too large to process safely: ${formatSize(bodySize)} (max ${formatSize(MAX_HTML_BYTES)})`,
          )
        }

        if (isImage || format === 'image') {
          if (!isImage) {
            throw new Error(
              `Requested image output but received non-image content type: ${mimeType || 'unknown'}`,
            )
          }

          const summary = `Image fetched successfully: ${finalUrl} (${mimeType}, ${formatSize(bodySize)})`
          const result = {
            content: [
              { type: 'text', text: summary },
              { type: 'image', data: bodyBuffer.toString('base64'), mimeType },
            ],
            details: {
              responseId: undefined,
              url: finalUrl,
              format,
              title: null,
              truncated: false,
              tempFile: undefined,
              isImage: true,
              imageMimeType: mimeType,
              imageSize: bodySize,
              status,
              statusText,
              contentType,
              contentLength,
              cloudflareBypassed,
              cached: false,
              cacheAgeMs: 0,
            } satisfies FetchDetails,
          }
          setCachedValue(cacheKey, result, FETCH_CACHE_TTL_MS)
          return result
        }

        const raw = decodeBodyAsText(bodyBuffer, contentType)
        let article: ReturnType<typeof extractBestHtmlContent> | undefined
        let content = raw
        let jinaFallbackUsed = false
        let pdfExtracted = false

        emitFetchProgress(onUpdate, 'process', `Processing ${format} output...`)

        if (format === 'json') {
          try {
            content = JSON.stringify(JSON.parse(raw), null, 2)
          } catch {
            throw new Error(`Failed to parse response as JSON: ${finalUrl}`)
          }
        } else if (format === 'html') {
          if (selector) {
            const selection = selectFragment(raw, selector)
            content = selection.html
            article = {
              title: null,
              byline: null,
              excerpt: null,
              siteName: null,
              contentHtml: selection.html,
              textContent: selection.text,
              extractionMethod: 'selector',
              selectedSelector: selector,
            }
          }
        } else if (format === 'text' || format === 'markdown') {
          if (isPdf) {
            emitFetchProgress(
              onUpdate,
              'extract',
              'Extracting text from PDF...',
            )
            content = normalizeWhitespace(
              await pdfTextExtractor(bodyBuffer, controller.signal),
            )
            pdfExtracted = true
          } else if (isHtml) {
            emitFetchProgress(
              onUpdate,
              'extract',
              selector
                ? `Selecting ${selector}...`
                : format === 'markdown'
                  ? 'Extracting readable article...'
                  : 'Extracting main text...',
            )
            article = extractBestHtmlContent(raw, finalUrl, selector)

            if (format === 'markdown') {
              emitFetchProgress(
                onUpdate,
                'convert',
                'Converting HTML to markdown...',
              )
              content = cleanupMarkdown(
                getTurndownService().turndown(article.contentHtml),
              )
            } else {
              content = article.textContent
            }

            if (!selector && looksLikeBlockedOrJunkContent(content)) {
              const jina = await jinaFetcher(
                new URL(finalUrl),
                controller.signal,
                onUpdate,
              )
              content = jina.content
              article = undefined
              jinaFallbackUsed = true
            }
          } else if (isText || isJson) {
            content = format === 'text' ? normalizeWhitespace(raw) : raw.trim()
          } else {
            throw new Error(
              `Unsupported content type for ${format} output: ${contentType || 'unknown'}`,
            )
          }
        } else {
          throw new Error(`Unsupported format: ${format}`)
        }

        const messageParts: string[] = []
        if (article?.title && format !== 'json' && format !== 'html') {
          messageParts.push(`# ${article.title}`)
        }
        if (article?.byline && format !== 'json' && format !== 'html') {
          messageParts.push(`By: ${article.byline}`)
        }
        if (article?.siteName && format !== 'json' && format !== 'html') {
          messageParts.push(`Site: ${article.siteName}`)
        }
        if (article?.excerpt && format === 'markdown') {
          messageParts.push(`> ${article.excerpt}`)
        }
        if (messageParts.length > 0) {
          messageParts.push('')
        }
        const fullText = [...messageParts, content].join('\n')
        return buildFetchResult(
          fullText,
          extensionForFormat(format),
          maxChars,
          cacheKey,
          url,
          {
            url: finalUrl,
            format,
            title: article?.title,
            byline: article?.byline,
            siteName: article?.siteName,
            excerpt: article?.excerpt,
            selectedSelector: article?.selectedSelector,
            extractionMethod: article?.extractionMethod,
            status,
            statusText,
            contentType,
            contentLength: contentLength ?? bodySize,
            cloudflareBypassed,
            jinaFallbackUsed,
            pdfExtracted,
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
