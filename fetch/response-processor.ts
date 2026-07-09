import { formatSize } from '@mariozechner/pi-coding-agent'
import { rmSync } from 'node:fs'
import { classifyFetchResponse } from './classify.ts'
import { extensionForFormat } from './content.ts'
import { createWebFetchError } from './errors.ts'
import { extractFetchContent } from './extract.ts'
import {
  decodeContentEncoding,
  extractPdfText,
  fetchViaJinaReader,
  MAX_HTML_BYTES,
  shouldApplyHtmlGuard,
  shouldUseJinaFallbackForStatus,
} from './network.ts'
import {
  assembleTextFetchResult,
  buildFileFetchResult,
  buildImageFetchResult,
  buildTextFetchResult,
} from './result.ts'
import type {
  FetchOutputFormat,
  FetchResponseClassification,
  GuardedFetchResponse,
  ParsedFetchParams,
} from './types.ts'
import type { FetchProgress } from './progress.ts'
import type { FetchResult } from './url-handler.ts'

const LARGE_RESPONSE_WARNING_BYTES = 1 * 1024 * 1024

type FetchResponseProcessorContext = {
  response: GuardedFetchResponse
  cloudflareBypassed: boolean
  url: URL
  parsed: ParsedFetchParams
  signal: AbortSignal
  progress: FetchProgress
  cacheKey: string
  dispatch(finalUrl: URL): Promise<FetchResult | null>
  jinaFetcher: typeof fetchViaJinaReader
  pdfTextExtractor: typeof extractPdfText
  releaseDownloadedFile(): void
}

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

  if (isPdf && selector) throw new Error('Selector is not supported for PDF output')
  if (isPdf && !['markdown', 'text'].includes(format)) {
    throw new Error(
      `PDF content only supports markdown or text output, received: ${format}`,
    )
  }
  if (selector && !isHtml) {
    if (isJson || format === 'json') throw new Error('Selector is not supported for json output')
    throw new Error(
      `Selector is only supported for HTML responses, received: ${mimeType || 'unknown'}`,
    )
  }
}

export function cleanupDownloadedFile(filePath: string | undefined): void {
  if (!filePath) return
  rmSync(filePath, { force: true })
}

async function handleNonOkResponse(ctx: FetchResponseProcessorContext) {
  const { response, url, parsed, signal, progress, cacheKey, jinaFetcher } = ctx
  const nonOkFinalUrl = response.url || url.toString()

  if (
    !parsed.selector &&
    canUseTextLikeFetchFormat(parsed.requestedFormat) &&
    shouldUseJinaFallbackForStatus(response.status)
  ) {
    const jina = await jinaFetcher(
      new URL(nonOkFinalUrl),
      signal,
      progress.onUpdate,
      undefined,
      { proxy: parsed.proxy },
    )
    const jinaFormat = parsed.requestedFormat ?? 'markdown'
    cleanupDownloadedFile(response.downloadedFilePath)
    ctx.releaseDownloadedFile()
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

async function redispatchRedirect(
  ctx: FetchResponseProcessorContext,
  classification: FetchResponseClassification,
) {
  if (classification.finalUrl === ctx.url.toString()) return undefined

  const redirected = await ctx.dispatch(new URL(classification.finalUrl))
  if (!redirected) return undefined

  cleanupDownloadedFile(ctx.response.downloadedFilePath)
  ctx.releaseDownloadedFile()
  return redirected
}

function applyResponseGuards(
  ctx: FetchResponseProcessorContext,
  classification: FetchResponseClassification,
) {
  validateResponseCompatibility({
    selector: ctx.parsed.selector,
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
    ctx.progress.onUpdate?.({
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
        url: ctx.parsed.url,
        finalUrl: classification.finalUrl,
      },
    )
  }
}

function buildBinaryResponse(
  ctx: FetchResponseProcessorContext,
  classification: FetchResponseClassification,
) {
  const { response, cloudflareBypassed, progress } = ctx
  const streamedSize = response.downloadedFileSize ?? classification.contentLength ?? 0

  progress.emit('download', `${formatSize(streamedSize)} streamed to file`)
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

  ctx.releaseDownloadedFile()
  return fileResult
}

function decodeBufferedResponse(
  ctx: FetchResponseProcessorContext,
  classification: FetchResponseClassification,
) {
  const bodyBuffer = decodeContentEncoding(
    ctx.response.bodyBuffer,
    ctx.response.headers.get('content-encoding'),
    { url: classification.finalUrl, mimeType: classification.mimeType },
  )
  const bodySize = bodyBuffer.byteLength

  ctx.progress.emit('download', formatSize(bodySize))

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
        url: ctx.parsed.url,
        finalUrl: classification.finalUrl,
      },
    )
  }

  return { bodyBuffer, bodySize }
}

function buildImageResponse(
  ctx: FetchResponseProcessorContext,
  classification: FetchResponseClassification,
  bodyBuffer: Buffer,
  bodySize: number,
) {
  if (!classification.isImage) {
    throw createWebFetchError(
      `Requested image output but received non-image content type: ${classification.mimeType || 'unknown'}`,
      {
        code: 'invalid_request',
        phase: 'response',
        retryable: false,
        url: ctx.parsed.url,
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
      cloudflareBypassed: ctx.cloudflareBypassed,
      cached: false,
      cacheAgeMs: 0,
    },
  )
}

async function buildTextResponse(
  ctx: FetchResponseProcessorContext,
  classification: FetchResponseClassification,
  bodyBuffer: Buffer,
  bodySize: number,
) {
  const extracted = await extractFetchContent({
    bodyBuffer,
    classification,
    selector: ctx.parsed.selector,
    signal: ctx.signal,
    progress: ctx.progress,
    jinaFetcher: ctx.jinaFetcher,
    pdfTextExtractor: ctx.pdfTextExtractor,
    requestOptions: { proxy: ctx.parsed.proxy },
  })

  return assembleTextFetchResult({
    classification,
    extracted,
    bodySize,
    cloudflareBypassed: ctx.cloudflareBypassed,
    parsed: ctx.parsed,
    cacheKey: ctx.cacheKey,
  })
}

export async function processFetchResponse(
  ctx: FetchResponseProcessorContext,
): Promise<FetchResult> {
  const { response, url, parsed, progress } = ctx

  progress.emit(
    'response',
    `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
  )

  if (!response.ok) return handleNonOkResponse(ctx)

  const classification = classifyFetchResponse(response, url, parsed.requestedFormat)
  const redirected = await redispatchRedirect(ctx, classification)
  if (redirected) return redirected

  applyResponseGuards(ctx, classification)
  if (classification.isAttachment || classification.isBinary) {
    return buildBinaryResponse(ctx, classification)
  }

  const { bodyBuffer, bodySize } = decodeBufferedResponse(ctx, classification)
  if (classification.isImage || classification.format === 'image') {
    return buildImageResponse(ctx, classification, bodyBuffer, bodySize)
  }

  return buildTextResponse(ctx, classification, bodyBuffer, bodySize)
}
