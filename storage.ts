import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { SearchResultItem } from './providers/index.ts'
import {
  DEFAULT_WEB_TOOLS_CACHE_DIR,
  FALLBACK_WEB_TOOLS_CACHE_DIR,
  getCacheDirCandidates,
  resolveWritableCacheDir,
} from './utils/writable-dir.ts'

const RESPONSES_DIR_NAME = 'responses'
const MAX_STORED_RESPONSES = 200
const DEFAULT_MAX_STORED_RESPONSE_AGE_MS = 14 * 24 * 60 * 60 * 1000

export const DEFAULT_CONTENT_SLICE_LIMIT = 200
export const MAX_CONTENT_SLICE_LIMIT = 1000

const STORAGE_ROOT_CACHE = new Map<
  string,
  ReturnType<typeof resolveWritableCacheDir>
>()

export type StoredSearchAttempt = {
  provider: string
  ok: boolean
  durationMs: number
  count?: number
  error?: string
}

export type StoredSearchQuery = {
  query: string
  provider: string
  count: number
  results: SearchResultItem[]
  attempts: StoredSearchAttempt[]
  fallbackUsed: boolean
  durationMs: number
  messageText?: string
}

export type StoredSearchResponse = {
  kind: 'search'
  responseId: string
  createdAt: string
  requestedProvider: string
  queries: string[]
  queryResults: StoredSearchQuery[]
  messageText?: string
  lineCount?: number
  charCount?: number
  resultCount?: number
  sourceTool?: string
}

export type StoredFetchResponse = {
  kind: 'fetch'
  responseId: string
  createdAt: string
  requestUrl: string
  finalUrl: string
  format: string
  title?: string | null
  selectedSelector?: string
  contentType?: string
  messageText: string
  lineCount?: number
  charCount?: number
  contentHash?: string
  sourceTool?: string
  cacheHit?: boolean
  fallbackUsed?: string
}

export type StoredWebResponse = StoredSearchResponse | StoredFetchResponse

export type StoredWebResponseInput =
  | Omit<StoredSearchResponse, 'responseId' | 'createdAt'>
  | Omit<StoredFetchResponse, 'responseId' | 'createdAt'>

export type StoredContentSlice = {
  text: string
  offset: number
  limit: number
  returnedLines: number
  totalLines: number
  hasMore: boolean
  nextOffset?: number
}

function getXdgStorageRoot(env: NodeJS.ProcessEnv = process.env) {
  if (!env.XDG_CACHE_HOME?.trim()) return undefined
  return path.join(path.resolve(env.XDG_CACHE_HOME), 'pi', 'web-tools')
}

function getStorageRootCacheKey(env: NodeJS.ProcessEnv) {
  return [
    env.PI_WEB_TOOLS_STORAGE_DIR || '',
    env.XDG_CACHE_HOME || '',
  ].join('\u0000')
}

export function getStorageRootCandidates(env: NodeJS.ProcessEnv = process.env) {
  return getCacheDirCandidates({
    explicitDir: env.PI_WEB_TOOLS_STORAGE_DIR,
    defaultDir: DEFAULT_WEB_TOOLS_CACHE_DIR,
    xdgDir: getXdgStorageRoot(env),
    fallbackDir: FALLBACK_WEB_TOOLS_CACHE_DIR,
  })
}

export function resolveStorageRoot(env: NodeJS.ProcessEnv = process.env) {
  const cacheKey = getStorageRootCacheKey(env)
  const cached = STORAGE_ROOT_CACHE.get(cacheKey)
  if (cached) return cached

  const resolved = resolveWritableCacheDir({
    explicitDir: env.PI_WEB_TOOLS_STORAGE_DIR,
    defaultDir: DEFAULT_WEB_TOOLS_CACHE_DIR,
    xdgDir: getXdgStorageRoot(env),
    fallbackDir: FALLBACK_WEB_TOOLS_CACHE_DIR,
  })
  STORAGE_ROOT_CACHE.set(cacheKey, resolved)
  return resolved
}

function getResponsesDirForRoot(root: string) {
  return path.join(root, RESPONSES_DIR_NAME)
}

function getResponsesDir(env: NodeJS.ProcessEnv = process.env) {
  return getResponsesDirForRoot(resolveStorageRoot(env).dir)
}

function ensureResponsesDir(env: NodeJS.ProcessEnv = process.env) {
  const dir = getResponsesDir(env)
  mkdirSync(dir, { recursive: true })
  return dir
}

function assertSafeResponseId(responseId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(responseId)) {
    throw new Error(`Invalid responseId: ${responseId}`)
  }
}

function getResponsePathForRoot(responseId: string, root: string) {
  assertSafeResponseId(responseId)
  return path.join(getResponsesDirForRoot(root), `${responseId}.json`)
}

function getExistingResponsePath(
  responseId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  for (const root of getStorageRootCandidates(env)) {
    const filePath = getResponsePathForRoot(responseId, root)
    if (existsSync(filePath)) return filePath
  }

  return undefined
}

function resolveMaxStoredResponseAgeMs(env: NodeJS.ProcessEnv = process.env) {
  const configured = Number.parseInt(
    env.PI_WEB_TOOLS_STORAGE_MAX_AGE_MS || '',
    10,
  )
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MAX_STORED_RESPONSE_AGE_MS
  }
  return configured
}

