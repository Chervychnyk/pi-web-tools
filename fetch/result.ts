import { formatSize } from '@mariozechner/pi-coding-agent'
import { appendStoredResponseNote, setCachedValue, truncateForModel } from '../shared.ts'
import { tryStoreWebResponse } from '../storage.ts'
import type { ArticleData, FetchDetails, FetchOutputFormat } from './types.ts'

const FETCH_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHED_FETCH_TEXT_CHARS = 100_000

export function composeFetchTextOutput(
  format: FetchOutputFormat,
  content: string,
  article?: ArticleData,
) {
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
  return [...messageParts, content].join('\n')
}

export function buildTextFetchResult(
  text: string,
  extension: string,
  maxChars: number | undefined,
  cacheKey: string,
  requestUrl: string,
  detailOverrides: Omit<
    FetchDetails,
    'truncated' | 'tempFile' | 'charLimited' | 'maxChars' | 'originalChars'
  >,
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

  if (text.length <= MAX_CACHED_FETCH_TEXT_CHARS) {
    setCachedValue(cacheKey, result, FETCH_CACHE_TTL_MS)
  }

  return result
}

export function buildImageFetchResult(
  bodyBuffer: Buffer,
  mimeType: string,
  url: string,
  format: FetchOutputFormat,
  bodySize: number,
  details: Omit<FetchDetails, 'truncated' | 'tempFile' | 'responseId'>,
) {
  const summary = `Image fetched successfully: ${url} (${mimeType}, ${formatSize(bodySize)})`

  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'image' as const, data: bodyBuffer.toString('base64'), mimeType },
    ],
    details: {
      ...details,
      responseId: undefined,
      truncated: false,
      tempFile: undefined,
    } satisfies FetchDetails,
  }
}
