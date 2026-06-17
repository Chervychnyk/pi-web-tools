import { formatSize } from '@mariozechner/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendStoredResponseNote } from '../shared.ts'
import { setCachedValue } from '../utils/cache.ts'
import { truncateForModel } from '../utils/truncate.ts'
import { tryStoreWebResponse } from '../storage.ts'
import type { ArticleData, FetchDetails, FetchOutputFormat } from './types.ts'

const FETCH_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHED_FETCH_TEXT_CHARS = 100_000

function sanitizeFileName(input: string) {
  return input
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._ -]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/[. -]+$/g, '')
}

function resolveFilenameFromContentDisposition(contentDisposition: string) {
  const filenameStarMatch = contentDisposition.match(/filename\*=([^;]+)/i)
  const filenameMatch = contentDisposition.match(
    /filename=(?:"([^"]+)"|([^;]+))/i,
  )

  const rawFilename = filenameStarMatch?.[1]
    ? (() => {
        const value = filenameStarMatch[1].trim()
        const encoded = value.includes("''")
          ? value.split("''").slice(1).join("''")
          : value
        try {
          return decodeURIComponent(encoded.replace(/^"|"$/g, ''))
        } catch {
          return encoded.replace(/^"|"$/g, '')
        }
      })()
    : (filenameMatch?.[1] ?? filenameMatch?.[2] ?? '').trim()

  if (!rawFilename) return undefined
  const parsed = path.parse(rawFilename.replace(/[\\/]+/g, '-'))
  const base = sanitizeFileName(parsed.name || rawFilename)
  const ext = (parsed.ext || '').replace(/[^A-Za-z0-9.]/g, '').toLowerCase()
  return `${base || 'download'}${ext || ''}`
}

function resolveFilenameFromUrl(url: string) {
  try {
    const parsedUrl = new URL(url)
    const segment = parsedUrl.pathname.split('/').filter(Boolean).at(-1)
    if (!segment) return undefined

    const decoded = decodeURIComponent(segment)
    const parsed = path.parse(decoded)
    const base = sanitizeFileName(parsed.name || decoded)
    const ext = (parsed.ext || '').replace(/[^A-Za-z0-9.]/g, '').toLowerCase()
    return `${base || 'download'}${ext || ''}`
  } catch {
    return undefined
  }
}

function ensureExtension(fileName: string, mimeType: string) {
  if (path.extname(fileName)) return fileName
  if (!mimeType) return `${fileName}.bin`

  if (mimeType === 'application/zip') return `${fileName}.zip`
  if (mimeType === 'application/pdf') return `${fileName}.pdf`
  if (mimeType === 'application/octet-stream') return `${fileName}.bin`

  const subtype = mimeType.split('/')[1]
  if (!subtype) return `${fileName}.bin`
  const safeSubtype = sanitizeFileName(subtype).replace(/[^A-Za-z0-9]+/g, '')
  return `${fileName}.${safeSubtype || 'bin'}`
}

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

function resolveFetchFallbackSource(details: FetchDetails) {
  if (details.jinaFallbackUsed) return 'jina'
  if (details.githubSource) return `github-${details.githubSource}`
  if (details.pdfExtracted) return 'pdf'
  return undefined
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
  const selectedSelector = detailOverrides.selectedSelector
    ? { selectedSelector: detailOverrides.selectedSelector }
    : {}
  const stored = tryStoreWebResponse({
    kind: 'fetch',
    requestUrl,
    finalUrl: detailOverrides.url,
    format: detailOverrides.format,
    title: detailOverrides.title,
    contentType: detailOverrides.contentType,
    messageText: text,
    sourceTool: 'web_fetch',
    fallbackUsed: resolveFetchFallbackSource(detailOverrides),
    ...selectedSelector,
  })
  const output = truncateForModel(text, extension, maxChars)
  const result = {
    content: [
      {
        type: 'text' as const,
        text: appendStoredResponseNote(output.text, stored?.responseId, 'get_web_content', {
          source: detailOverrides.url,
        }),
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

export function buildFileFetchResult(options: {
  bodyBuffer?: Buffer
  existingFilePath?: string
  existingFileSize?: number
  finalUrl: string
  mimeType: string
  contentDisposition?: string
  details: Omit<
    FetchDetails,
    'truncated' | 'tempFile' | 'responseId' | 'charLimited' | 'maxChars' | 'originalChars'
  >
}) {
  const {
    bodyBuffer,
    existingFilePath,
    existingFileSize,
    finalUrl,
    mimeType,
    contentDisposition,
    details,
  } = options

  const candidateName =
    resolveFilenameFromContentDisposition(contentDisposition || '') ||
    resolveFilenameFromUrl(finalUrl) ||
    `download-${randomUUID().slice(0, 8)}`
  const fileName = ensureExtension(candidateName, mimeType)

  let filePath = existingFilePath
  let fileSize = existingFileSize

  if (!filePath) {
    if (!bodyBuffer) {
      throw new Error('File fetch result requires bodyBuffer or existingFilePath')
    }

    const tempRoot = path.join(tmpdir(), 'pi-web-tools-downloads')
    mkdirSync(tempRoot, { recursive: true })
    const uniqueName = `${path.parse(fileName).name}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}${path.extname(fileName) || ''}`
    filePath = path.join(tempRoot, uniqueName)
    writeFileSync(filePath, bodyBuffer, { mode: 0o600 })
    fileSize = bodyBuffer.byteLength
  }

  if (!filePath) {
    throw new Error('Failed to resolve download file path')
  }

  if (fileSize === undefined) {
    fileSize = statSync(filePath).size
  }

  const summary = [
    `File downloaded: ${finalUrl}`,
    `- File path: ${filePath}`,
    `- File name: ${fileName}`,
    `- Mime type: ${mimeType || 'unknown'}`,
    `- File size: ${formatSize(fileSize)}`,
  ].join('\n')

  return {
    content: [{ type: 'text' as const, text: summary }],
    details: {
      ...details,
      responseId: undefined,
      truncated: false,
      tempFile: undefined,
      charLimited: false,
      maxChars: undefined,
      originalChars: 0,
      isFile: true,
      filePath,
      fileName,
      fileSize,
    } satisfies FetchDetails,
  }
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
