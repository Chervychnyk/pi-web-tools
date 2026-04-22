export type ArticleData = {
  title: string | null
  byline: string | null
  excerpt: string | null
  siteName: string | null
  contentHtml: string
  textContent: string
  extractionMethod:
    | 'readability'
    | 'selector'
    | 'fallback-selector'
    | 'document'
  selectedSelector?: string
}

export type FetchOutputFormat = 'markdown' | 'text' | 'html' | 'json' | 'image'

export type ParsedFetchParams = {
  url: string
  parsedUrl: URL
  requestedFormat?: FetchOutputFormat
  selector?: string
  timeoutMs: number
  maxChars?: number
  refresh: boolean
}

export type FetchResponseClassification = {
  finalUrl: string
  status: number
  statusText: string
  contentType: string
  contentLength?: number
  mimeType: string
  isHtml: boolean
  isJson: boolean
  isPdf: boolean
  isText: boolean
  isImage: boolean
  format: FetchOutputFormat
}

export type ExtractedFetchContent = {
  content: string
  article?: ArticleData
  jinaFallbackUsed: boolean
  pdfExtracted: boolean
}

export type FetchDetails = {
  responseId?: string
  url: string
  format: string
  githubType?: 'root' | 'blob' | 'tree'
  githubSource?: 'clone' | 'api'
  githubLocalPath?: string
  title?: string | null
  jinaFallbackUsed?: boolean
  pdfExtracted?: boolean
  byline?: string | null
  siteName?: string | null
  excerpt?: string | null
  selectedSelector?: string
  extractionMethod?: ArticleData['extractionMethod']
  truncated: boolean
  tempFile?: string
  isImage?: boolean
  imageMimeType?: string
  imageSize?: number
  status?: number
  statusText?: string
  contentType?: string
  charLimited?: boolean
  maxChars?: number
  originalChars?: number
  cloudflareBypassed?: boolean
  contentLength?: number
  cached?: boolean
  cacheAgeMs?: number
}

export type TextToolContent = { type: 'text'; text: string }
export type ImageToolContent = {
  type: 'image'
  data: string
  mimeType: string
}
export type FetchToolContent = Array<TextToolContent | ImageToolContent>
export type FetchProgressUpdate = { content: TextToolContent[] }
export type FetchProgressHandler = (update: FetchProgressUpdate) => void

export type GuardedFetchResponse = {
  url: string
  status: number
  statusText: string
  headers: Headers
  ok: boolean
  bodyBuffer: Buffer
}

export type GuardedRequester = (
  url: URL,
  signal: AbortSignal,
  userAgent: string,
) => Promise<GuardedFetchResponse>
