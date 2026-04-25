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

export type FetchRequestOptions = {
  headers?: Record<string, string>
  proxy?: string
}

export type ParsedFetchParams = {
  url: string
  parsedUrl: URL
  requestedFormat?: FetchOutputFormat
  selector?: string
  timeoutMs: number
  maxChars?: number
  refresh: boolean
  headers?: Record<string, string>
  proxy?: string
}

export type ParsedBatchFetchParams = {
  requests: ParsedFetchParams[]
  concurrency: number
}

export type FetchResponseClassification = {
  finalUrl: string
  status: number
  statusText: string
  contentType: string
  contentDisposition: string
  contentLength?: number
  mimeType: string
  isHtml: boolean
  isJson: boolean
  isPdf: boolean
  isText: boolean
  isImage: boolean
  isAttachment: boolean
  isBinary: boolean
  format: FetchOutputFormat
}

export type ExtractedFetchContent = {
  content: string
  article?: ArticleData
  jinaFallbackUsed: boolean
  pdfExtracted: boolean
}

export type FetchErrorCode =
  | 'invalid_request'
  | 'network_error'
  | 'http_error'
  | 'response_too_large'
  | 'fallback_error'
  | 'processing_error'
  | 'timeout'

export type FetchErrorPhase =
  | 'resolve'
  | 'network'
  | 'response'
  | 'download'
  | 'extract'
  | 'process'
  | 'unknown'

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
  isFile?: boolean
  filePath?: string
  fileName?: string
  fileSize?: number
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
  errorCode?: FetchErrorCode
  errorPhase?: FetchErrorPhase
  retryable?: boolean
}

export type BatchFetchItemSummary = {
  index: number
  url: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress?: number
  title?: string | null
  format?: string
  responseId?: string
  statusCode?: number
  error?: string
  errorCode?: FetchErrorCode
  errorPhase?: FetchErrorPhase
  retryable?: boolean
}

export type BatchFetchDetails = {
  total: number
  completed: number
  succeeded: number
  failed: number
  concurrency: number
  items: BatchFetchItemSummary[]
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
  downloadedFilePath?: string
  downloadedFileSize?: number
}

export type GuardedRequester = (
  url: URL,
  signal: AbortSignal,
  userAgent: string,
  options?: FetchRequestOptions,
) => Promise<GuardedFetchResponse>