function pruneStoredResponsesForRoot(
  root: string,
  options: {
    now?: number
    maxAgeMs?: number
  } = {},
) {
  const dir = getResponsesDirForRoot(root)
  if (!existsSync(dir)) return

  const now = options.now ?? Date.now()
  const maxAgeMs =
    options.maxAgeMs ?? resolveMaxStoredResponseAgeMs(process.env)

  const entries = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const filePath = path.join(dir, file)
      const stats = statSync(filePath)
      return {
        filePath,
        mtimeMs: stats.mtimeMs,
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)

  const surviving: typeof entries = []
  for (const entry of entries) {
    if (now - entry.mtimeMs > maxAgeMs) {
      rmSync(entry.filePath, { force: true })
    } else {
      surviving.push(entry)
    }
  }

  for (const entry of surviving.slice(MAX_STORED_RESPONSES)) {
    rmSync(entry.filePath, { force: true })
  }
}

function pruneStoredResponses(env: NodeJS.ProcessEnv = process.env) {
  pruneStoredResponsesForRoot(resolveStorageRoot(env).dir, {
    maxAgeMs: resolveMaxStoredResponseAgeMs(env),
  })
}

export function createResponseId() {
  return `wt_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

function countLines(text: string) {
  if (!text) return 0
  return text.replace(/\r\n/g, '\n').split('\n').length
}

function hashContent(text: string) {
  let hash = 5381
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function enrichStoredResponse(input: StoredWebResponseInput): StoredWebResponseInput {
  if (input.kind === 'fetch') {
    return {
      ...input,
      lineCount: input.lineCount ?? countLines(input.messageText),
      charCount: input.charCount ?? input.messageText.length,
      contentHash: input.contentHash ?? hashContent(input.messageText),
    }
  }

  const messageText = input.messageText
  const resultCount = input.queryResults.reduce((total, item) => total + item.count, 0)

  return {
    ...input,
    lineCount: input.lineCount ?? (messageText ? countLines(messageText) : undefined),
    charCount: input.charCount ?? messageText?.length,
    resultCount: input.resultCount ?? resultCount,
  }
}

export function storeWebResponse(
  input: StoredWebResponseInput,
  env: NodeJS.ProcessEnv = process.env,
): StoredWebResponse {
  const responseId = createResponseId()
  const stored: StoredWebResponse = {
    ...enrichStoredResponse(input),
    responseId,
    createdAt: new Date().toISOString(),
  }

  const dir = ensureResponsesDir(env)
  writeFileSync(
    path.join(dir, `${responseId}.json`),
    JSON.stringify(stored, null, 2),
    'utf8',
  )
  pruneStoredResponses(env)
  return stored
}

export function tryStoreWebResponse(
  input: StoredWebResponseInput,
  env: NodeJS.ProcessEnv = process.env,
) {
  try {
    return storeWebResponse(input, env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[web-tools] Failed to persist response: ${message}`)
    return undefined
  }
}

export function getStoredWebResponse(
  responseId: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredWebResponse | undefined {
  const filePath = getExistingResponsePath(responseId, env)
  if (!filePath) return undefined

  return JSON.parse(readFileSync(filePath, 'utf8')) as StoredWebResponse
}

export function listStoredWebResponses(
  options: { limit?: number; kind?: StoredWebResponse['kind'] } = {},
  env: NodeJS.ProcessEnv = process.env,
): StoredWebResponse[] {
  const limit = options.limit ?? 20
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid limit: ${limit}`)
  }

  const entries: Array<{ response: StoredWebResponse; mtimeMs: number }> = []
  for (const root of getStorageRootCandidates(env)) {
    const dir = getResponsesDirForRoot(root)
    if (!existsSync(dir)) continue

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const filePath = path.join(dir, file)
      const response = JSON.parse(readFileSync(filePath, 'utf8')) as StoredWebResponse
      if (options.kind && response.kind !== options.kind) continue
      entries.push({ response, mtimeMs: statSync(filePath).mtimeMs })
    }
  }

  return entries
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.response)
}

export function sliceStoredText(
  text: string,
  offset = 1,
  limit = DEFAULT_CONTENT_SLICE_LIMIT,
): StoredContentSlice {
  if (!Number.isInteger(offset) || offset <= 0) {
    throw new Error(`Invalid offset: ${offset}`)
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid limit: ${limit}`)
  }
  if (limit > MAX_CONTENT_SLICE_LIMIT) {
    throw new Error(
      `Limit too large: ${limit}. Maximum supported limit is ${MAX_CONTENT_SLICE_LIMIT}`,
    )
  }

  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.length ? normalized.split('\n') : []
  const totalLines = lines.length

  if (totalLines === 0) {
    return {
      text: '',
      offset,
      limit,
      returnedLines: 0,
      totalLines: 0,
      hasMore: false,
    }
  }

  if (offset > totalLines) {
    throw new Error(
      `Offset ${offset} is beyond stored content length (${totalLines} lines)`,
    )
  }

  const startIndex = offset - 1
  const selected = lines.slice(startIndex, startIndex + limit)
  const returnedLines = selected.length
  const nextOffset = offset + returnedLines

  return {
    text: selected.join('\n'),
    offset,
    limit,
    returnedLines,
    totalLines,
    hasMore: nextOffset <= totalLines,
    nextOffset: nextOffset <= totalLines ? nextOffset : undefined,
  }
}
