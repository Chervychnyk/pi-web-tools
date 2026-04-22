import { isPdfMimeType, isPdfUrl, parseContentLength } from './network.ts'
import type {
  FetchOutputFormat,
  FetchResponseClassification,
  GuardedFetchResponse,
} from './types.ts'

const DEFAULT_IMAGE_FORMAT: FetchOutputFormat = 'image'

export function classifyFetchResponse(
  response: GuardedFetchResponse,
  parsedUrl: URL,
  requestedFormat?: FetchOutputFormat,
): FetchResponseClassification {
  const finalUrl = response.url || parsedUrl.toString()
  const status = response.status
  const statusText = response.statusText
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
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

  return {
    finalUrl,
    status,
    statusText,
    contentType,
    contentLength,
    mimeType,
    isHtml,
    isJson,
    isPdf,
    isText,
    isImage,
    format,
  }
}
