import { formatSize } from '@mariozechner/pi-coding-agent'
import { rmSync } from 'node:fs'
import { classifyFetchResponse } from '../classify.ts'
import { extensionForFormat } from '../content.ts'
import { createWebFetchError } from '../errors.ts'
import { extractFetchContent } from '../extract.ts'
import {
  decodeContentEncoding,
  extractPdfText,
  fetchViaJinaReader,
  fetchWithOptionalCloudflareRetry,
  MAX_HTML_BYTES,
  shouldApplyHtmlGuard,
  shouldUseJinaFallbackForStatus,
} from '../network.ts'
import { emitFetchProgress } from '../progress.ts'
import {
  assembleTextFetchResult,
  buildFileFetchResult,
  buildImageFetchResult,
  buildTextFetchResult,
} from '../result.ts'
import type { FetchOutputFormat } from '../types.ts'
import type { FetchResult, UrlHandler } from '../url-handler.ts'

const LARGE_RESPONSE_WARNING_BYTES = 1 * 1024 * 1024

function canUseTextLikeFetchFormat(format: FetchOutputFormat | undefined) {
  return format === undefined || format === 'markdown' || format === 'text'
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

function cleanupDownloadedFile(filePath: string | undefined): void {
  if (!filePath) return
  rmSync(filePath, { force: true })
}

export type DefaultHttpHandlerDependencies = {
  networkFetcher?: typeof fetchWithOptionalCloudflareRetry
  jinaFetcher?: typeof fetchViaJinaReader
  pdfTextExtractor?: typeof extractPdfText
}

export function createDefaultHttpHandler(
  deps: DefaultHttpHandlerDependencies = {},
): UrlHandler {
  const networkFetcher = deps.networkFetcher || fetchWithOptionalCloudflareRetry
  const jinaFetcher = deps.jinaFetcher || fetchViaJinaReader
  const pdfTextExtractor = deps.pdfTextExtractor || extractPdfText

  return {
    name: 'http',
    match() {
      return true
    },
    validate() {
      // Response-shape validation happens after classification (validateResponseCompatibility).
      // Selector/format combinations that are statically incompatible are deferred to runtime
      // because we don't know the response MIME type yet.
    },
    async fetch(ctx): Promise<FetchResult> {
      const { url, parsed, signal, onUpdate, cacheKey } = ctx
      let downloadedFilePathForCleanup: string | undefined

      try {
        emitFetchProgress(onUpdate, 'network', `GET ${url.hostname}`)

        const { response, cloudflareBypassed } = await networkFetcher(
          url,
          signal,
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
          `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
        )

        if (!response.ok) {
          const nonOkFinalUrl = response.url || url.toString()

          if (
            !parsed.selector &&
            canUseTextLikeFetchFormat(parsed.requestedFormat) &&
            shouldUseJinaFallbackForStatus(response.status)
          ) {
            const jina = await jinaFetcher(
              new URL(nonOkFinalUrl),
              signal,
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
          url,
          parsed.requestedFormat,
        )

        // Post-redirect re-dispatch (A1). If the final URL routes to a different
        // handler (e.g. GitHub), drop the body we just fetched and hand off.
        if (classification.finalUrl !== url.toString()) {
          const redirected = await ctx.dispatch(new URL(classification.finalUrl))
          if (redirected) {
            cleanupDownloadedFile(downloadedFilePathForCleanup)
            downloadedFilePathForCleanup = undefined
            return redirected
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
            `${formatSize(streamedSize)} streamed to file`,
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

        emitFetchProgress(onUpdate, 'download', formatSize(bodySize))

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
          signal,
          onUpdate,
          jinaFetcher,
          pdfTextExtractor,
          requestOptions: { proxy: parsed.proxy },
        })

        return assembleTextFetchResult({
          classification,
          extracted,
          bodySize,
          cloudflareBypassed,
          parsed,
          cacheKey,
        })
      } catch (error) {
        cleanupDownloadedFile(downloadedFilePathForCleanup)
        downloadedFilePathForCleanup = undefined
        throw error
      } finally {
        cleanupDownloadedFile(downloadedFilePathForCleanup)
      }
    },
  }
}
